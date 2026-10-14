import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScenarioError, matcher, parseScenario, resolveValue } from '../src/scenario.js';

const base = `
server: http://localhost:8790/mcp
members:
  ada: local-ada
  tunde: { name: Tunde Bello, token: env:TUNDE_TOKEN }
`;

test('a scenario parses into typed steps', () => {
  const s = parseScenario(
    `${base}
clock: { start: 2026-10-14T06:00:00Z, header: X-Story-Time }
always: { speakable: true, maxWords: 40 }
steps:
  - say: Who has the bins?
    as: ada
    expect: { called: [list_chores], says: [Tunde, '/bins?/i'] }
  - call: take_chore
    as: tunde
    args: { chore: fuel }
    expect: { error: true }
  - read: rota://week
    as: ada
  - device: gauge
    webhook: { url: /hooks/fuel, body: { level: 18 }, sign: { secret: env:HOOK } }
    expect: { status: [200, 202] }
  - clock: +2h
`,
    'demo.yaml',
  );
  assert.equal(s.name, 'demo');
  assert.equal(s.server.url, 'http://localhost:8790/mcp');
  assert.equal(s.members['tunde']?.name, 'Tunde Bello');
  assert.equal(s.members['ada']?.name, 'Ada');
  assert.equal(s.members['ada']?.token, 'local-ada');
  assert.deepEqual(
    s.steps.map((x) => x.kind),
    ['say', 'call', 'read', 'device', 'clock'],
  );
  assert.equal(s.always.maxWords, 40);
  assert.equal(s.host.maxSteps, 6);
  assert.equal(s.host.timezone, 'UTC');
  const device = s.steps[3]!;
  assert.ok(device.kind === 'device');
  assert.deepEqual(device.webhook.sign, {
    header: 'X-Signature',
    secret: 'env:HOOK',
    encoding: 'hex',
    prefix: '',
  });
  assert.equal(device.webhook.method, 'POST');
});

test('mistakes are found on load, with where they are', () => {
  const bad = (steps: string, re: RegExp) =>
    assert.throws(
      () => parseScenario(`${base}steps:\n${steps}`, 'x.yaml'),
      (e: unknown) => {
        assert.ok(e instanceof ScenarioError);
        assert.match(e.message, re);
        assert.match(e.message, /^x\.yaml: /);
        return true;
      },
    );
  bad('  - say: hi\n    as: grandma', /step 1: "grandma" is not a member\. Members: ada, tunde/);
  bad('  - say: hi\n    call: x\n    as: ada', /exactly one of .* \(this one has say and call\)/);
  bad(
    '  - say: hi\n    as: ada\n    expect: { matches: [x] }',
    /"matches" is not a check for a say step/,
  );
  bad('  - clock: +1h\n    expect: { says: [x] }', /a clock step takes no checks/);
  bad('  - say: hi\n    as: ada\n    expect: { says: ["/(/"] }', /says\[0\]/);
  bad('  - call: x\n    as: ada\n    expect: { error: maybe }', /error: expected true or false/);
  assert.throws(
    () => parseScenario('members: {}\nsteps: []', 'y.yaml'),
    /server: give the MCP endpoint/,
  );
  assert.throws(() => parseScenario(`${base}steps: []`), /steps: add at least one/);
});

test('matchers: text is a case-insensitive substring, /x/ is a regex', () => {
  assert.ok(matcher('ada HAS', 'm').test('Ada has the fuel'));
  assert.ok(!matcher('Tunde', 'm').test('Ada has the fuel'));
  assert.ok(matcher('/^Ada\\b/', 'm').test('Ada has it'));
  assert.ok(!matcher('/^ada/', 'm').test('Ada has it'));
  assert.ok(matcher('/^ada/i', 'm').test('Ada has it'));
});

test('env: values come from the environment and fail clearly when unset', () => {
  process.env['HSIM_TEST_TOKEN'] = 'secret-value';
  assert.equal(resolveValue('env:HSIM_TEST_TOKEN', 'members.ada.token'), 'secret-value');
  assert.equal(resolveValue('plain', 'x'), 'plain');
  delete process.env['HSIM_TEST_TOKEN'];
  assert.throws(
    () => resolveValue('env:HSIM_TEST_TOKEN', 'members.ada.token'),
    /HSIM_TEST_TOKEN is not set/,
  );
});
