import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OpenAICompatibleProvider } from '../src/providers/openai.js';
import { providerFromSpec } from '../src/providers/index.js';

test('an OpenAI-compatible endpoint gets the tools and the tool results in its own format', async () => {
  const bodies: {
    messages: { role: string; tool_call_id?: string; content: string | null }[];
    tools?: unknown[];
  }[] = [];
  let auth = '';
  const answers = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'list_chores', arguments: '{}' } },
      ],
    },
    { role: 'assistant', content: ' Ada has the fuel. ' },
  ];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      auth = String(req.headers.authorization);
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: answers.shift() }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const p = new OpenAICompatibleProvider({
      spec: 'openai:test',
      model: 'test',
      baseUrl: `http://127.0.0.1:${port}/v1/`,
      apiKey: 'k',
    });
    const c = p.start('be brief', [
      { name: 'list_chores', description: 'List them.', inputSchema: { type: 'object' } },
    ]);
    const first = await c.say('who has the fuel?');
    assert.deepEqual(first.toolUses, [{ id: 'call_1', name: 'list_chores', input: {} }]);
    const second = await c.report([
      { id: 'call_1', name: 'list_chores', text: 'Fuel: Ada', isError: false },
    ]);
    assert.equal(second.text, 'Ada has the fuel.');
    assert.equal(auth, 'Bearer k');
    assert.equal(bodies[0]?.tools?.length, 1);
    assert.deepEqual(
      bodies[1]?.messages.map((m) => m.role),
      ['system', 'user', 'assistant', 'tool'],
    );
    assert.equal(bodies[1]?.messages[3]?.tool_call_id, 'call_1');
  } finally {
    server.close();
  }
});

test('model specs name a provider and a model', () => {
  assert.equal(providerFromSpec('ollama:llama3.1').spec, 'ollama:llama3.1');
  assert.equal(
    providerFromSpec('bedrock:amazon.nova-pro-v1:0').spec,
    'bedrock:amazon.nova-pro-v1:0',
  );
  assert.throws(() => providerFromSpec('ollama'), /<provider>:<model>/);
  assert.throws(() => providerFromSpec('gemini:x'), /unknown provider "gemini"/);
});
