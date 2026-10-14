import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fill, sendWebhook, sign } from '../src/webhook.js';

test('signatures are HMAC-SHA256 of the exact body', () => {
  const body = '{"level":18}';
  assert.equal(sign(body, 'k', 'hex'), createHmac('sha256', 'k').update(body).digest('hex'));
  assert.equal(sign(body, 'k', 'base64'), createHmac('sha256', 'k').update(body).digest('base64'));
});

test('{{now}} and {{uuid}} are filled in anywhere in the body', () => {
  const now = new Date('2026-10-14T06:10:00Z');
  const out = fill({ at: '{{now}}', list: ['{{ uuid }}', 3], keep: '{{other}}' }, { now }) as {
    at: string;
    list: [string, number];
    keep: string;
  };
  assert.equal(out.at, '2026-10-14T06:10:00.000Z');
  assert.match(out.list[0], /^[0-9a-f-]{36}$/);
  assert.equal(out.list[1], 3);
  assert.equal(out.keep, '{{other}}');
});

test('a device webhook arrives signed, relative to the server', async () => {
  let seen: { path?: string; sig?: string; body?: string; story?: string } = {};
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen = {
        path: req.url ?? '',
        sig: String(req.headers['x-hub-signature-256']),
        story: String(req.headers['x-story-time']),
        body,
      };
      res.writeHead(202).end('queued');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  process.env['HSIM_HOOK_SECRET'] = 'shh';
  try {
    const res = await sendWebhook(
      {
        url: '/hooks/door',
        method: 'POST',
        headers: {},
        body: { event: 'motion', at: '{{now}}' },
        sign: {
          header: 'X-Hub-Signature-256',
          secret: 'env:HSIM_HOOK_SECRET',
          encoding: 'hex',
          prefix: 'sha256=',
        },
      },
      {
        base: `http://127.0.0.1:${port}/mcp`,
        now: new Date('2026-10-14T06:10:00Z'),
        headers: { 'X-Story-Time': '2026-10-14T06:10:00.000Z' },
      },
    );
    assert.equal(res.status, 202);
    assert.equal(res.body, 'queued');
    assert.equal(seen.path, '/hooks/door');
    assert.equal(seen.body, '{"event":"motion","at":"2026-10-14T06:10:00.000Z"}');
    assert.equal(seen.sig, `sha256=${sign(seen.body, 'shh', 'hex')}`);
    assert.equal(seen.story, '2026-10-14T06:10:00.000Z');
  } finally {
    delete process.env['HSIM_HOOK_SECRET'];
    server.close();
  }
});
