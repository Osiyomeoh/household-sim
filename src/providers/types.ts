/**
 * What the simulated assistant needs from a model: given the server's tools and what someone
 * said, choose tools to call, read their results, and say something back.
 *
 * Which model does this is the tester's choice. An add-on whose tools only work with one
 * vendor's planner is fragile, and being able to swap the planner is how you find that out.
 */

/** A tool as the MCP server describes it, passed to the model untouched. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TurnOutput {
  /** What the model said. Empty while it is only calling tools. */
  text: string;
  toolUses: ToolUse[];
}

export interface ToolResult {
  id: string;
  name: string;
  text: string;
  isError: boolean;
}

/** One conversation. Each provider keeps history in its own shape. */
export interface Conversation {
  say(utterance: string): Promise<TurnOutput>;
  report(results: ToolResult[]): Promise<TurnOutput>;
}

export interface ModelProvider {
  /** `bedrock:<model id>`, `openai:<model>` and so on, as the tester wrote it. */
  readonly spec: string;
  start(system: string, tools: ToolSpec[]): Conversation;
}
