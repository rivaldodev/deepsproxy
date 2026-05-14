import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { robustParseJSON } from '../utils/json.ts';
import { executeToolCalls, parseToolCallsFromContent } from '../tools/executor.ts';
import { registry } from '../tools/registry.ts';
import type { ParsedToolCall, ToolCallResult } from '../tools/types.ts';

type ResponsesInputItem = {
  type?: string;
  role?: string;
  content?: unknown;
  text?: string;
  output_text?: string;
  input_text?: string;
  name?: string;
};

type ResponsesRequest = {
  model: string;
  input?: string | ResponsesInputItem[] | Record<string, unknown>;
  messages?: ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  auto_execute_tools?: boolean;
  max_tool_turns?: number;
};

type CollectedResponse = {
  outputText: string;
  reasoningText: string;
  completionTokens: number;
};

type GeneratedResponse = {
  text: string;
  toolCalls: any[];
  completionTokens: number;
  promptForUsage: string;
};

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (!content) return '';
    const part = content as any;
    if (part.text) return String(part.text);
    if (part.input_text) return String(part.input_text);
    if (part.output_text) return String(part.output_text);
    if (part.content) return contentToText(part.content);
    return JSON.stringify(content);
  }

  return content.map((part: any) => {
    if (typeof part === 'string') return part;
    if (part?.text) return part.text;
    if (part?.input_text) return part.input_text;
    if (part?.output_text) return part.output_text;
    if (part?.content) return contentToText(part.content);
    if (part?.type === 'input_text' && part?.text) return part.text;
    if (part?.type === 'output_text' && part?.text) return part.text;
    return JSON.stringify(part);
  }).join('\n');
}

function inputItemToText(item: unknown): string {
  if (typeof item === 'string') return item;
  const typedItem = item as ResponsesInputItem;
  if (typedItem.text) return typedItem.text;
  if (typedItem.input_text) return typedItem.input_text;
  if (typedItem.output_text) return typedItem.output_text;
  return contentToText(typedItem.content ?? typedItem);
}

function appendPromptLine(prompt: string, role: string | undefined, text: string, name?: string) {
  const cleanText = text.trim();
  if (!cleanText) return prompt;

  if (role === 'assistant') {
    return `${prompt}Assistant: ${cleanText}\n\n`;
  }

  if (role === 'tool' || role === 'function' || role === 'function_call_output') {
    return `${prompt}Tool Response (${name || 'tool'}): ${cleanText}\n\n`;
  }

  return `${prompt}User: ${cleanText}\n\n`;
}

function mergeTools(bodyTools: any[] | undefined, includeRegistryTools: boolean) {
  const tools = Array.isArray(bodyTools) ? [...bodyTools] : [];
  if (!includeRegistryTools) return tools;

  const seen = new Set(tools.map((tool: any) => {
    if (tool.type === 'function' && tool.function?.name) return tool.function.name;
    if (tool.type === 'function' && tool.name) return tool.name;
    return '';
  }).filter(Boolean));

  for (const tool of registry.toOpenAITools()) {
    if (!seen.has(tool.function.name)) {
      tools.push(tool);
      seen.add(tool.function.name);
    }
  }

  return tools;
}

function buildPrompt(body: ResponsesRequest, includeRegistryTools = false) {
  let systemPrompt = body.instructions ? `${body.instructions}\n\n` : '';
  let prompt = '';
  const input = body.input ?? body.messages ?? '';

  if (typeof input === 'string') {
    prompt = `User: ${input}\n\n`;
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const role = item.role || (item.type === 'function_call_output' ? 'function_call_output' : undefined);
      const text = inputItemToText(item);

      if (role === 'system' || (item.type === 'message' && item.role === 'system')) {
        if (text.trim()) {
          systemPrompt += `${text.trim()}\n\n`;
        }
      } else {
        prompt = appendPromptLine(prompt, role, text, item.name);
      }
    }
  } else {
    const inputObject = input as Record<string, unknown>;
    const role = typeof inputObject.role === 'string' ? inputObject.role : undefined;
    const text = contentToText(input);

    if (role === 'system') {
      systemPrompt += `${text.trim()}\n\n`;
    } else {
      prompt = appendPromptLine(prompt, role, text);
    }
  }

  const tools = mergeTools(body.tools, includeRegistryTools);

  if (tools.length > 0) {
    const formattedTools = tools.map((tool: any) => {
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

function parsedToolCallsToResponseCalls(toolCalls: ParsedToolCall[]) {
  return toolCalls.map((tc) => ({
    id: 'fc_' + uuidv4(),
    type: 'function_call',
    call_id: tc.id,
    name: tc.name,
    arguments: typeof tc.arguments === 'object'
      ? JSON.stringify(tc.arguments)
      : String(tc.arguments || ''),
  }));
}

function shouldAutoExecuteTools(c: Context, body: ResponsesRequest) {
  const header = c.req.header('X-Auto-Execute-Tools')?.toLowerCase();
  return body.auto_execute_tools === true
    || header === 'true'
    || process.env.AUTO_EXECUTE_TOOLS === 'true';
}

function inputAsToolContextMessages(body: ResponsesRequest): unknown[] {
  if (Array.isArray(body.input)) return body.input;
  if (Array.isArray(body.messages)) return body.messages;
  if (body.input) return [body.input];
  return [];
}

function appendToolTurnToPrompt(
  prompt: string,
  assistantText: string,
  toolCalls: ParsedToolCall[],
  toolResults: ToolCallResult[]
) {
  let nextPrompt = prompt;
  const assistantLines: string[] = [];

  if (assistantText.trim()) {
    assistantLines.push(assistantText.trim());
  }

  for (const tc of toolCalls) {
    assistantLines.push([
      '<tool_call>',
      JSON.stringify({ name: tc.name, arguments: tc.arguments }),
      '</tool_call>',
    ].join('\n'));
  }

  if (assistantLines.length > 0) {
    nextPrompt += `Assistant: ${assistantLines.join('\n')}\n\n`;
  }

  for (const result of toolResults) {
    nextPrompt += `Tool Response (${result.name}): ${result.result}\n\n`;
  }

  return nextPrompt;
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

async function generateResponse(
  body: ResponsesRequest,
  initialPrompt: string,
  isThinkingModel: boolean,
  autoExecuteTools: boolean
): Promise<GeneratedResponse> {
  let prompt = initialPrompt;
  let completionTokens = 0;
  const maxToolTurns = Math.max(1, Math.min(body.max_tool_turns ?? 10, 25));
  const contextMessages = inputAsToolContextMessages(body);

  for (let turn = 0; turn < maxToolTurns; turn++) {
    const result = await createDeepSeekStream(prompt, isThinkingModel, null);
    const collected: CollectedResponse = await collectDeepSeekText(result.stream, result.uiSessionId);
    completionTokens += collected.completionTokens;

    if (!autoExecuteTools) {
      const extracted = extractToolCalls(collected.outputText);
      return {
        text: extracted.text,
        toolCalls: extracted.toolCalls,
        completionTokens,
        promptForUsage: prompt,
      };
    }

    const parsed = parseToolCallsFromContent(collected.outputText);
    if (parsed.toolCalls.length === 0) {
      return {
        text: parsed.textContent,
        toolCalls: [],
        completionTokens,
        promptForUsage: prompt,
      };
    }

    const allToolsAreLocal = parsed.toolCalls.every((tc) => registry.has(tc.name));
    if (!allToolsAreLocal) {
      return {
        text: parsed.textContent,
        toolCalls: parsedToolCallsToResponseCalls(parsed.toolCalls),
        completionTokens,
        promptForUsage: prompt,
      };
    }

    const toolResults = await executeToolCalls(parsed.toolCalls, {
      messages: contextMessages,
      turn,
      model: body.model,
    });

    prompt = appendToolTurnToPrompt(
      prompt,
      parsed.textContent,
      parsed.toolCalls,
      toolResults
    );
  }

  throw new Error(`Tool execution loop exceeded maximum turns (${maxToolTurns})`);
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
    const autoExecuteTools = shouldAutoExecuteTools(c, body);
    const prompt = buildPrompt(body, autoExecuteTools);
    const normalizedModel = body.model.toLowerCase();
    const isThinkingModel = normalizedModel.includes('reasoner')
      || (normalizedModel.includes('thinking') && !normalizedModel.includes('no-thinking'));
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

        const generated = await generateResponse(body, prompt, isThinkingModel, autoExecuteTools);
        const { text, toolCalls } = generated;

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
            usage: responseUsage(generated.promptForUsage, generated.completionTokens),
          },
        })}\n\n`);
        await streamWriter.write('data: [DONE]\n\n');
      });
    }

    const generated = await generateResponse(body, prompt, isThinkingModel, autoExecuteTools);
    const { text, toolCalls } = generated;
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
      usage: responseUsage(generated.promptForUsage, generated.completionTokens),
    });
  } catch (err: any) {
    console.error('Error in responses:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
