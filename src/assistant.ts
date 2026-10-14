import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spokenTime, type StoryClock } from './clock.js';
import type {
  Conversation,
  ModelProvider,
  ToolResult,
  ToolSpec,
  TurnOutput,
} from './providers/types.js';

/**
 * The simulated assistant one member of the household talks to.
 *
 * It is a real MCP client, connected with that member's own credential, and a model chooses
 * the tools from the server's own descriptions. Nothing is scripted on the add-on's side,
 * so how well the model chooses is a direct test of how well the tools are described.
 *
 * It stands in for a voice host such as Alexa+; it is not one. A real host has its own
 * planner and prompt, and will not behave identically. What carries over is whether the
 * server's tools, descriptions, errors and replies hold up when a model drives them.
 */

export const BASE_RULES = `You are the voice assistant in a shared home. People speak to you, and your reply is read aloud to them.

Rules:
- Use the tools for anything about this household's records. Read the record again on every turn: other people change it between turns.
- Say tool results plainly. No markdown, lists, links or emoji: this is read aloud.
- When a tool returns an error, follow what it says. Usually that means asking the person a question.
- Be brief: one or two sentences.`;

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  ms: number;
}

export interface Turn {
  reply: string;
  calls: ToolCall[];
  /** How many times the model was asked: once, plus once per round of tool results. */
  modelTurns: number;
  outcome: 'answered' | 'step_limit';
  modelMs: number;
  toolMs: number;
  ms: number;
}

export function systemPrompt(opts: {
  name: string;
  now: Date;
  timezone: string;
  extra: string;
}): string {
  return `${BASE_RULES}

You are speaking with ${opts.name}. That comes from their credential, not from the conversation: never ask who they are, and when they say "I" they mean ${opts.name}.
It is ${spokenTime(opts.now, opts.timezone)} (${opts.timezone}). Resolve "today", "tonight" and "Thursday" against that.${opts.extra ? `\n\n${opts.extra}` : ''}`;
}

const text = (out: { content?: unknown; toolResult?: unknown }): string =>
  !Array.isArray(out.content) && out.toolResult !== undefined
    ? JSON.stringify(out.toolResult)
    : Array.isArray(out.content)
      ? out.content
          .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
          .join('\n')
          .trim()
      : '';

export class Assistant {
  readonly name: string;
  readonly #mcp: Client;
  readonly #clock: StoryClock;
  #tools: ToolSpec[] = [];
  #conversation: Conversation | null = null;

  private constructor(name: string, mcp: Client, clock: StoryClock) {
    this.name = name;
    this.#mcp = mcp;
    this.#clock = clock;
  }

  static async connect(opts: {
    url: string;
    name: string;
    token?: string | undefined;
    clock: StoryClock;
  }): Promise<Assistant> {
    const mcp = new Client({ name: 'household-sim', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
        for (const [k, v] of Object.entries(opts.clock.headers())) headers.set(k, v);
        return fetch(url, { ...init, headers });
      },
    });
    await mcp.connect(transport as never);
    const a = new Assistant(opts.name, mcp, opts.clock);
    const { tools } = await mcp.listTools();
    a.#tools = tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    }));
    return a;
  }

  get tools(): ToolSpec[] {
    return this.#tools;
  }

  /** Time moved: the next thing this person says starts a new conversation, as it would. */
  forget(): void {
    this.#conversation = null;
  }

  /** One spoken turn: what the person said in, what the assistant says back. */
  async say(
    utterance: string,
    planner: { provider: ModelProvider; timezone: string; prompt: string; maxSteps: number },
  ): Promise<Turn> {
    const started = Date.now();
    this.#conversation ??= planner.provider.start(
      systemPrompt({
        name: this.name,
        now: this.#clock.now(),
        timezone: planner.timezone,
        extra: planner.prompt,
      }),
      this.#tools,
    );
    const conversation = this.#conversation;
    const calls: ToolCall[] = [];
    let modelMs = 0;
    let modelTurns = 0;
    const ask = async (fn: () => Promise<TurnOutput>): Promise<TurnOutput> => {
      const t = Date.now();
      try {
        return await fn();
      } finally {
        modelMs += Date.now() - t;
        modelTurns += 1;
      }
    };
    const done = (reply: string, outcome: Turn['outcome']): Turn => ({
      reply,
      calls,
      modelTurns,
      outcome,
      modelMs,
      toolMs: calls.reduce((s, c) => s + c.ms, 0),
      ms: Date.now() - started,
    });

    let out = await ask(() => conversation.say(utterance));
    // Bounded, so a confused model cannot loop forever.
    for (let step = 0; step < planner.maxSteps; step += 1) {
      if (!out.toolUses.length) return done(out.text, 'answered');
      const results: ToolResult[] = [];
      for (const use of out.toolUses) {
        const call = await this.call(use.name, use.input);
        calls.push(call);
        results.push({ id: use.id, name: use.name, text: call.result, isError: call.isError });
      }
      out = await ask(() => conversation.report(results));
    }
    return done(out.text, 'step_limit');
  }

  /** Call a tool directly, as a button on a screen would: no model involved. */
  async call(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const t = Date.now();
    try {
      const out = await this.#mcp.callTool({ name, arguments: args });
      return {
        name,
        args,
        result: text(out as { content?: unknown; toolResult?: unknown }),
        isError: out.isError === true,
        ms: Date.now() - t,
      };
    } catch (err) {
      return { name, args, result: (err as Error).message, isError: true, ms: Date.now() - t };
    }
  }

  /** Read a resource as this member, as text. */
  async read(uri: string): Promise<string> {
    const res = await this.#mcp.readResource({ uri });
    return res.contents
      .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
      .join('\n');
  }

  async close(): Promise<void> {
    await this.#mcp.close().catch(() => {});
  }
}
