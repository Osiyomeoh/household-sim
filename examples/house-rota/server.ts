import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * House rota: a small MCP add-on for a shared home, here to be tested by household-sim.
 *
 * Three people share three chores. Each person has their own credential, so the server
 * always knows who is speaking. A fuel gauge reports by signed webhook, and when the
 * generator runs low the fuel becomes a chore that needs someone.
 *
 * It is deliberately small, but it has the parts that go wrong in real add-ons: who is
 * asking, two people wanting the same thing, a device changing the record between turns,
 * and replies that will be read aloud.
 */

/** Local test credentials only. A real add-on signs people in. */
export const MEMBERS: Record<string, { id: string; name: string }> = {
  'local-ada': { id: 'ada', name: 'Ada' },
  'local-tunde': { id: 'tunde', name: 'Tunde' },
  'local-grandma': { id: 'grandma', name: 'Grandma' },
};
const NAMES = Object.fromEntries(Object.values(MEMBERS).map((m) => [m.id, m.name]));

interface Chore {
  id: string;
  title: string;
  aliases: string[];
  owner: string | null;
  done: { by: string; at: Date } | null;
  /** Set when a device says this cannot wait. */
  needed: { since: Date; why: string } | null;
}

function startingChores(): Chore[] {
  return [
    {
      id: 'fuel',
      title: 'generator fuel',
      aliases: ['fuel', 'diesel', 'petrol', 'generator'],
      owner: null,
      done: null,
      needed: null,
    },
    {
      id: 'bins',
      title: 'bins',
      aliases: ['bin', 'bins', 'rubbish', 'trash'],
      owner: 'tunde',
      done: null,
      needed: null,
    },
    {
      id: 'water',
      title: 'water tank',
      aliases: ['water', 'tank'],
      owner: null,
      done: null,
      needed: null,
    },
  ];
}

export interface RotaOptions {
  /** Believe this request header as the current time. For test copies only: never in a real home. */
  storyTimeHeader?: string | undefined;
  /** The fuel gauge's webhook secret. Without it the webhook is switched off. */
  hookSecret?: string | undefined;
  timezone?: string | undefined;
}

const TOOLS = [
  {
    name: 'list_chores',
    description:
      "List the household's chores: who has each one, which are done, and which need someone. Call it before answering anything about chores, because other people and the fuel gauge change them between conversations.",
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List chores', readOnlyHint: true },
  },
  {
    name: 'take_chore',
    description:
      'Give a chore to the person speaking, when they say they will do it ("I\'ll get the fuel"). If someone else already has it, this fails and says who: tell the person, and ask whether they want to take it over. Call again with takeOver true only after they say yes.',
    inputSchema: {
      type: 'object',
      properties: {
        chore: {
          type: 'string',
          description: 'The chore in their words, such as fuel, bins or water tank.',
        },
        takeOver: {
          type: 'boolean',
          description: 'True only when the person has said yes to taking it from whoever has it.',
        },
      },
      required: ['chore'],
    },
    annotations: {
      title: 'Take a chore',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: 'mark_done',
    description:
      'Record that a chore is done, when the person speaking says they did it. Anyone may mark a chore done, not only whoever had it.',
    inputSchema: {
      type: 'object',
      properties: {
        chore: {
          type: 'string',
          description: 'The chore in their words, such as fuel, bins or water tank.',
        },
      },
      required: ['chore'],
    },
    annotations: {
      title: 'Mark a chore done',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
];

export function createRota(opts: RotaOptions = {}): HttpServer {
  const chores = startingChores();
  const timezone = opts.timezone ?? 'Africa/Lagos';
  const clockTime = (at: Date) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(at);

  const now = (req: IncomingMessage): Date => {
    if (!opts.storyTimeHeader) return new Date();
    const raw = req.headers[opts.storyTimeHeader.toLowerCase()];
    const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
    return Number.isNaN(at) ? new Date() : new Date(at);
  };

  const find = (words: string): Chore | undefined => {
    const said = words.toLowerCase();
    return chores.find(
      (c) => said.includes(c.title) || c.aliases.some((a) => new RegExp(`\\b${a}\\b`).test(said)),
    );
  };

  const describe = (c: Chore): string => {
    const name = c.title.charAt(0).toUpperCase() + c.title.slice(1);
    if (c.done) return `${name}: done by ${NAMES[c.done.by]} at ${clockTime(c.done.at)}.`;
    if (c.owner) return `${name}: ${NAMES[c.owner]} has it.`;
    if (c.needed)
      return `${name}: nobody has it, and it has needed someone since ${clockTime(c.needed.since)} (${c.needed.why}).`;
    return `${name}: nobody has it yet.`;
  };

  const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
  const fail = (text: string): CallToolResult => ({
    content: [{ type: 'text', text }],
    isError: true,
  });
  const unknown = (words: string) =>
    fail(
      `There is no chore called "${words}". The chores are ${chores.map((c) => c.title).join(', ')}. Ask which one they mean.`,
    );

  function mcpFor(me: { id: string; name: string }, at: Date): Server {
    const server = new Server(
      { name: 'house-rota', version: '0.1.0' },
      {
        capabilities: { tools: {}, resources: {} },
        instructions:
          'House rota tracks who has each chore in a shared home. Replies are read aloud.',
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
      const args = params.arguments ?? {};
      const words = typeof args['chore'] === 'string' ? args['chore'] : '';
      switch (params.name) {
        case 'list_chores':
          return ok(chores.map(describe).join('\n'));
        case 'take_chore': {
          const c = find(words);
          if (!c) return unknown(words);
          if (c.done)
            return ok(
              `The ${c.title} is already done: ${NAMES[c.done.by]} did it at ${clockTime(c.done.at)}.`,
            );
          if (c.owner === me.id) return ok(`${me.name} already has the ${c.title}.`);
          if (c.owner && args['takeOver'] !== true)
            return fail(
              `${NAMES[c.owner]} already has the ${c.title}. Nothing changed. Tell ${me.name}, and ask whether ${me.name} wants to take it over; only if they say yes, call take_chore again with takeOver true.`,
            );
          const from = c.owner;
          c.owner = me.id;
          c.needed = null;
          return ok(
            from
              ? `${me.name} has the ${c.title} now, taken over from ${NAMES[from]}.`
              : `${me.name} has the ${c.title} now.`,
          );
        }
        case 'mark_done': {
          const c = find(words);
          if (!c) return unknown(words);
          if (c.done)
            return ok(
              `The ${c.title} was already done by ${NAMES[c.done.by]} at ${clockTime(c.done.at)}.`,
            );
          const had = c.owner;
          c.done = { by: me.id, at };
          c.needed = null;
          return ok(
            had && had !== me.id
              ? `The ${c.title} is done, marked by ${me.name} at ${clockTime(at)}. ${NAMES[had]} had it.`
              : `The ${c.title} is done, marked by ${me.name} at ${clockTime(at)}.`,
          );
        }
        default:
          return fail(`There is no tool called ${params.name}.`);
      }
    });
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: [
        {
          uri: 'rota://week',
          name: 'This week',
          mimeType: 'text/plain',
          description: 'The rota as it stands',
        },
      ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, ({ params }) => {
      if (params.uri !== 'rota://week') throw new Error(`no resource ${params.uri}`);
      return {
        contents: [
          {
            uri: params.uri,
            mimeType: 'text/plain',
            text: `House rota at ${clockTime(at)}, read by ${me.name}.\n${chores.map(describe).join('\n')}`,
          },
        ],
      };
    });
    return server;
  }

  /** The fuel gauge's cloud posts {"level": 18} when the reading changes, signed with HMAC-SHA256. */
  function fuelHook(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (!opts.hookSecret) return reply(503, { error: 'the fuel gauge webhook is not configured' });
    const given = Buffer.from(String(req.headers['x-signature'] ?? ''), 'hex');
    const want = createHmac('sha256', opts.hookSecret).update(raw).digest();
    if (given.length !== want.length || !timingSafeEqual(given, want))
      return reply(401, { error: 'bad signature' });
    let level: unknown;
    try {
      level = (JSON.parse(raw) as { level?: unknown }).level;
    } catch {
      return reply(400, { error: 'expected JSON' });
    }
    if (typeof level !== 'number') return reply(400, { error: 'expected {"level": <percent>}' });
    const fuel = chores.find((c) => c.id === 'fuel')!;
    if (level >= 25) return reply(200, { ok: true, needsSomeone: false });
    if (fuel.done) {
      fuel.done = null;
      fuel.owner = null;
    }
    fuel.needed = { since: now(req), why: `the gauge read ${level} percent` };
    return reply(200, { ok: true, needsSomeone: fuel.owner === null });
  }

  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/health') return void res.writeHead(200).end('ok');
      if (path === '/hooks/fuel' && req.method === 'POST') return fuelHook(req, res, raw);
      if (path !== '/mcp') return void res.writeHead(404).end();
      // Stateless: no sessions to keep, so each request is answered on its own.
      if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const me = token ? MEMBERS[token] : undefined;
      if (!me)
        return void res
          .writeHead(401, {
            'www-authenticate': 'Bearer realm="house-rota"',
            'content-type': 'application/json',
          })
          .end(JSON.stringify({ error: 'sign in with your own credential' }));
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return void res.writeHead(400).end();
      }
      const server = mcpFor(me, now(req));
      // No sessionIdGenerator: the transport issues no session id, which is what stateless means.
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      void server
        .connect(transport as never)
        .then(() => transport.handleRequest(req, res, body))
        .catch((err: unknown) => {
          if (!res.headersSent) res.writeHead(500).end(String(err));
        });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env['PORT'] ?? 8790);
  createRota({
    storyTimeHeader: process.env['STORY_TIME_HEADER'],
    hookSecret: process.env['ROTA_HOOK_SECRET'],
    timezone: process.env['ROTA_TIMEZONE'],
  }).listen(port, () => console.log(`house-rota on http://localhost:${port}/mcp`));
}
