import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Player,
  Recorder,
  StaleCassette,
  cassettePath,
  toolsHash,
  type Cassette,
} from '../src/providers/cassette.js';
import { ScriptedModel, reply, use } from './helpers.js';

const tools = [{ name: 'list_chores', description: 'List them.', inputSchema: { type: 'object' } }];

test('cassettes live beside the scenario, or in a given folder', () => {
  assert.equal(cassettePath('a/b/fuel.yaml'), join('a/b/cassettes', 'fuel.json'));
  assert.equal(cassettePath('a/b/fuel.yml', 'rec'), join('rec', 'fuel.json'));
});

test('what is recorded plays back, turn for turn', async () => {
  const rec = new Recorder(new ScriptedModel([use('list_chores'), reply('Ada has it.')]), 'demo');
  rec.cursor.step = 2;
  rec.cursor.as = 'ada';
  const c = rec.start('system', tools);
  await c.say('who has the fuel?');
  await c.report([{ id: 't1', name: 'list_chores', text: 'Fuel: Ada has it.', isError: false }]);
  const file = join(mkdtempSync(join(tmpdir(), 'hsim-')), 'demo.json');
  rec.save(file);
  const tape = JSON.parse(readFileSync(file, 'utf8')) as Cassette;
  assert.equal(tape.turns.length, 2);
  assert.equal(tape.tools['ada'], toolsHash(tools));

  const play = Player.load(file);
  play.cursor.step = 2;
  play.cursor.as = 'ada';
  const p = play.start('system', tools);
  assert.equal((await p.say('anything'))!.toolUses[0]?.name, 'list_chores');
  assert.equal((await p.report([]))!.text, 'Ada has it.');
  assert.equal(play.leftover, 0);
  assert.deepEqual(play.notes, []);
});

const tape = (over: Partial<Cassette> = {}): Cassette => ({
  version: 1,
  scenario: 'demo',
  model: 'scripted',
  recordedAt: '2026-10-14T00:00:00Z',
  tools: { ada: toolsHash(tools) },
  turns: [
    { step: 1, as: 'ada', text: '', toolUses: [{ id: 'x', name: 'list_chores', input: {} }] },
  ],
  ...over,
});

test('a replay refuses to guess when the scenario has moved on', async () => {
  const p = new Player(tape());
  p.cursor.step = 2;
  p.cursor.as = 'ada';
  await assert.rejects(
    p.start('s', tools).say('hi'),
    (e: unknown) =>
      e instanceof StaleCassette && /not where the recording expects/.test((e as Error).message),
  );

  const q = new Player(tape());
  q.cursor.step = 1;
  q.cursor.as = 'ada';
  const c = q.start('s', tools);
  await c.say('hi');
  await assert.rejects(c.report([]), /ran out/);
});

test('a replay notices tools that changed or went away', async () => {
  const changed = [{ ...tools[0]!, description: 'List every chore, with who has it.' }];
  const p = new Player(tape());
  p.cursor.step = 1;
  p.cursor.as = 'ada';
  await p.start('s', changed).say('hi');
  assert.match(p.notes[0] ?? '', /ada's tools changed since this was recorded/);

  const gone = new Player(tape());
  gone.cursor.step = 1;
  gone.cursor.as = 'ada';
  await assert.rejects(
    gone.start('s', [{ name: 'chores', description: 'x', inputSchema: {} }]).say('hi'),
    /calls list_chores, which the server no longer offers/,
  );
});

test('a missing recording says how to make one', () => {
  assert.throws(() => Player.load('/nowhere/at/all.json'), /Run once with --record/);
});
