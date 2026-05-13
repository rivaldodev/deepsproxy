import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { robustParseJSON } from '../utils/json.ts';

type ResponsesInputItem = {
  role?: string;
  content?: unknown;
};

type ResponsesRequest = {
  model: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
};

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ? JSON.stringify(content) : '';

  return content.map((part: any) => {
    if (typeof part === 'string') return part;
    if (part?.text) return part.text;
    if (part?.type === 'input_text' && part?.text) return part.text;
    if (part?.type === 'output_text' && part?.text) return part.text;
    return JSON.stringify(part);
  }).join('\n');
}

function buildPrompt(body: ResponsesRequest) {
  let systemPrompt = body.instructions ? `${body.instructions}\n\n` : '';
  let prompt = '';
  const input = body.input ?? '';

  if (typeof input === 'string') {
    prompt = `User: ${input}\n\n`;
  } else {
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      const text = contentToText(item.content);

      if (item.role === 'system') {
        systemPrompt += `${text}\n\n`;
      } else if (i === input.length - 1) {
        if (item.role === 'assistant') {
          prompt += `Assistant: ${text}\n\n`;
        } else if (item.role === 'tool' || item.role === 'function') {
          prompt += `Tool Response: ${text}\n\n`;
        } else {
          prompt += `User: ${text}\n\n`;
        }
      }
    }
  }

  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    const formattedTools = body.tools.map((tool: any) => {
      if (tool.type === 'function' && tool.function) {
        return {
          name: tool.function.name,
          description: tool.function.description || '',
          parameters: tool.function.parameters,
        };
      }

      if (tool.type === 'function') {
        return {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters,
        };
      }

      return tool;
    });

    systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${JSON.stringify(formattedTools, null, 2)}\n\nTo use a tool, output exactly:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\n`;

    const forcedTool = body.tool_choice?.function?.name || body.tool_choice?.name;
    if (forcedTool) {
      systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
    }
  }

  return systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
}

function extractToolCalls(content: string) {
  const toolCalls: any[] = [];
  const textParts: string[] = [];
  const toolPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = toolPattern.exec(content)) !== null) {
    textParts.push(content.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;

    const parsed = robustParseJSON(match[1]);
    if (parsed) {
      toolCalls.push({
        id: 'fc_' + uuidv4(),
        type: 'function_call',
        call_id: 'call_' + uuidv4(),
        name: parsed.name || '',
        arguments: typeof parsed.arguments === 'object'
          ? JSON.stringify(parsed.arguments)
          : String(parsed.arguments || ''),
      });
    } else {
      textParts.push(match[0]);
    }
  }

  textParts.push(content.slice(lastIndex));

  return {
    text: textParts.join('').trim(),
    toolCalls,
  };
}

async function collectDeepSeekText(dsStream: ReadableStream, uiSessionId: string) {
  const reader = dsStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentAppendPath = '';
  let outputText = '';
  let reasoningText = '';
  let completionTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);

        const dsMessageId = chunk.response_message_id
          || chunk.message_id
          || chunk.v?.message_id
          || chunk.v?.response?.message_id;

        if (dsMessageId) {
          updateSessionParent(uiSessionId, dsMessageId);
        }

        if (typeof chunk.p === 'string') {
          currentAppendPath = chunk.p;
          if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
            completionTokens = chunk.v;
          }
        }

        let valueText = '';
        if (typeof chunk.v === 'string') {
          valueText = chunk.v;
        } else if (chunk.v?.response?.fragments?.[0]?.content) {
          const frag = chunk.v.response.fragments[0];
          valueText = frag.content;
          currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
        } else if (Array.isArray(chunk.v) && chunk.v[0]?.content) {
          const frag = chunk.v[0];
          valueText = frag.content;
          currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
        }

        if (!valueText || valueText === 'FINISHED') continue;

        if (currentAppendPath.includes('thinking_content') || currentAppendPath.includes('THINK')) {
          reasoningText += valueText;
        } else {
          outputText += valueText;
        }
      } catch (err) {
        // Ignore malformed chunks.
      }
    }
  }

  return { outputText, reasoningText, completionTokens };
}

function responseUsage(prompt: string, completionTokens: number) {
  const inputTokens = Math.ceil(prompt.length / 3.5);

  return {
    input_tokens: inputTokens,
    output_tokens: completionTokens,
    total_tokens: inputTokens + completionTokens,
  };
}

export async function responses(c: Context) {
  try {
    const body: ResponsesRequest = await c.req.json();
    const prompt = buildPrompt(body);
    const normalizedModel = body.model.toLowerCase();
    const isThinkingModel = normalizedModel.includes('reasoner')
      || (normalizedModel.includes('thinking') && !normalizedModel.includes('no-thinking'));

    const result = await createDeepSeekStream(prompt, isThinkingModel, null);
    const responseId = 'resp_' + uuidv4();

    if (body.stream) {
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      return honoStream(c, async (streamWriter: any) => {
        await streamWriter.write(`data: ${JSON.stringify({
          type: 'response.created',
          response: {
            id: responseId,
            object: 'response',
            status: 'in_progress',
            model: body.model,
          },
        })}\n\n`);

        const collected = await collectDeepSeekText(result.stream, result.uiSessionId);
        const { text, toolCalls } = extractToolCalls(collected.outputText);

        if (text) {
          await streamWriter.write(`data: ${JSON.stringify({
            type: 'response.output_text.delta',
            delta: text,
          })}\n\n`);
        }

        const output = toolCalls.length > 0
          ? toolCalls
          : [{
              id: 'msg_' + uuidv4(),
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{
                type: 'output_text',
                text,
                annotations: [],
              }],
            }];

        await streamWriter.write(`data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            status: 'completed',
            model: body.model,
            output,
            output_text: text,
            usage: responseUsage(prompt, collected.completionTokens),
          },
        })}\n\n`);
        await streamWriter.write('data: [DONE]\n\n');
      });
    }

    const collected = await collectDeepSeekText(result.stream, result.uiSessionId);
    const { text, toolCalls } = extractToolCalls(collected.outputText);
    const output = toolCalls.length > 0
      ? toolCalls
      : [{
          id: 'msg_' + uuidv4(),
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text,
            annotations: [],
          }],
        }];

    return c.json({
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      error: null,
      incomplete_details: null,
      model: body.model,
      output,
      output_text: text,
      usage: responseUsage(prompt, collected.completionTokens),
    });
  } catch (err: any) {
    console.error('Error in responses:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
