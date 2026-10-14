import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

/**
 * A quick look at an MCP server the way a voice host first sees it: does it answer, which
 * protocol does it speak, how does it ask for credentials, and will a model be able to use
 * its tools from their names, descriptions and schemas alone.
 *
 * It needs no model and no scenario, so it is the first thing to run against a new server.
 */

export type Level = 'error' | 'warn' | 'info';

export interface Finding {
  level: Level;
  /** The tool, resource or part of the server this is about. */
  where: string;
  message: string;
}

export interface CheckReport {
  url: string;
  ok: boolean;
  status?: number;
  protocolVersion?: string;
  server?: { name: string; version: string };
  stateless?: boolean;
  tools: number;
  resources: number;
  prompts: number;
  findings: Finding[];
  ms: number;
}

export interface CheckOptions {
  token?: string | undefined;
  /** Fail when the server negotiates an older protocol than this, e.g. 2025-06-18. */
  minProtocol?: string | undefined;
  headers?: Record<string, string>;
}

/** What the MCP spec allows in a tool name. */
const SPEC_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/** What the common model APIs (Bedrock, OpenAI, Anthropic) accept as a function name. */
const MODEL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const SHORT_DESCRIPTION = 40;
/** Roughly where a tool list starts to crowd a host's context, in estimated tokens. */
const HEAVY_TOOLS = 8_000;

interface ToolLike {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
  annotations?: Record<string, unknown> | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Problems a model would hit using these tools. Exported so a test suite can call it alone. */
export function lintTools(tools: ToolLike[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    const where = `tool ${t.name}`;
    const add = (level: Level, message: string) => out.push({ level, where, message });
    if (seen.has(t.name)) add('error', 'the name is used twice; a host can only call one of them');
    seen.add(t.name);
    if (!SPEC_NAME.test(t.name))
      add(
        'error',
        'the name has characters MCP does not allow (letters, digits, _ - . and at most 128)',
      );
    else if (!MODEL_NAME.test(t.name))
      add(
        'warn',
        'some model APIs refuse this name (they take letters, digits, _ and - only, at most 64); a host may have to rename it',
      );

    const description = t.description?.trim() ?? '';
    if (!description) add('error', 'no description: a model can only guess what this tool is for');
    else if (description.length < SHORT_DESCRIPTION)
      add(
        'warn',
        `a ${description.length}-character description gives a model little to choose by`,
      );

    const schema = t.inputSchema;
    if (!isRecord(schema) || schema['type'] !== 'object') {
      add('error', 'inputSchema must be a JSON Schema with type "object"');
    } else {
      const props = isRecord(schema['properties']) ? schema['properties'] : {};
      const required = Array.isArray(schema['required']) ? schema['required'] : [];
      for (const r of required)
        if (typeof r !== 'string' || !(r in props))
          add('error', `"${String(r)}" is required but is not one of the properties`);
      const bare = Object.entries(props)
        .filter(
          ([, p]) =>
            !isRecord(p) || typeof p['description'] !== 'string' || !p['description'].trim(),
        )
        .map(([k]) => k);
      if (bare.length)
        add(
          'warn',
          `arguments with no description: ${bare.join(', ')}. A model fills these by guessing from the name`,
        );
    }

    const a = t.annotations ?? {};
    if (a['readOnlyHint'] === undefined && a['destructiveHint'] === undefined)
      add(
        'info',
        'no readOnlyHint or destructiveHint: a host cannot tell whether to ask before calling it',
      );
  }

  const size = Math.round(
    JSON.stringify(tools.map((t) => [t.name, t.description, t.inputSchema])).length / 4,
  );
  if (size > HEAVY_TOOLS)
    out.push({
      level: 'warn',
      where: 'tools',
      message: `the tool list is about ${size} tokens; every turn sends it, which costs time and crowds out the conversation`,
    });
  return out;
}

/** Read the JSON-RPC answer from either a JSON or an event-stream response. */
async function rpcBody(res: Response): Promise<Record<string, unknown> | undefined> {
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  const candidates = type.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
    : [text];
  for (const c of candidates) {
    try {
      const parsed: unknown = JSON.parse(c);
      if (isRecord(parsed) && ('result' in parsed || 'error' in parsed)) return parsed;
    } catch {
      // Not JSON; try the next event.
    }
  }
  return undefined;
}

async function probeAuth(url: URL, res: Response, findings: Finding[]): Promise<void> {
  const add = (level: Level, message: string) => findings.push({ level, where: 'auth', message });
  const challenge = res.headers.get('www-authenticate');
  if (!challenge) {
    add(
      'error',
      'answered 401 with no WWW-Authenticate header, so a host cannot find out how to sign in (the MCP authorization spec requires one)',
    );
  } else {
    add('info', `asks for credentials: ${challenge}`);
  }
  const named = challenge ? /resource_metadata="([^"]+)"/.exec(challenge)?.[1] : undefined;
  const wellKnown = [
    named,
    new URL(`/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname}`, url)
      .href,
    new URL('/.well-known/oauth-protected-resource', url).href,
  ].filter((u): u is string => !!u);
  for (const meta of new Set(wellKnown)) {
    try {
      const r = await fetch(meta, { signal: AbortSignal.timeout(5_000) });
      if (!r.ok) continue;
      const body: unknown = await r.json();
      const servers =
        isRecord(body) && Array.isArray(body['authorization_servers'])
          ? body['authorization_servers']
          : [];
      if (servers.length)
        add('info', `protected-resource metadata at ${meta} names ${servers.join(', ')}`);
      else add('error', `${meta} has no authorization_servers, so a host cannot start sign-in`);
      return;
    } catch {
      // Try the next location.
    }
  }
  add(
    'warn',
    'no OAuth protected-resource metadata found; hosts that sign users in by OAuth will not know where to send them',
  );
}

export async function checkServer(target: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const started = Date.now();
  const url = new URL(target);
  const findings: Finding[] = [];
  const report: CheckReport = {
    url: url.href,
    ok: false,
    tools: 0,
    resources: 0,
    prompts: 0,
    findings,
    ms: 0,
  };
  const add = (level: Level, where: string, message: string) =>
    findings.push({ level, where, message });
  const done = (): CheckReport => {
    report.ok = !findings.some((f) => f.level === 'error');
    report.ms = Date.now() - started;
    return report;
  };
  const headers: Record<string, string> = {
    ...opts.headers,
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
  };

  // First, by hand, so the raw status and headers can be seen.
  let res: Response;
  const t = Date.now();
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'household-sim', version: '0.1.0' },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    add(
      'error',
      'connect',
      `nothing answered at ${url.href}: ${(err as Error).cause ?? (err as Error).message}`,
    );
    return done();
  }
  report.status = res.status;
  const initMs = Date.now() - t;
  if (res.status === 401) {
    await probeAuth(url, res, findings);
    if (!opts.token) add('info', 'connect', 'pass --token to check the tools behind sign-in');
    else add('error', 'connect', 'the token given was refused');
    return done();
  }
  if (!res.ok) {
    add(
      'error',
      'connect',
      `initialize answered ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
    return done();
  }
  const body = await rpcBody(res);
  const result = body && isRecord(body['result']) ? body['result'] : undefined;
  if (!result) {
    add(
      'error',
      'connect',
      `initialize did not return a JSON-RPC result${body?.['error'] ? `: ${JSON.stringify(body['error'])}` : ''}`,
    );
    return done();
  }
  report.stateless = !res.headers.get('mcp-session-id');
  add(
    'info',
    'transport',
    report.stateless
      ? 'no session id: each request stands alone, which suits hosts that do not keep connections open'
      : 'gives a session id: the host must keep sending it, and a restart of the server loses it',
  );
  if (initMs > 2_000)
    add('warn', 'latency', `initialize took ${initMs} ms; a voice turn has little time to spare`);

  // Then through the SDK, as a host would.
  const client = new Client({ name: 'household-sim', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  try {
    await client.connect(transport as never);
  } catch (err) {
    add('error', 'connect', `the MCP handshake failed: ${(err as Error).message}`);
    return done();
  }
  try {
    const version =
      transport.protocolVersion ??
      (typeof result['protocolVersion'] === 'string' ? result['protocolVersion'] : undefined);
    if (version) report.protocolVersion = version;
    if (opts.minProtocol && (!version || version < opts.minProtocol))
      add(
        'error',
        'protocol',
        `speaks ${version ?? 'an unknown version'}; at least ${opts.minProtocol} was asked for`,
      );
    else if (version && version !== LATEST_PROTOCOL_VERSION)
      add('info', 'protocol', `speaks ${version}; the newest is ${LATEST_PROTOCOL_VERSION}`);

    const info = client.getServerVersion();
    if (info) report.server = { name: info.name, version: info.version };
    if (!info?.name) add('warn', 'server', 'serverInfo has no name');
    const caps = client.getServerCapabilities() ?? {};
    if (client.getInstructions()) add('info', 'server', 'gives instructions to the host model');

    if (!caps.tools) {
      add('warn', 'tools', 'the server offers no tools, so a voice host has nothing to call');
    } else {
      const tools: ToolLike[] = [];
      let cursor: string | undefined;
      const tt = Date.now();
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        tools.push(...(page.tools as ToolLike[]));
        cursor = page.nextCursor;
      } while (cursor);
      const listMs = Date.now() - tt;
      report.tools = tools.length;
      if (!tools.length) add('warn', 'tools', 'tools/list is empty');
      if (listMs > 2_000) add('warn', 'latency', `tools/list took ${listMs} ms`);
      findings.push(...lintTools(tools));
    }
    if (caps.resources) report.resources = (await client.listResources()).resources.length;
    if (caps.prompts) report.prompts = (await client.listPrompts()).prompts.length;
  } catch (err) {
    add('error', 'server', (err as Error).message);
  } finally {
    await client.close().catch(() => {});
  }
  return done();
}
