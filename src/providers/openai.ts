import type { Conversation, ModelProvider, ToolSpec, TurnOutput } from './types.js';

/**
 * Any endpoint that speaks the OpenAI chat-completions format: OpenAI itself, and local
 * servers such as Ollama, LM Studio, llama.cpp or vLLM. With a local model a scenario can be
 * run with no account and no cost.
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly spec: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;

  constructor(opts: { spec: string; model: string; baseUrl: string; apiKey?: string | undefined }) {
    this.spec = opts.spec;
    this.#model = opts.model;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
  }

  start(system: string, tools: ToolSpec[]): Conversation {
    const messages: ChatMessage[] = [{ role: 'system', content: system }];
    const fns = tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    const turn = async (): Promise<TurnOutput> => {
      const res = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.#model,
          messages,
          ...(fns.length ? { tools: fns } : {}),
          temperature: 0,
          max_tokens: 512,
        }),
      });
      if (!res.ok)
        throw new Error(`${this.spec} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { choices?: { message?: ChatMessage }[] };
      const msg = body.choices?.[0]?.message;
      if (!msg) throw new Error(`${this.spec} returned no message`);
      messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      });
      return {
        text: (msg.content ?? '').trim(),
        toolUses: (msg.tool_calls ?? []).map((c) => {
          let input: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(c.function.arguments || '{}');
            if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
          } catch {
            // A model that writes broken JSON gets an empty input; the server's error says why.
          }
          return { id: c.id, name: c.function.name, input };
        }),
      };
    };

    return {
      say(utterance) {
        messages.push({ role: 'user', content: utterance });
        return turn();
      },
      report(results) {
        for (const r of results)
          messages.push({
            role: 'tool',
            tool_call_id: r.id,
            content: r.isError ? `Error: ${r.text}` : r.text || '(no text)',
          });
        return turn();
      },
    };
  }
}
