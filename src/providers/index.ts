import { BedrockProvider } from './bedrock.js';
import { OpenAICompatibleProvider } from './openai.js';
import type { ModelProvider } from './types.js';

export type {
  ModelProvider,
  Conversation,
  ToolSpec,
  ToolUse,
  ToolResult,
  TurnOutput,
} from './types.js';
export { BedrockProvider } from './bedrock.js';
export { OpenAICompatibleProvider } from './openai.js';
export { Recorder, Player, StaleCassette, cassettePath, toolsHash } from './cassette.js';

export const DEFAULT_MODEL = 'bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/**
 * A model from a short spec:
 * - `bedrock:<model id>` - Amazon Bedrock (AWS credentials from the environment)
 * - `openai:<model>` - OpenAI, or any compatible server via OPENAI_BASE_URL (key: OPENAI_API_KEY)
 * - `ollama:<model>` - a local Ollama (OLLAMA_HOST, default http://localhost:11434)
 */
export function providerFromSpec(spec: string = DEFAULT_MODEL): ModelProvider {
  const colon = spec.indexOf(':');
  const kind = colon < 0 ? spec : spec.slice(0, colon);
  const model = colon < 0 ? '' : spec.slice(colon + 1);
  if (!model)
    throw new Error(`model "${spec}": write it as <provider>:<model>, e.g. ${DEFAULT_MODEL}`);
  switch (kind) {
    case 'bedrock':
      return new BedrockProvider(model);
    case 'openai':
      return new OpenAICompatibleProvider({
        spec,
        model,
        baseUrl: process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
        apiKey: process.env['OPENAI_API_KEY'],
      });
    case 'ollama':
      return new OpenAICompatibleProvider({
        spec,
        model,
        baseUrl: `${(process.env['OLLAMA_HOST'] ?? 'http://localhost:11434').replace(/\/+$/, '')}/v1`,
      });
    default:
      throw new Error(
        `model "${spec}": unknown provider "${kind}" (use bedrock, openai or ollama)`,
      );
  }
}
