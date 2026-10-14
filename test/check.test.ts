import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkServer, lintTools } from '../src/check.js';
import { rota } from './helpers.js';

const good = {
  name: 'list_chores',
  description: 'List the chores: who has each one and which are done or need someone.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
};

test('a well described tool has nothing to report', () => {
  assert.deepEqual(lintTools([good]), []);
});

test('the lint finds what a model would trip on', () => {
  const f = lintTools([
    good,
    { ...good },
    { name: 'bad name!', description: 'x'.repeat(50), inputSchema: { type: 'object' } },
    { name: 'house.rota.take', description: 'x'.repeat(50), inputSchema: { type: 'object' } },
    {
      name: 'thin',
      description: 'Takes a chore.',
      inputSchema: {
        type: 'object',
        properties: { c: { type: 'string' } },
        required: ['c', 'who'],
      },
    },
    { name: 'blank', inputSchema: { type: 'string' } },
  ]);
  const has = (level: string, where: string, re: RegExp) =>
    assert.ok(
      f.some((x) => x.level === level && x.where === where && re.test(x.message)),
      `expected ${level} on ${where} matching ${re}\n${JSON.stringify(f, null, 2)}`,
    );
  has('error', 'tool list_chores', /used twice/);
  has('error', 'tool bad name!', /characters MCP does not allow/);
  has('warn', 'tool house.rota.take', /some model APIs refuse this name/);
  has('warn', 'tool thin', /14-character description/);
  has('error', 'tool thin', /"who" is required but is not one of the properties/);
  has('warn', 'tool thin', /arguments with no description: c/);
  has('error', 'tool blank', /no description/);
  has('error', 'tool blank', /type "object"/);
  has('info', 'tool thin', /readOnlyHint/);
});

test('check: a server behind sign-in says how to sign in', async () => {
  const s = await rota();
  try {
    const r = await checkServer(s.url);
    assert.equal(r.status, 401);
    assert.ok(r.ok, 'a 401 with a challenge is not an error');
    assert.ok(
      r.findings.some((f) => f.where === 'auth' && /Bearer realm="house-rota"/.test(f.message)),
    );
    const refused = await checkServer(s.url, { token: 'nobody' });
    assert.ok(!refused.ok);
    assert.ok(
      refused.findings.some(
        (f) => f.level === 'error' && /token given was refused/.test(f.message),
      ),
    );
  } finally {
    await s.close();
  }
});

test('check: the example add-on passes with no warnings', async () => {
  const s = await rota();
  try {
    const r = await checkServer(s.url, { token: 'local-ada' });
    assert.ok(r.ok, JSON.stringify(r.findings));
    assert.equal(r.tools, 3);
    assert.equal(r.resources, 1);
    assert.equal(r.stateless, true);
    assert.deepEqual(r.server, { name: 'house-rota', version: '0.1.0' });
    assert.equal(
      r.findings.filter((f) => f.level !== 'info').length,
      0,
      JSON.stringify(r.findings),
    );
    const old = await checkServer(s.url, { token: 'local-ada', minProtocol: '2099-01-01' });
    assert.ok(!old.ok);
  } finally {
    await s.close();
  }
});

test('check: nothing listening is an error, not a crash', async () => {
  const r = await checkServer('http://127.0.0.1:9/mcp');
  assert.ok(!r.ok);
  assert.match(r.findings[0]?.message ?? '', /nothing answered/);
});
