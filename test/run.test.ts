import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScenario, speakableProblems } from '../src/run.js';
import { loadScenario, parseScenario } from '../src/scenario.js';
import { ScriptedModel, reply, rota, use } from './helpers.js';

const example = (name: string) => loadScenario(`examples/house-rota/scenarios/${name}.yaml`);
const rotaForScenarios = () =>
  rota({ storyTimeHeader: 'X-Story-Time', hookSecret: 'example-secret', timezone: 'Africa/Lagos' });

test('the fuel gauge scenario passes against the example add-on, with no model', async () => {
  const s = await rotaForScenarios();
  try {
    const r = await runScenario(example('fuel-gauge'), { url: s.url });
    assert.ok(
      r.ok,
      JSON.stringify(
        r.steps.filter((x) => !x.ok),
        null,
        2,
      ),
    );
    assert.equal(r.model, 'no model');
    assert.equal(r.steps.length, 8);
    assert.equal(r.steps[0]?.status, 401);
  } finally {
    await s.close();
  }
});

test('the recorded scenarios replay with no model and no credentials', async () => {
  for (const name of ['nobody-has-the-fuel', 'taken-is-taken']) {
    const s = await rotaForScenarios();
    try {
      const r = await runScenario(example(name), { url: s.url, mode: 'replay' });
      assert.ok(
        r.ok,
        `${name}: ${JSON.stringify(
          r.steps.filter((x) => !x.ok),
          null,
          2,
        )}`,
      );
      assert.match(r.model, /^replay of /);
      assert.deepEqual(r.notes, []);
    } finally {
      await s.close();
    }
  }
});

const scenario = (url: string, steps: string, extra = '') =>
  parseScenario(
    `server: ${url}
members:
  ada: local-ada
  tunde: local-tunde
clock: { start: 2026-10-14T06:10:00Z }
host: { timezone: Africa/Lagos, maxSteps: 2 }
${extra}
steps:
${steps}`,
    'inline.yaml',
  );

test('each member is told who they are and what time it is', async () => {
  const s = await rota();
  const model = new ScriptedModel([reply('Morning, Ada.')]);
  try {
    const r = await runScenario(scenario(s.url, '  - say: hello\n    as: ada'), {
      provider: model,
    });
    assert.ok(r.ok);
    assert.match(model.systems[0] ?? '', /You are speaking with Ada\./);
    assert.match(
      model.systems[0] ?? '',
      /Wednesday, October 14, 2026 at 7:10 AM \(Africa\/Lagos\)/,
    );
    assert.deepEqual(
      model.tools[0]?.map((t) => t.name),
      ['list_chores', 'take_chore', 'mark_done'],
    );
  } finally {
    await s.close();
  }
});

test('the checks catch a wrong tool, a wrong reply, and a reply that cannot be read aloud', async () => {
  const s = await rota();
  const model = new ScriptedModel([
    use('take_chore', { chore: 'fuel' }),
    reply('**Done!** See https://example.com 🎉'),
  ]);
  try {
    const r = await runScenario(
      scenario(
        s.url,
        `  - say: who has the fuel?
    as: ada
    expect: { called: [list_chores], notCalled: [take_chore], says: [nobody], error: false }`,
        'always: { speakable: true, maxWords: 3 }',
      ),
      { provider: model },
    );
    assert.ok(!r.ok);
    const failed = r.steps[0]!.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.deepEqual(failed, [
      'calls list_chores',
      'never calls take_chore',
      'says "nobody"',
      'speakable',
      'at most 3 words',
    ]);
  } finally {
    await s.close();
  }
});

test('a model that never stops calling tools fails the step, and bail skips the rest', async () => {
  const s = await rota();
  const model = new ScriptedModel([use('list_chores'), use('list_chores'), use('list_chores')]);
  try {
    const r = await runScenario(
      scenario(s.url, '  - say: hi\n    as: ada\n  - call: list_chores\n    as: tunde'),
      { provider: model, bail: true },
    );
    assert.ok(!r.ok);
    assert.match(
      r.steps[0]!.checks.find((c) => c.name === 'finishes')?.detail ?? '',
      /still calling tools after 3 model turns/,
    );
    assert.equal(r.steps[1]?.skipped, true);
  } finally {
    await s.close();
  }
});

test('a direct call that fails is a failure unless the scenario expects it', async () => {
  const s = await rota();
  try {
    const r = await runScenario(
      scenario(
        s.url,
        `  - call: take_chore
    as: ada
    args: { chore: bins }
  - call: take_chore
    as: ada
    args: { chore: bins }
    expect: { error: true, result: 'Tunde already has the bins' }`,
      ),
    );
    assert.equal(r.steps[0]?.ok, false);
    assert.equal(r.steps[1]?.ok, true);
  } finally {
    await s.close();
  }
});

test('a refused credential is reported on the step, not thrown', async () => {
  const s = await rota();
  try {
    const sc = scenario(s.url, '  - call: list_chores\n    as: ada');
    sc.members['ada']!.token = 'not-a-member';
    const r = await runScenario(sc);
    assert.ok(!r.ok);
    assert.match(r.steps[0]?.error ?? '', /could not connect to .* as Ada/);
  } finally {
    await s.close();
  }
});

test('speakable: plain sentences pass, markdown, links and emoji do not', () => {
  assert.deepEqual(speakableProblems('Ada has the fuel. Tunde has the bins.'), []);
  assert.equal(speakableProblems('- Ada: fuel\n- Tunde: bins').length, 1);
  assert.equal(speakableProblems('Go to www.example.com').length, 1);
  assert.equal(speakableProblems('Done 👍').length, 1);
});
