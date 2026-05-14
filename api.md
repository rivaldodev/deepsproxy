# DeepsProxy API

Referencia das rotas HTTP expostas pelo DeepsProxy. A API e parcialmente compativel com OpenAI e encaminha as geracoes para a interface/API web do DeepSeek usando uma sessao Playwright autenticada.

## Base URL

Rede interna:

```text
http://deepsproxy:3000
```

Com prefixo OpenAI-compatible:

```text
http://deepsproxy:3000/v1
```

Para desenvolvimento local fora da rede interna, substitua `deepsproxy` por `localhost`.

As rotas OpenAI-compatible tambem existem sem `/v1` por compatibilidade interna:

```text
/chat/completions
/responses
/models
```

## Autenticacao

Se `API_KEY` estiver configurada no ambiente, todas as rotas protegidas exigem uma chave.

Headers aceitos:

```http
Authorization: Bearer SUA_API_KEY
```

ou:

```http
X-API-Key: SUA_API_KEY
```

Resposta em caso de falha:

```json
{ "error": "Unauthorized" }
```

Status: `401`

Observacao: as rotas `/login/*` tambem aceitam `?key=SUA_API_KEY`, alem dos headers acima.

## Modelos

Modelos expostos:

```text
deepseek-thinking
deepseek-no-thinking
```

`deepseek-thinking` ativa `thinking_enabled` no payload enviado ao DeepSeek. `deepseek-no-thinking` desativa o modo thinking.

## GET /health

Health check simples.

### Resposta

```json
{
  "status": "ok"
}
```

## GET /v1/models

Lista modelos disponiveis.

Alias:

```text
GET /models
```

### Resposta

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-thinking",
      "object": "model",
      "created": 1778760000,
      "owned_by": "deepseek",
      "permission": [],
      "root": "deepseek-thinking",
      "parent": null
    },
    {
      "id": "deepseek-no-thinking",
      "object": "model",
      "created": 1778760000,
      "owned_by": "deepseek",
      "permission": [],
      "root": "deepseek-no-thinking",
      "parent": null
    }
  ]
}
```

## GET /v1/models/:model

Retorna um objeto de modelo OpenAI-compatible para o id solicitado. A rota nao valida se o id existe.

Alias:

```text
GET /models/:model
```

### Exemplo

```http
GET /v1/models/deepseek-thinking
```

### Resposta

```json
{
  "id": "deepseek-thinking",
  "object": "model",
  "created": 1778760000,
  "owned_by": "deepseek",
  "permission": [],
  "root": "deepseek-thinking",
  "parent": null
}
```

## POST /v1/chat/completions

Endpoint compativel com Chat Completions.

Alias:

```text
POST /chat/completions
```

### Request

```json
{
  "model": "deepseek-thinking",
  "messages": [
    { "role": "user", "content": "Explique TypeScript em uma frase." }
  ],
  "stream": false
}
```

Campos suportados:

| Campo | Tipo | Obrigatorio | Descricao |
| --- | --- | --- | --- |
| `model` | string | Sim | `deepseek-thinking` ou `deepseek-no-thinking`. |
| `messages` | array | Sim | Mensagens no formato Chat Completions. O proxy envia principalmente a ultima mensagem nao-system ao DeepSeek. |
| `stream` | boolean | Nao | Se `true`, retorna Server-Sent Events. Default: `false`. |
| `tools` | array | Nao | Schemas de functions no formato OpenAI. O proxy instrui o modelo a emitir `<tool_call>`. |
| `tool_choice` | string/object | Nao | Quando objeto `{ type: "function", function: { name } }`, instrui o modelo a chamar essa tool. |

### Mensagens

Exemplo com system e user:

```json
{
  "model": "deepseek-no-thinking",
  "messages": [
    { "role": "system", "content": "Responda em portugues." },
    { "role": "user", "content": "Ola!" }
  ]
}
```

Mensagens `tool` e `function` sao convertidas para o prompt como:

```text
Tool Response (nome_da_tool): conteudo
```

### Resposta sem streaming

```json
{
  "id": "chatcmpl-uuid",
  "object": "chat.completion",
  "created": 1778760000,
  "model": "deepseek-thinking",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "TypeScript e JavaScript com tipos estaticos opcionais."
      },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 8,
    "total_tokens": 20,
    "prompt_tokens_details": {
      "cached_tokens": 0
    }
  }
}
```

Quando o modelo retorna reasoning em `deepseek-thinking`, a mensagem pode incluir:

```json
{
  "role": "assistant",
  "content": "Resposta final.",
  "reasoning_content": "Raciocinio retornado pelo DeepSeek."
}
```

### Resposta com tool call

Quando o modelo emite um bloco `<tool_call>`, o proxy converte para `tool_calls`.

```json
{
  "id": "chatcmpl-uuid",
  "object": "chat.completion",
  "created": 1778760000,
  "model": "deepseek-no-thinking",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_uuid",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\":\"Fortaleza\"}"
            }
          }
        ]
      },
      "logprobs": null,
      "finish_reason": "tool_calls"
    }
  ],
  "usage": {
    "prompt_tokens": 42,
    "completion_tokens": 10,
    "total_tokens": 52,
    "prompt_tokens_details": {
      "cached_tokens": 0
    }
  }
}
```

Importante: em `/v1/chat/completions`, o proxy apenas retorna `tool_calls`; a execucao da tool deve ser feita pelo cliente.

### Streaming

Request:

```json
{
  "model": "deepseek-thinking",
  "messages": [
    { "role": "user", "content": "Conte ate 3." }
  ],
  "stream": true
}
```

Headers de resposta:

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Eventos seguem o formato de chunks de Chat Completions:

```text
data: {"id":"chatcmpl-uuid","object":"chat.completion.chunk","created":1778760000,"model":"deepseek-thinking","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-uuid","object":"chat.completion.chunk","created":1778760000,"model":"deepseek-thinking","choices":[{"index":0,"delta":{"content":"1, 2, 3"},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-uuid","object":"chat.completion.chunk","created":1778760000,"model":"deepseek-thinking","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":0}}}

data: [DONE]
```

Em modo thinking, chunks podem conter:

```json
{
  "choices": [
    {
      "delta": {
        "reasoning_content": "..."
      }
    }
  ]
}
```

## POST /v1/responses

Endpoint compativel com a Responses API em formato simplificado.

Alias:

```text
POST /responses
```

### Request simples

```json
{
  "model": "deepseek-no-thinking",
  "input": "Responda apenas OK."
}
```

### Request com instructions

```json
{
  "model": "deepseek-thinking",
  "instructions": "Responda em portugues.",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Explique HTTP." }
      ]
    }
  ]
}
```

Campos suportados:

| Campo | Tipo | Obrigatorio | Descricao |
| --- | --- | --- | --- |
| `model` | string | Sim | `deepseek-thinking` ou `deepseek-no-thinking`. |
| `input` | string/object/array | Nao | Entrada no estilo Responses API. |
| `messages` | array | Nao | Alternativa a `input`. |
| `instructions` | string | Nao | Texto de sistema anexado antes do prompt. |
| `stream` | boolean | Nao | Se `true`, retorna eventos SSE no formato Responses. |
| `tools` | array | Nao | Functions no formato OpenAI ou estrutura equivalente. |
| `tool_choice` | object | Nao | Pode forcar uma function por `tool_choice.function.name` ou `tool_choice.name`. |
| `auto_execute_tools` | boolean | Nao | Executa automaticamente apenas tools registradas localmente no servidor. |
| `max_tool_turns` | number | Nao | Limite de iteracoes quando `auto_execute_tools` esta ativo. Default: `10`, maximo efetivo: `25`. |

### Resposta sem streaming

```json
{
  "id": "resp_uuid",
  "object": "response",
  "created_at": 1778760000,
  "status": "completed",
  "error": null,
  "incomplete_details": null,
  "model": "deepseek-no-thinking",
  "output": [
    {
      "id": "msg_uuid",
      "type": "message",
      "status": "completed",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "OK",
          "annotations": []
        }
      ]
    }
  ],
  "output_text": "OK",
  "usage": {
    "input_tokens": 8,
    "output_tokens": 2,
    "total_tokens": 10
  }
}
```

### Tool calls em Responses

Quando o modelo chama uma tool e `auto_execute_tools` nao esta ativo, `output` contem `function_call`:

```json
{
  "id": "resp_uuid",
  "object": "response",
  "status": "completed",
  "model": "deepseek-no-thinking",
  "output": [
    {
      "id": "fc_uuid",
      "type": "function_call",
      "call_id": "call_uuid",
      "name": "get_weather",
      "arguments": "{\"location\":\"Fortaleza\"}"
    }
  ],
  "output_text": "",
  "usage": {
    "input_tokens": 40,
    "output_tokens": 8,
    "total_tokens": 48
  }
}
```

### Auto-execucao de tools em Responses

`/v1/responses` tem um modo opt-in para executar automaticamente tools registradas localmente no `registry` do servidor.

Ativacao por body:

```json
{
  "model": "deepseek-no-thinking",
  "input": "Use a tool local.",
  "auto_execute_tools": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "minha_tool",
        "description": "Tool registrada no servidor",
        "parameters": {
          "type": "object",
          "properties": {},
          "required": []
        }
      }
    }
  ]
}
```

Ativacao por header:

```http
X-Auto-Execute-Tools: true
```

Ativacao global por ambiente:

```env
AUTO_EXECUTE_TOOLS=true
```

Regras:

- O servidor so executa tools que existem no `registry`.
- Se qualquer tool chamada nao estiver registrada localmente, a resposta volta como `function_call` para o cliente executar.
- O loop adiciona `Tool Response (nome): resultado` no prompt e chama o modelo novamente ate obter texto final ou atingir `max_tool_turns`.

### Streaming de Responses

Request:

```json
{
  "model": "deepseek-no-thinking",
  "input": "Diga ola.",
  "stream": true
}
```

Eventos:

```text
data: {"type":"response.created","response":{"id":"resp_uuid","object":"response","status":"in_progress","model":"deepseek-no-thinking"}}

data: {"type":"response.output_text.delta","delta":"Ola!"}

data: {"type":"response.completed","response":{"id":"resp_uuid","object":"response","created_at":1778760000,"status":"completed","model":"deepseek-no-thinking","output":[...],"output_text":"Ola!","usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}}

data: [DONE]
```

Observacao: o streaming de `/v1/responses` coleta a resposta do DeepSeek e depois emite os eventos do proxy. Ele nao necessariamente encaminha token a token em tempo real.

## Rotas de Login Playwright

Essas rotas ajudam a autenticar a sessao do DeepSeek dentro do navegador Playwright usado pelo proxy.

Se `API_KEY` estiver ativa, use:

```text
/login?key=SUA_API_KEY
```

ou os headers normais de autenticacao.

## GET /login

Retorna uma pagina HTML simples com screenshot do navegador e controles de clique/teclado.

Uso comum:

```text
https://SEU_DOMINIO/login?key=SUA_API_KEY
```

## GET /login/screenshot

Retorna PNG da tela atual do navegador.

Resposta:

```http
Content-Type: image/png
Cache-Control: no-store
```

## POST /login/click

Envia um clique para o navegador.

### Request

```json
{
  "x": 100,
  "y": 200
}
```

### Resposta

```json
{
  "ok": true
}
```

Erro de coordenadas invalidas:

```json
{
  "error": "Invalid coordinates"
}
```

Status: `400`

## POST /login/type

Digita texto no campo focado do navegador.

### Request

```json
{
  "text": "texto para digitar"
}
```

### Resposta

```json
{
  "ok": true
}
```

## POST /login/key

Pressiona uma tecla permitida.

### Request

```json
{
  "key": "Enter"
}
```

Teclas aceitas:

```text
Enter
Tab
Escape
Backspace
Delete
ArrowUp
ArrowDown
ArrowLeft
ArrowRight
```

### Resposta

```json
{
  "ok": true
}
```

Erro de tecla invalida:

```json
{
  "error": "Invalid key"
}
```

Status: `400`

## Erros

Rota inexistente:

```json
{
  "error": {
    "message": "Route not found: GET /rota",
    "type": "invalid_request_error",
    "code": "route_not_found"
  }
}
```

Status: `404`

Erro interno em `/v1/chat/completions` ou `/v1/responses`:

```json
{
  "error": {
    "message": "mensagem do erro"
  }
}
```

Status: `500`

## Exemplos

### Chat Completions com curl

```bash
curl http://deepsproxy:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -d '{
    "model": "deepseek-no-thinking",
    "messages": [
      { "role": "user", "content": "Ola!" }
    ]
  }'
```

### Responses API com curl

```bash
curl http://deepsproxy:3000/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -d '{
    "model": "deepseek-thinking",
    "instructions": "Responda de forma curta.",
    "input": "Explique proxy HTTP."
  }'
```

### OpenAI SDK Node.js

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://deepsproxy:3000/v1",
  apiKey: process.env.API_KEY || "not-required"
});

const completion = await client.chat.completions.create({
  model: "deepseek-no-thinking",
  messages: [
    { role: "user", content: "Ola!" }
  ]
});

console.log(completion.choices[0].message.content);
```

### OpenAI SDK Python

```py
from openai import OpenAI

client = OpenAI(
    base_url="http://deepsproxy:3000/v1",
    api_key="not-required",
)

completion = client.chat.completions.create(
    model="deepseek-no-thinking",
    messages=[
        {"role": "user", "content": "Ola!"}
    ],
)

print(completion.choices[0].message.content)
```

## Notas de Integracao

- A estimativa de tokens e aproximada, baseada no tamanho do prompt quando o DeepSeek nao informa uso acumulado.
- `created` e `created_at` usam timestamp Unix em segundos.
- Para usar tool calling em Chat Completions, implemente no cliente o ciclo: receber `tool_calls`, executar a tool, enviar nova mensagem `tool` com o resultado.
- Para auto-executar tools no servidor, prefira `/v1/responses` com `auto_execute_tools: true` e registre as tools localmente no `registry`.
- O proxy depende de uma sessao Playwright logada no DeepSeek. Use `/login` quando a sessao expirar ou quando subir em um ambiente novo.

## Tool Local: Web Search

O servidor registra automaticamente uma tool local chamada `web_search`.

Ela consulta o SearXNG interno:

```text
http://searxng:8080/search?q=TERMO_URLENCODE&format=json
```

Configuracao por ambiente:

```env
SEARXNG_SEARCH_URL=http://searxng:8080/search
SEARXNG_TIMEOUT_MS=15000
```

Schema da tool:

```json
{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "Search the web using SearXNG and return relevant result titles, URLs, and snippets.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "The web search query.",
          "minLength": 1
        },
        "limit": {
          "type": "integer",
          "description": "Maximum number of results to return. Default is 5, maximum is 10.",
          "minimum": 1,
          "maximum": 10,
          "default": 5
        }
      },
      "required": ["query"]
    }
  }
}
```

Para fazer a IA pesquisar e receber os dados automaticamente, use `/v1/responses` com `auto_execute_tools: true`.

Exemplo:

```bash
curl http://deepsproxy:3000/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -d '{
    "model": "deepseek-no-thinking",
    "auto_execute_tools": true,
    "input": "Pesquise na web por noticias recentes sobre TypeScript e resuma com fontes."
  }'
```

Tambem e possivel ativar a auto-execucao globalmente:

```env
AUTO_EXECUTE_TOOLS=true
```

Resposta da tool para a IA:

```json
{
  "query": "noticias recentes sobre TypeScript",
  "results": [
    {
      "title": "Titulo do resultado",
      "url": "https://exemplo.com/post",
      "content": "Snippet retornado pelo SearXNG",
      "score": 1,
      "engine": "google",
      "publishedDate": "2026-05-14"
    }
  ],
  "answers": [],
  "suggestions": [],
  "number_of_results": 123
}
```
