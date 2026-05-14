/*
 * File: chat.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { OpenAIRequest, ChoiceDelta, Message } from '../utils/types.ts';
import { robustParseJSON } from '../utils/json.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition } from '../tools/types.ts';

function makeCompletionChoice(message: any, finishReason: string | null = null) {
  return {
    index: 0,
    message,
    logprobs: null,
    finish_reason: finishReason,
  };
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

    try {
      const parsed = robustParseJSON(match[1]);
      if (parsed) {
        toolCalls.push({
          id: 'call_' + uuidv4(),
          type: 'function',
          function: {
            name: parsed.name || '',
            arguments: typeof parsed.arguments === 'object'
              ? JSON.stringify(parsed.arguments)
              : String(parsed.arguments || ''),
          },
        });
      }
    } catch (err) {
      textParts.push(match[0]);
    }
  }

  textParts.push(content.slice(lastIndex));

  return {
    content: toolCalls.length > 0 ? textParts.join('').trim() || null : content,
    toolCalls,
  };
}

function extractDeepSeekMessageId(chunk: any) {
  return chunk.response_message_id
    || chunk.message_id
    || chunk.v?.message_id
    || chunk.v?.response?.message_id
    || chunk.data?.message_id
    || chunk.data?.response?.message_id;
}

function findFirstStringByKey(value: unknown, keys: Set<string>): string {
  if (!value || typeof value !== 'object') return '';

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKey(item, keys);
      if (found) return found;
    }
    return '';
  }

  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof obj[key] === 'string') {
      return obj[key] as string;
    }
  }

  for (const nested of Object.values(obj)) {
    const found = findFirstStringByKey(nested, keys);
    if (found) return found;
  }

  return '';
}

function extractDeepSeekText(chunk: any): { text: string; path?: string } {
  if (typeof chunk.v === 'string') {
    return { text: chunk.v, path: chunk.p };
  }

  const value = chunk.v ?? chunk.data;
  if (value?.response?.fragments?.[0]?.content) {
    const frag = value.response.fragments[0];
    return {
      text: frag.content,
      path: frag.type === 'THINK' ? 'response/thinking_content' : 'response/content',
    };
  }

  if (Array.isArray(value) && value[0]?.content) {
    const frag = value[0];
    return {
      text: frag.content,
      path: frag.type === 'THINK' ? 'response/thinking_content' : 'response/content',
    };
  }

  const text = findFirstStringByKey(value, new Set([
    'content',
    'thinking_content',
    'reasoning_content',
    'text',
    'answer',
  ]));

  return { text, path: chunk.p };
}

function isThinkingPath(path: string) {
  return path.includes('thinking_content')
    || path.includes('reasoning_content')
    || path.includes('THINK');
}

function extractSseData(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('data:')) {
    return trimmed.slice(5).trimStart();
  }

  if (trimmed.startsWith('{') || trimmed === '[DONE]') {
    return trimmed;
  }

  return null;
}

async function collectCompletionResponse(
  dsStream: ReadableStream,
  completionId: string,
  model: string,
  promptTokens: number,
  uiSessionId: string
) {
  const reader = dsStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentAppendPath = '';
  let reasoningContent = '';
  let content = '';
  let completionTokens = 0;
  const debugChunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (!buffer) break;
    } else {
      buffer += decoder.decode(value, { stream: true });
    }

    const lines = buffer.split('\n');
    buffer = done ? '' : (lines.pop() || '');

    for (const line of lines) {
      const dataStr = extractSseData(line);
      if (!dataStr) continue;
      if (dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr);
        if (process.env.LOG_LEVEL === 'debug' && debugChunks.length < 20) {
          debugChunks.push(dataStr.slice(0, 1000));
        }

        const dsMessageId = extractDeepSeekMessageId(chunk);

        if (dsMessageId) {
          updateSessionParent(uiSessionId, dsMessageId);
        }

        if (typeof chunk.p === 'string') {
          currentAppendPath = chunk.p;
          if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
            completionTokens = chunk.v;
          }
        }

        const extracted = extractDeepSeekText(chunk);
        if (extracted.path) {
          currentAppendPath = extracted.path;
        }
        const valueText = extracted.text;

        if (!valueText || valueText === 'FINISHED') continue;

        if (isThinkingPath(currentAppendPath)) {
          reasoningContent += valueText;
        } else {
          content += valueText;
        }
      } catch (err) {
        // Ignore malformed or partial chunks.
      }
    }

    if (done) break;
  }

  if (!content && !reasoningContent && process.env.LOG_LEVEL === 'debug') {
    console.warn('[chat] DeepSeek stream produced no parsed content. Sample chunks:', debugChunks);
  }

  const { content: parsedContent, toolCalls } = extractToolCalls(content);
  const message: any = {
    role: 'assistant',
    content: parsedContent,
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: 0,
    },
  };

  return {
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [makeCompletionChoice(message, toolCalls.length > 0 ? 'tool_calls' : 'stop')],
    usage,
  };
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    
    // Extract the prompt
    let prompt = '';
    const messages = body.messages || [];
    let systemPrompt = '';
    
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system') {
        systemPrompt += contentStr + '\n\n';
      } else if (i === messages.length - 1) {
        if (msg.role === 'user') {
          prompt += `User: ${contentStr}\n\n`;
        } else if (msg.role === 'assistant') {
          let assistantContent = contentStr;
          if ((msg as any).reasoning_content) {
            assistantContent = `<think>\n${(msg as any).reasoning_content}\n</think>\n${assistantContent}`;
          }
          if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
             for (const tc of msg.tool_calls) {
               let args = tc.function?.arguments || '{}';
               if (typeof args !== 'string') args = JSON.stringify(args);
               assistantContent += `\n<tool_call>{"name": "${tc.function?.name}", "arguments": ${args}}</tool_call>`;
             }
          }
          prompt += `Assistant: ${assistantContent.trim()}\n\n`;
        } else if (msg.role === 'tool' || msg.role === 'function') {
          prompt += `Tool Response (${msg.name || 'tool'}): ${contentStr}\n\n`;
        }
      }
    }

    // Inject tools instructions
    const bodyAny = body as any;
    if (bodyAny.tools && Array.isArray(bodyAny.tools) && bodyAny.tools.length > 0) {
      // Better formatting for tools
      const formattedTools = bodyAny.tools.map((t: any) => {
        if (t.type === 'function') {
          return {
            name: t.function.name,
            description: t.function.description || '',
            parameters: t.function.parameters
          };
        }
        return t;
      });
      const toolsJson = JSON.stringify(formattedTools, null, 2);
      
      systemPrompt += `\n\n# TOOLS AVAILABLE\nYou have access to the following tools:\n${toolsJson}\n\nTo use a tool, you MUST output a JSON object wrapped EXACTLY in these tags:\n<tool_call>\n{"name": "tool_name", "arguments": {"param_name": "value"}}\n</tool_call>\n\nRULES:\n1. You can call multiple tools by outputting multiple <tool_call> blocks consecutively.\n2. Do NOT output any other text after your <tool_call> blocks. Wait for the user to provide the tool response.\n3. The JSON must be valid and accurately follow the tool's parameters.\n\n`;
      
      if (bodyAny.tool_choice && typeof bodyAny.tool_choice === 'object' && bodyAny.tool_choice.function) {
        const forcedTool = bodyAny.tool_choice.function.name;
        systemPrompt += `CRITICAL: You MUST call the tool "${forcedTool}" in this response.\n\n`;
      }
    }

    const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;

    const normalizedModel = body.model.toLowerCase();
    const isThinkingModel = normalizedModel.includes('reasoner')
      || (normalizedModel.includes('thinking') && !normalizedModel.includes('no-thinking'));
    
    // A session is new if it doesn't have any assistant messages yet.
    // This handles cases where the first request has [System, User] messages.
    const isNewSession = !messages.some(m => m.role === 'assistant');

    // Empty response retry logic
    let stream: ReadableStream | null = null;
    let uiSessionId = '';
    let retries = 3;
    while (retries > 0) {
      try {
        // If it's a new session, force parent_message_id to null
        const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isNewSession ? null : undefined);
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        break; // Success
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        // Wait a bit before retrying
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const completionId = 'chatcmpl-' + uuidv4();
    const promptTokens = Math.ceil(finalPrompt.length / 3.5);

    if (!stream) {
      throw new Error('Failed to initialize DeepSeek stream');
    }

    if (!isStream) {
      const response = await collectCompletionResponse(stream, completionId, body.model, promptTokens, uiSessionId);
      return c.json(response);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const makeChoice = (delta: any, finishReason: string | null = null) => ({
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      });

      // Send initial chunk
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({ role: 'assistant', content: '' })]
      });

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      
      let inThinkingState = false;
      let thinkingFragments: Record<string, boolean> = {};
      let currentFragIndex = 0;
      let currentAppendPath = '';
      
      let reasoningBuffer = '';
      let contentEmitBuffer = '';
      let insideTool = false;
      let emittedToolCallCount = 0;
      const TOOL_START = '<tool_call>';
      const TOOL_END = '</tool_call>';

      let buffer = '';
      let completionTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!buffer) break;
        } else {
          buffer += decoder.decode(value, { stream: true });
        }

        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() || '');

        for (const line of lines) {
          const dataStr = extractSseData(line);
          if (!dataStr) continue;
          if (dataStr === '[DONE]') {
            await streamWriter.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const chunk = JSON.parse(dataStr);

            const dsMessageId = extractDeepSeekMessageId(chunk);

            if (dsMessageId) {
              updateSessionParent(uiSessionId, dsMessageId);
            }

            if (typeof chunk.p === 'string') {
              currentAppendPath = chunk.p;
              if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
                completionTokens = chunk.v;
              }
            }

            const extracted = extractDeepSeekText(chunk);
            if (extracted.path) {
              currentAppendPath = extracted.path;
            }

            const vStr = extracted.text;
            const isThinkingChunk = isThinkingPath(currentAppendPath);

            if (vStr !== '') {
              if (vStr === 'FINISHED') continue;

              const delta: ChoiceDelta = {};
              
              // Map chunk to either reasoning_content or content
              if (isThinkingChunk) {
                inThinkingState = true;
                reasoningBuffer += vStr;
                delta.reasoning_content = vStr;

                await writeEvent({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model,
                  choices: [makeChoice(delta)]
                });
              } else {
                inThinkingState = false;
                contentEmitBuffer += vStr;

                while (contentEmitBuffer.length > 0) {
                  if (!insideTool) {
                    const startIdx = contentEmitBuffer.indexOf(TOOL_START);
                    if (startIdx !== -1) {
                      // Found tool start. Emit everything before it as text
                      const textToEmit = contentEmitBuffer.substring(0, startIdx);
                      if (textToEmit && emittedToolCallCount === 0) {
                        await writeEvent({
                          id: completionId,
                          object: 'chat.completion.chunk',
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [makeChoice({ content: textToEmit })]
                        });
                      }
                      insideTool = true;
                      contentEmitBuffer = contentEmitBuffer.substring(startIdx + TOOL_START.length);
                      continue; // re-evaluate loop for tool end
                    } else {
                      // No full start tag. Check for partial match at the end
                      let flushIndex = contentEmitBuffer.length;
                      for (let i = 1; i <= TOOL_START.length; i++) {
                        if (contentEmitBuffer.endsWith(TOOL_START.substring(0, i))) {
                          flushIndex = contentEmitBuffer.length - i;
                          break;
                        }
                      }
                      
                      const textToEmit = contentEmitBuffer.substring(0, flushIndex);
                      if (textToEmit && emittedToolCallCount === 0) {
                        await writeEvent({
                          id: completionId,
                          object: 'chat.completion.chunk',
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [makeChoice({ content: textToEmit })]
                        });
                      }
                      contentEmitBuffer = contentEmitBuffer.substring(flushIndex);
                      break; // wait for more chunks
                    }
                  } else {
                    // Inside tool
                    const endIdx = contentEmitBuffer.indexOf(TOOL_END);
                    if (endIdx !== -1) {
                      let toolJsonStr = contentEmitBuffer.substring(0, endIdx).trim();
                      try {
                        const toolCallObj = robustParseJSON(toolJsonStr);
                        if (!toolCallObj) throw new Error('Empty tool call');
                        
                        const toolId = 'call_' + uuidv4();
                        
                        await writeEvent({
                          id: completionId,
                          object: 'chat.completion.chunk',
                          created: Math.floor(Date.now() / 1000),
                          model: body.model,
                          choices: [makeChoice({
                            tool_calls: [{
                              index: emittedToolCallCount,
                              id: toolId,
                              type: 'function',
                              function: {
                                name: toolCallObj.name || '',
                                arguments: typeof toolCallObj.arguments === 'object'
                                  ? JSON.stringify(toolCallObj.arguments)
                                  : String(toolCallObj.arguments || '')
                              }
                            }]
                          })]
                        });
                        emittedToolCallCount++;
                      } catch (e) {
                        // Failed to parse tool call JSON, emit as regular text
                        if (emittedToolCallCount === 0) {
                          await writeEvent({
                            id: completionId,
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: body.model,
                            choices: [makeChoice({ content: TOOL_START + toolJsonStr + TOOL_END })]
                          });
                        }
                      }
                      
                      insideTool = false;
                      contentEmitBuffer = contentEmitBuffer.substring(endIdx + TOOL_END.length);
                    } else {
                      // Waiting for TOOL_END, buffer the content
                      break;
                    }
                  }
                }
              }
            }
          } catch (e) {
            // parse error, ignore partial chunk
          }
        }

        if (done) break;
      }

      // Flush any remaining content emit buffer
      if (!insideTool && contentEmitBuffer.length > 0 && emittedToolCallCount === 0) {
        await writeEvent({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({ content: contentEmitBuffer })]
        });
      }
  
      // Send finish reason
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: {
          cached_tokens: 0 // Mock cache compatibility
        }
      };
  
      const finalFinishReason = emittedToolCallCount > 0 ? 'tool_calls' : 'stop';
  
      await writeEvent({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [makeChoice({}, finalFinishReason)],
        usage: usage
      });
      await streamWriter.write('data: [DONE]\n\n');

    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    return c.json({ error: { message: err.message } }, 500);
  }
}
