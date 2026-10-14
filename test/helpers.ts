import type { AddressInfo } from 'node:net';
import { createRota, type RotaOptions } from '../examples/house-rota/server.js';
import type { Conversation, ModelProvider, ToolSpec, TurnOutput } from '../src/providers/types.js';

/** The example add-on on a free port, for the length of one test. */
export async function rota(
  opts: RotaOptions = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createRota(opts);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A model that plays back a fixed list of turns, and remembers what it was shown. */
export class ScriptedModel implements ModelProvider {
  readonly spec = 'scripted';
  readonly systems: string[] = [];
  readonly tools: ToolSpec[][] = [];
  readonly #turns: TurnOutput[];

  constructor(turns: TurnOutput[]) {
    this.#turns = [...turns];
  }

  start(system: string, tools: ToolSpec[]): Conversation {
    this.systems.push(system);
    this.tools.push(tools);
    const next = async (): Promise<TurnOutput> => {
      const t = this.#turns.shift();
      if (!t) throw new Error('the script ran out');
      return t;
    };
    return { say: next, report: next };
  }
}

let ids = 0;
export const use = (name: string, input: Record<string, unknown> = {}) => ({
  text: '',
  toolUses: [{ id: `t${(ids += 1)}`, name, input }],
});
export const reply = (text: string): TurnOutput => ({ text, toolUses: [] });
