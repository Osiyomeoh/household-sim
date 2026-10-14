import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import type { Conversation, ModelProvider, ToolSpec, TurnOutput } from './types.js';

/**
 * Amazon Bedrock, through the Converse API. Credentials and region come from the usual AWS
 * chain (AWS_PROFILE, AWS_REGION, an instance role), never from the scenario.
 */
export class BedrockProvider implements ModelProvider {
  readonly spec: string;
  readonly #modelId: string;
  readonly #client: BedrockRuntimeClient;

  constructor(modelId: string, region = process.env['AWS_REGION'] ?? 'us-east-1') {
    this.spec = `bedrock:${modelId}`;
    this.#modelId = modelId;
    this.#client = new BedrockRuntimeClient({ region });
  }

  start(system: string, tools: ToolSpec[]): Conversation {
    const history: Message[] = [];
    const toolConfig: { tools: Tool[] } = {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.inputSchema as never },
        },
      })),
    };

    const turn = async (): Promise<TurnOutput> => {
      const res = await this.#client.send(
        new ConverseCommand({
          modelId: this.#modelId,
          system: [{ text: system }],
          messages: history,
          // Bedrock refuses an empty tool list, so a server with no tools sends none.
          ...(toolConfig.tools.length ? { toolConfig } : {}),
          inferenceConfig: { maxTokens: 512, temperature: 0 },
        }),
      );
      const content = res.output?.message?.content ?? [];
      history.push({ role: 'assistant', content });
      return {
        text: content
          .map((c) => ('text' in c ? (c.text ?? '') : ''))
          .join(' ')
          .trim(),
        toolUses: content.flatMap((c) =>
          'toolUse' in c && c.toolUse
            ? [
                {
                  id: c.toolUse.toolUseId ?? '',
                  name: c.toolUse.name ?? '',
                  input: (c.toolUse.input ?? {}) as Record<string, unknown>,
                },
              ]
            : [],
        ),
      };
    };

    return {
      say(utterance) {
        history.push({ role: 'user', content: [{ text: utterance }] });
        return turn();
      },
      report(results) {
        const blocks: ContentBlock[] = results.map((r) => ({
          toolResult: {
            toolUseId: r.id,
            content: [{ text: r.text || '(no text)' }],
            status: r.isError ? 'error' : 'success',
          },
        }));
        history.push({ role: 'user', content: blocks });
        return turn();
      },
    };
  }
}
