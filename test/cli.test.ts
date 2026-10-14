import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });

test('a broken scenario stops before anything runs, with exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hsim-'));
  const file = join(dir, 'bad.yaml');
  writeFileSync(
    file,
    'server: http://127.0.0.1:9/mcp\nmembers: { ada: x }\nsteps:\n  - say: hi\n    as: bob\n',
  );
  const r = cli('run', file);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /"bob" is not a member/);
});

test('usage mistakes exit 2', () => {
  assert.equal(cli('run').status, 2);
  assert.equal(cli('run', 'x.yaml', '--record', '--replay').status, 2);
  assert.equal(cli('frobnicate').status, 2);
  assert.equal(cli('run', 'no-such-file.yaml').status, 2);
  assert.equal(cli('--help').status, 0);
});
