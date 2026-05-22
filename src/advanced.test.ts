import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from './index.ts';
import { registry } from './tools/registry.ts';

// Helper to mock the fetch global for testing empty response retry and caching logic
function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('chat.deepseek.com')) {
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('multiturn-thinking-tools: maintains reasoning_content history', async () => {
  let capturedPrompt = '';

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPrompt = bodyObj.prompt;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-thinking',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'doing something', reasoning_content: 'thinking about hello', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
          { role: 'tool', name: 'test', content: 'success' }
        ]
      })
    });
    
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // Validate that only the last message is sent (as requested by user)
    // In this case, the last message is the tool response
    assert.ok(capturedPrompt.includes('Tool Response (test): success'), 'Must include tool response signature');
    assert.ok(!capturedPrompt.includes('<think>\nthinking about hello\n</think>'), 'Should not include previous thinking');
    assert.ok(!capturedPrompt.includes('<tool_call>{"name": "test", "arguments": {}}</tool_call>'), 'Should not include previous tool call');
  } finally {
    restore();
  }
});

test('streaming-whitespace: preserves exact whitespace', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"   "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"  hello  "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"\\n\\n  "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-thinking', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              full += data.choices[0].delta.content;
            }
          } catch(e) {}
        }
      }
    }
    
    // We expect exactly: "     hello  \n\n  "
    assert.strictEqual(full, "     hello  \n\n  ");
  } finally {
    restore();
  }
});

test('caching-streaming and cache-control: returns prompt_tokens_details', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"done"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/accumulated_token_usage","o":"SET","v":10}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-thinking', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let usageBlock = null;
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              usageBlock = data.usage;
            }
          } catch(e) {}
        }
      }
    }
    
    assert.ok(usageBlock);
    assert.strictEqual(usageBlock.completion_tokens, 10);
    assert.ok(usageBlock.prompt_tokens > 0);
    assert.strictEqual(usageBlock.prompt_tokens_details.cached_tokens, 0); // Tests caching-streaming shape!
  } finally {
    restore();
  }
});

test('session-parent-tracking: appends messages using response message_id as parent', async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPayloads.push(bodyObj);
    
    // Simulate DeepSeek returning a message_id
    const mockMessageId = capturedPayloads.length === 1 ? 1001 : 1002;
    
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"v":{"response":{"message_id":${mockMessageId}}}}\n\n`));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'test-session-parent-tracking';
    // Turn 1
    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-thinking',
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });
    
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    // Consume the stream to ensure the message_id is processed
    await res1.text();

    // Turn 2
    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-thinking',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });
    
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    // In Turn 1, parent_message_id should be null (mock-session is fresh)
    assert.strictEqual(capturedPayloads[0].parent_message_id, null);
    // In Turn 2, parent_message_id should be 1001 (the ID returned in Turn 1)
    assert.strictEqual(capturedPayloads[1].parent_message_id, 1001, 'Turn 2 should use message_id from Turn 1 as parent');
    assert.strictEqual(capturedPayloads[1].prompt, 'User: Turn 2\n\n', 'Should only send the last message');
  } finally {
    restore();
  }
});

test('responses auto_execute_tools executes registered local tools', async () => {
  const toolName = 'test_lookup';
  if (registry.has(toolName)) registry.unregister(toolName);

  registry.register(
    toolName,
    'Looks up a test value',
    {
      type: 'object',
      properties: {
        key: { type: 'string' },
      },
      required: ['key'],
    },
    async (args) => ({ value: `result:${args.key}` })
  );

  const prompts: string[] = [];
  let callCount = 0;

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    prompts.push(bodyObj.prompt);
    callCount++;

    const content = callCount === 1
      ? '<tool_call>\n{"name":"test_lookup","arguments":{"key":"abc"}}\n</tool_call>'
      : 'Final answer from tool result.';

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ p: 'response/content', v: content })}\n\n`));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-no-thinking',
        input: 'Use the lookup tool',
        auto_execute_tools: true,
        tools: [{
          type: 'function',
          function: {
            name: toolName,
            description: 'Looks up a test value',
            parameters: {
              type: 'object',
              properties: {
                key: { type: 'string' },
              },
              required: ['key'],
            },
          },
        }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.output_text, 'Final answer from tool result.');
    assert.strictEqual(body.output[0].type, 'message');
    assert.strictEqual(callCount, 2);
    assert.ok(prompts[1].includes('Tool Response (test_lookup):'));
    assert.ok(prompts[1].includes('result:abc'));
  } finally {
    restore();
    registry.unregister(toolName);
  }
});

test('chat completions uses request tools and disables DeepSeek search', async () => {
  let capturedPayload: any = null;

  const restore = setupFetchMock((url, init) => {
    capturedPayload = JSON.parse(init?.body as string || '{}');
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"<tool_call>\\n{\\"name\\":\\"lookup\\",\\"arguments\\":{\\"query\\":\\"abc\\"}}\\n</tool_call>"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-no-thinking',
        messages: [{ role: 'user', content: 'Look it up' }],
        tools: [{
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Lookup supplied by the client',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    const toolCall = body.choices[0].message.tool_calls[0];
    assert.strictEqual(body.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(body.choices[0].message.content, null);
    assert.strictEqual(toolCall.function.name, 'lookup');
    assert.deepStrictEqual(JSON.parse(toolCall.function.arguments), { query: 'abc' });
    assert.strictEqual(capturedPayload.search_enabled, false);
    assert.ok(capturedPayload.prompt.includes('"name": "lookup"'));
    assert.ok(!capturedPayload.prompt.includes('web_search'));
  } finally {
    restore();
  }
});

test('responses auto_execute_tools normalizes SEARCHING json final answer', async () => {
  const toolName = 'test_searching_json';
  if (registry.has(toolName)) registry.unregister(toolName);

  registry.register(
    toolName,
    'Returns test search data',
    {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
    async () => ({ results: [{ title: 'Fonte A', url: 'https://example.com/a' }] })
  );

  let callCount = 0;

  const restore = setupFetchMock(() => {
    callCount++;

    const content = callCount === 1
      ? '<tool_call>\n{"name":"test_searching_json","arguments":{"query":"abc"}}\n</tool_call>'
      : 'SEARCHING{ "message": "Resposta em markdown.", "codigo": "", "analise": "x", "fontes": ["https://example.com/a"] }';

    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ p: 'response/content', v: content })}\n\n`));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-no-thinking',
        input: 'Search and answer',
        auto_execute_tools: true,
        tools: [{
          type: 'function',
          function: {
            name: toolName,
            description: 'Returns test search data',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
              required: ['query'],
            },
          },
        }],
      }),
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.output_text, 'Resposta em markdown.\n\n## Fontes\n- https://example.com/a');
    assert.strictEqual(body.output[0].content[0].text, body.output_text);
  } finally {
    restore();
    registry.unregister(toolName);
  }
});
