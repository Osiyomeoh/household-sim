import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerProcess, runSetup } from '../src/server-process.js';

const node = (code: string) => `"${process.execPath}" -e "${code.replace(/"/g, '\\"')}"`;

test('setup tokens are read from the last line of its output', async () => {
  const tokens = await runSetup({
    command: node(`console.log('seeding'); console.log(JSON.stringify({ ada: 'a1', n: 3 }))`),
    env: {},
    cwd: process.cwd(),
  });
  assert.deepEqual(tokens, { ada: 'a1' });
  await assert.rejects(
    runSetup({ command: node('process.exit(3)'), env: {}, cwd: process.cwd() }),
    /setup exited 3/,
  );
  await assert.rejects(
    runSetup({ command: node(`console.log('done')`), env: {}, cwd: process.cwd() }),
    /must print JSON/,
  );
});

test('a server that dies on start is reported with what it printed', async () => {
  await assert.rejects(
    ServerProcess.start({
      command: node(`console.error('port in use'); process.exit(1)`),
      ready: 'http://127.0.0.1:9/health',
      env: {},
      cwd: process.cwd(),
      timeoutMs: 5_000,
    }),
    /exited \(1\) before it was ready:\nport in use/,
  );
});

test('a started server is stopped, with everything it started', async () => {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const server = await ServerProcess.start({
    command: node(
      `require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT))`,
    ),
    ready: `http://127.0.0.1:${port}/`,
    env: { PORT: String(port) },
    cwd: process.cwd(),
  });
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
  await server.stop();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});
