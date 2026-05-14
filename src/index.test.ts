import test from 'node:test';
import assert from 'node:assert';
import { app } from './index.ts';
import { initPlaywright, closePlaywright } from './services/playwright.ts';

test('Health check endpoint returns status ok', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

test('Models endpoint returns deepseek-thinking and deepseek-no-thinking', async () => {
  const req = new Request('http://localhost/v1/models');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.strictEqual(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-thinking'));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-no-thinking'));
});

test('Model retrieve endpoint returns OpenAI-compatible model object', async () => {
  const req = new Request('http://localhost/v1/models/deepseek-no-thinking');
  const res = await app.fetch(req);

  assert.strictEqual(res.status, 200);

  const body = await res.json();
  assert.strictEqual(body.id, 'deepseek-no-thinking');
  assert.strictEqual(body.object, 'model');
});

test('Responses endpoint is registered', async () => {
  process.env.TEST_MOCK_PLAYWRIGHT = 'true';
  const originalFetch = globalThis.fetch;
  let capturedPrompt = '';
  let capturedPayload: any = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (url.includes('chat.deepseek.com')) {
      const body = JSON.parse(init?.body as string || '{}');
      capturedPayload = body;
      capturedPrompt = body.prompt;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"ok"}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const req = new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-no-thinking',
        instructions: 'System rules',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Say ok' }],
        }],
      }),
    });
    const res = await app.fetch(req);

    assert.notStrictEqual(res.status, 404);
    assert.ok(capturedPrompt.includes('System rules'));
    assert.ok(capturedPrompt.includes('User: Say ok'));
    assert.strictEqual(capturedPayload.model_type, 'expert');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Chat Completions endpoint with deepseek-thinking (thinking enabled)', async () => {
  // Initialize playwright for this test
  // NOTE: Headless mode can sometimes fail Cloudflare checks. We use headless=false for the test
  // to ensure it matches the logged-in browser state if needed, or you can switch it to true.
  await initPlaywright(false);

  try {
    const payload = {
      model: 'deepseek-thinking',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);
              
              if (data.choices && data.choices[0] && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.content) {
                hasContent = true;
              }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch (err) {
            // Partial JSON ignored
            // console.error("Parse error:", err);
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    await closePlaywright();
  }
});
