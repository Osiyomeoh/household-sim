import { createHmac, randomUUID } from 'node:crypto';
import { resolveValue, type Webhook } from './scenario.js';

/**
 * A simulated device: something in the house that reports by webhook, such as a doorbell,
 * a fuel gauge or a water-tank sensor. It sends what the real device's cloud would send,
 * signed the way the server expects, so the server's own checks run for real.
 */

export interface DeviceResult {
  status: number;
  body: string;
  ms: number;
}

/** `{{now}}` is the story time, `{{uuid}}` a fresh id; anything else is left as written. */
export function fill(value: unknown, vars: { now: Date }): unknown {
  if (typeof value === 'string')
    return value.replace(/\{\{\s*(now|uuid)\s*\}\}/g, (_, name: string) =>
      name === 'now' ? vars.now.toISOString() : randomUUID(),
    );
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

/** HMAC-SHA256 of the exact bytes sent, as most device clouds sign their webhooks. */
export function sign(body: string, secret: string, encoding: 'hex' | 'base64'): string {
  return createHmac('sha256', secret).update(body).digest(encoding);
}

export async function sendWebhook(
  hook: Webhook,
  opts: { base: string; now: Date; headers?: Record<string, string> },
): Promise<DeviceResult> {
  const url = new URL(hook.url, opts.base);
  const filled = fill(hook.body, { now: opts.now });
  const body = typeof filled === 'string' ? filled : JSON.stringify(filled);
  const headers: Record<string, string> = {
    'content-type': typeof filled === 'string' ? 'text/plain' : 'application/json',
    ...opts.headers,
  };
  for (const [k, v] of Object.entries(hook.headers))
    headers[k] = String(fill(resolveValue(v, `webhook header ${k}`), { now: opts.now }));
  if (hook.sign) {
    const secret = resolveValue(hook.sign.secret, 'webhook sign.secret');
    headers[hook.sign.header] = hook.sign.prefix + sign(body, secret, hook.sign.encoding);
  }
  const t = Date.now();
  const res = await fetch(url, {
    method: hook.method,
    headers,
    ...(hook.method === 'GET' || hook.method === 'HEAD' ? {} : { body }),
  });
  return { status: res.status, body: await res.text(), ms: Date.now() - t };
}
