import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';

/**
 * A scenario: one household, the people in it, and what happens to them, in order.
 *
 * Scenarios are YAML so they read like the story they test. Everything is checked on load,
 * so a typo in a member's name fails before any model is called or any server is started.
 */

export class ScenarioError extends Error {}

/** A substring (case-insensitive) or a `/regex/flags`. */
export interface Matcher {
  readonly source: string;
  test(text: string): boolean;
}

export interface Expect {
  /** Each of these tools was called during the step (say) or is the tool called (call). */
  called?: string[];
  /** None of these tools was called. */
  notCalled?: string[];
  /** `called` must happen in this order. */
  inOrder?: boolean;
  /** The spoken reply matches every one of these. */
  says?: Matcher[];
  /** The spoken reply matches none of these. */
  neverSays?: Matcher[];
  /** Some tool result in the step matches each of these. */
  result?: Matcher[];
  /** true: a tool call in the step must fail. false: none may. Direct calls default to false. */
  error?: boolean;
  /** The reply can be read aloud: no markdown, links or emoji, and at most `maxWords` words. */
  speakable?: boolean;
  maxWords?: number;
  /** The whole step, model and tools together, finishes within this many milliseconds. */
  maxMs?: number;
  /** A read resource matches every one of these. */
  matches?: Matcher[];
  /** A device webhook answers with one of these HTTP statuses. Defaults to any 2xx. */
  status?: number[];
}

export interface Member {
  id: string;
  /** What the assistant calls them. */
  name: string;
  /** Bearer token. Absent until a setup command provides it, or for a server without auth. */
  token?: string;
}

export interface Webhook {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  sign?: { header: string; secret: string; encoding: 'hex' | 'base64'; prefix: string };
}

interface StepBase {
  /** 1-based, as a person counts them in the file. */
  index: number;
  expect: Expect;
}

export type Step =
  | (StepBase & { kind: 'say'; as: string; text: string })
  | (StepBase & { kind: 'call'; as: string; tool: string; args: Record<string, unknown> })
  | (StepBase & { kind: 'read'; as: string; uri: string })
  | (StepBase & { kind: 'device'; name: string; webhook: Webhook })
  | (StepBase & { kind: 'clock'; to: string });

export interface Scenario {
  name: string;
  file: string;
  server: {
    url: string;
    /** A command that starts the server; the runner stops it afterwards. */
    start?: string;
    /** A URL that answers once the started server is ready. */
    ready?: string;
    env: Record<string, string>;
  };
  /** A command whose stdout is JSON mapping member ids to tokens, run after the server starts. */
  setup?: string;
  members: Record<string, Member>;
  host: { model?: string; prompt: string; timezone: string; maxSteps: number };
  clock?: { start: string; header?: string };
  /** Checked on every spoken reply in the scenario. */
  always: Expect;
  steps: Step[];
}

const STEP_KINDS = ['say', 'call', 'read', 'device', 'clock'] as const;
const EXPECT_KEYS: Record<Step['kind'] | 'always', readonly string[]> = {
  say: [
    'called',
    'notCalled',
    'inOrder',
    'says',
    'neverSays',
    'result',
    'error',
    'speakable',
    'maxWords',
    'maxMs',
  ],
  call: ['result', 'error', 'maxMs'],
  read: ['matches'],
  device: ['status'],
  clock: [],
  always: ['notCalled', 'neverSays', 'speakable', 'maxWords', 'maxMs'],
};

export function matcher(raw: unknown, where: string): Matcher {
  if (typeof raw !== 'string' || raw === '')
    throw new ScenarioError(`${where}: expected text or a /regex/, got ${JSON.stringify(raw)}`);
  const re = /^\/(.+)\/([dimsuy]*)$/s.exec(raw);
  if (re) {
    let rx: RegExp;
    try {
      rx = new RegExp(re[1]!, re[2]!);
    } catch (err) {
      throw new ScenarioError(`${where}: ${(err as Error).message}`);
    }
    return { source: raw, test: (t) => rx.test(t) };
  }
  const needle = raw.toLowerCase();
  return { source: JSON.stringify(raw), test: (t) => t.toLowerCase().includes(needle) };
}

/** `env:NAME` reads the environment, so tokens and secrets stay out of scenario files. */
export function resolveValue(raw: string, where: string): string {
  if (!raw.startsWith('env:')) return raw;
  const name = raw.slice(4);
  const value = process.env[name];
  if (value === undefined || value === '')
    throw new ScenarioError(`${where}: the environment variable ${name} is not set`);
  return value;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function text(v: unknown, where: string): string {
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number') return String(v);
  throw new ScenarioError(`${where}: expected text`);
}

function names(v: unknown, where: string): string[] {
  return list(v).map((x, i) => text(x, `${where}[${i}]`));
}

function parseExpect(raw: unknown, kind: Step['kind'] | 'always', where: string): Expect {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new ScenarioError(`${where}: expected a map of checks`);
  const allowed = EXPECT_KEYS[kind];
  for (const key of Object.keys(raw))
    if (!allowed.includes(key))
      throw new ScenarioError(
        allowed.length
          ? `${where}: "${key}" is not a check for a ${kind} step. Use one of: ${allowed.join(', ')}`
          : `${where}: a ${kind} step takes no checks`,
      );
  const out: Expect = {};
  const matchers = (key: string) =>
    list(raw[key]).map((m, i) => matcher(m, `${where}.${key}[${i}]`));
  if ('called' in raw) out.called = names(raw['called'], `${where}.called`);
  if ('notCalled' in raw) out.notCalled = names(raw['notCalled'], `${where}.notCalled`);
  if ('inOrder' in raw) out.inOrder = raw['inOrder'] === true;
  if ('says' in raw) out.says = matchers('says');
  if ('neverSays' in raw) out.neverSays = matchers('neverSays');
  if ('result' in raw) out.result = matchers('result');
  if ('matches' in raw) out.matches = matchers('matches');
  if ('error' in raw) {
    if (typeof raw['error'] !== 'boolean')
      throw new ScenarioError(`${where}.error: expected true or false`);
    out.error = raw['error'];
  }
  if ('speakable' in raw) out.speakable = raw['speakable'] === true;
  for (const key of ['maxWords', 'maxMs'] as const)
    if (key in raw) {
      const n = raw[key];
      if (typeof n !== 'number' || !(n > 0))
        throw new ScenarioError(`${where}.${key}: expected a positive number`);
      out[key] = n;
    }
  if ('status' in raw)
    out.status = list(raw['status']).map((s, i) => {
      if (typeof s !== 'number' || !Number.isInteger(s))
        throw new ScenarioError(`${where}.status[${i}]: expected an HTTP status code`);
      return s;
    });
  return out;
}

function parseWebhook(raw: unknown, where: string): Webhook {
  if (!isRecord(raw)) throw new ScenarioError(`${where}: expected a webhook with a url and body`);
  const hook: Webhook = {
    url: text(raw['url'], `${where}.url`),
    method: typeof raw['method'] === 'string' ? raw['method'].toUpperCase() : 'POST',
    headers: {},
    body: raw['body'] ?? {},
  };
  if (raw['headers'] !== undefined) {
    if (!isRecord(raw['headers'])) throw new ScenarioError(`${where}.headers: expected a map`);
    for (const [k, v] of Object.entries(raw['headers']))
      hook.headers[k] = text(v, `${where}.headers.${k}`);
  }
  if (raw['sign'] !== undefined) {
    const s = raw['sign'];
    if (!isRecord(s)) throw new ScenarioError(`${where}.sign: expected a map`);
    const encoding = s['encoding'] ?? 'hex';
    if (encoding !== 'hex' && encoding !== 'base64')
      throw new ScenarioError(`${where}.sign.encoding: expected hex or base64`);
    hook.sign = {
      header: typeof s['header'] === 'string' ? s['header'] : 'X-Signature',
      // Kept as written; env: references resolve when the step runs, not when the file loads.
      secret: text(s['secret'], `${where}.sign.secret`),
      encoding,
      prefix: typeof s['prefix'] === 'string' ? s['prefix'] : '',
    };
  }
  return hook;
}

function parseStep(raw: unknown, index: number, members: Record<string, Member>): Step {
  const where = `step ${index}`;
  if (!isRecord(raw)) throw new ScenarioError(`${where}: expected a map`);
  const kinds = STEP_KINDS.filter((k) => k in raw);
  if (kinds.length !== 1)
    throw new ScenarioError(
      `${where}: a step is exactly one of ${STEP_KINDS.join(', ')}` +
        (kinds.length ? ` (this one has ${kinds.join(' and ')})` : ''),
    );
  const kind = kinds[0]!;
  const expect = parseExpect(raw['expect'], kind, `${where}.expect`);
  const who = (): string => {
    const as = text(raw['as'], `${where}.as`);
    if (!members[as])
      throw new ScenarioError(
        `${where}: "${as}" is not a member. Members: ${Object.keys(members).join(', ')}`,
      );
    return as;
  };
  switch (kind) {
    case 'say':
      return { kind, index, expect, as: who(), text: text(raw['say'], `${where}.say`) };
    case 'call': {
      const args = raw['args'] ?? {};
      if (!isRecord(args)) throw new ScenarioError(`${where}.args: expected a map`);
      return { kind, index, expect, as: who(), tool: text(raw['call'], `${where}.call`), args };
    }
    case 'read':
      return { kind, index, expect, as: who(), uri: text(raw['read'], `${where}.read`) };
    case 'device':
      return {
        kind,
        index,
        expect,
        name: text(raw['device'], `${where}.device`),
        webhook: parseWebhook(raw['webhook'], `${where}.webhook`),
      };
    case 'clock':
      return { kind, index, expect, to: text(raw['clock'], `${where}.clock`) };
  }
}

export function parseScenario(source: string, file = 'scenario.yaml'): Scenario {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch (err) {
    throw new ScenarioError(`${file}: ${(err as Error).message}`);
  }
  if (!isRecord(doc)) throw new ScenarioError(`${file}: expected a scenario map`);
  const d = doc;
  const fail = (msg: string): never => {
    throw new ScenarioError(`${file}: ${msg}`);
  };
  const at = (fn: () => Scenario): Scenario => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ScenarioError && !err.message.startsWith(`${file}:`))
        throw new ScenarioError(`${file}: ${err.message}`);
      throw err;
    }
  };

  return at(() => {
    const server = d['server'];
    const srv = typeof server === 'string' ? { url: server } : server;
    if (!isRecord(srv)) return fail('server: give the MCP endpoint URL');
    const env: Record<string, string> = {};
    if (isRecord(srv['env']))
      for (const [k, v] of Object.entries(srv['env'])) env[k] = text(v, `server.env.${k}`);

    if (!isRecord(d['members']) || !Object.keys(d['members']).length)
      return fail('members: name at least one person in the household');
    const members: Record<string, Member> = {};
    for (const [id, m] of Object.entries(d['members'])) {
      const spec = typeof m === 'string' ? { token: m } : m === null ? {} : m;
      if (!isRecord(spec)) return fail(`members.${id}: expected a map or a token`);
      members[id] = {
        id,
        name:
          typeof spec['name'] === 'string'
            ? spec['name']
            : id.charAt(0).toUpperCase() + id.slice(1),
        ...(spec['token'] !== undefined
          ? { token: text(spec['token'], `members.${id}.token`) }
          : {}),
      };
    }

    const host = isRecord(d['host']) ? d['host'] : {};
    const maxSteps = host['maxSteps'] ?? 6;
    if (typeof maxSteps !== 'number' || maxSteps < 1)
      return fail('host.maxSteps: expected 1 or more');

    let clock: Scenario['clock'];
    if (d['clock'] !== undefined) {
      const c = typeof d['clock'] === 'string' ? { start: d['clock'] } : d['clock'];
      if (!isRecord(c)) return fail('clock: expected a start time');
      const start = text(c['start'], 'clock.start');
      if (Number.isNaN(Date.parse(start))) return fail(`clock.start: "${start}" is not a time`);
      clock = { start, ...(typeof c['header'] === 'string' ? { header: c['header'] } : {}) };
    }

    if (!Array.isArray(d['steps']) || !d['steps'].length) return fail('steps: add at least one');
    const steps = d['steps'].map((s, i) => parseStep(s, i + 1, members));

    return {
      name: typeof d['name'] === 'string' ? d['name'] : basename(file).replace(/\.ya?ml$/, ''),
      file,
      server: {
        url: text(srv['url'], 'server.url'),
        ...(typeof srv['start'] === 'string' ? { start: srv['start'] } : {}),
        ...(typeof srv['ready'] === 'string' ? { ready: srv['ready'] } : {}),
        env,
      },
      ...(typeof d['setup'] === 'string' ? { setup: d['setup'] } : {}),
      members,
      host: {
        ...(typeof host['model'] === 'string' ? { model: host['model'] } : {}),
        prompt: typeof host['prompt'] === 'string' ? host['prompt'].trim() : '',
        timezone: typeof host['timezone'] === 'string' ? host['timezone'] : 'UTC',
        maxSteps,
      },
      ...(clock ? { clock } : {}),
      always: parseExpect(d['always'], 'always', 'always'),
      steps,
    };
  });
}

export function loadScenario(file: string): Scenario {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ScenarioError(
      `${file}: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (err as Error).message}`,
    );
  }
  return parseScenario(source, file);
}
