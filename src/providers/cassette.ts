import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Conversation, ModelProvider, ToolSpec, TurnOutput } from './types.js';

/**
 * Record a model's choices once, then replay them.
 *
 * A replayed run makes no model call, so it costs nothing, needs no credentials and gives the
 * same answer every time - which is what CI needs. The tool calls still go to the real server,
 * so the server is tested for real; only the model's side is fixed.
 *
 * Replaying is honest about what it cannot see: when the server's tools have changed since
 * the recording, the recorded choices were made against the old descriptions, so the run
 * says so and asks for a fresh recording.
 */

export interface CassetteTurn {
  step: number;
  as: string;
  text: string;
  toolUses: { id: string; name: string; input: Record<string, unknown> }[];
}

export interface Cassette {
  version: 1;
  scenario: string;
  model: string;
  recordedAt: string;
  /** A hash of each member's tool list when it was recorded. */
  tools: Record<string, string>;
  turns: CassetteTurn[];
}

export class StaleCassette extends Error {}

export function cassettePath(scenarioFile: string, dir?: string): string {
  const name = basename(scenarioFile).replace(/\.ya?ml$/, '.json');
  return join(dir ?? join(dirname(scenarioFile), 'cassettes'), name);
}

export function toolsHash(tools: ToolSpec[]): string {
  const canon = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => [t.name, t.description, t.inputSchema]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 16);
}

/** Where the runner is, so each recorded turn says which step and member it belongs to. */
export interface Cursor {
  step: number;
  as: string;
}

export class Recorder implements ModelProvider {
  readonly spec: string;
  readonly cursor: Cursor = { step: 0, as: '' };
  readonly #inner: ModelProvider;
  readonly #tape: Cassette;

  constructor(inner: ModelProvider, scenario: string) {
    this.#inner = inner;
    this.spec = inner.spec;
    this.#tape = {
      version: 1,
      scenario,
      model: inner.spec,
      recordedAt: new Date().toISOString(),
      tools: {},
      turns: [],
    };
  }

  start(system: string, tools: ToolSpec[]): Conversation {
    const inner = this.#inner.start(system, tools);
    this.#tape.tools[this.cursor.as] = toolsHash(tools);
    const keep = (out: TurnOutput): TurnOutput => {
      this.#tape.turns.push({ ...this.cursor, text: out.text, toolUses: out.toolUses });
      return out;
    };
    return {
      say: async (u) => keep(await inner.say(u)),
      report: async (r) => keep(await inner.report(r)),
    };
  }

  save(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(this.#tape, null, 2) + '\n');
  }
}

export class Player implements ModelProvider {
  readonly spec: string;
  readonly cursor: Cursor = { step: 0, as: '' };
  /** Things a reader should know about this replay, such as tools that changed. */
  readonly notes: string[] = [];
  readonly #tape: Cassette;
  #next = 0;

  constructor(tape: Cassette) {
    this.#tape = tape;
    this.spec = `replay of ${tape.model}`;
  }

  static load(file: string): Player {
    if (!existsSync(file))
      throw new StaleCassette(`no recording at ${file}. Run once with --record to make one.`);
    const tape = JSON.parse(readFileSync(file, 'utf8')) as Cassette;
    if (tape.version !== 1) throw new StaleCassette(`${file}: unknown cassette version`);
    return new Player(tape);
  }

  get recordedAt(): string {
    return this.#tape.recordedAt;
  }

  /** Turns the run never asked for: the scenario changed since it was recorded. */
  get leftover(): number {
    return this.#tape.turns.length - this.#next;
  }

  start(_system: string, tools: ToolSpec[]): Conversation {
    const who = this.cursor.as;
    const was = this.#tape.tools[who];
    if (was && was !== toolsHash(tools)) {
      const note = `${who}'s tools changed since this was recorded (${this.#tape.recordedAt.slice(0, 10)}); the replayed choices were made against the old descriptions. Re-record to test the new ones.`;
      if (!this.notes.includes(note)) this.notes.push(note);
    }
    const names = new Set(tools.map((t) => t.name));
    const play = (): TurnOutput => {
      const turn = this.#tape.turns[this.#next];
      const here = `step ${this.cursor.step} (${this.cursor.as})`;
      if (!turn)
        throw new StaleCassette(
          `the recording ran out at ${here}: the scenario asks more of the model than when it was recorded. Re-record with --record.`,
        );
      if (turn.step !== this.cursor.step || turn.as !== this.cursor.as)
        throw new StaleCassette(
          `${here} is not where the recording expects to be (it has step ${turn.step} (${turn.as}) next). The scenario changed; re-record with --record.`,
        );
      for (const use of turn.toolUses)
        if (!names.has(use.name))
          throw new StaleCassette(
            `${here}: the recording calls ${use.name}, which the server no longer offers. Re-record with --record.`,
          );
      this.#next += 1;
      return { text: turn.text, toolUses: turn.toolUses };
    };
    return { say: async () => play(), report: async () => play() };
  }
}
