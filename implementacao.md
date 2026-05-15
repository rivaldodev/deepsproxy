# Implementacao desde `62ed1fee4c3be18e2ef56b5df12cb295c585edf9`

Este documento resume as mudancas feitas apos o commit:

```text
62ed1fee4c3be18e2ef56b5df12cb295c585edf9
```

Objetivo: servir como guia para portar as mesmas funcionalidades para outro projeto.

## Resumo Das Mudancas

Foram adicionados ou alterados estes blocos principais:

- Rota `/v1/models/:model`, alem da listagem `/v1/models`.
- Alias sem `/v1`: `/models`, `/responses`, `/chat/completions`.
- Rota `/v1/responses` compativel com Responses API simplificada.
- Auto-execucao opcional de tools em `/v1/responses`.
- Tool local `web_search` usando SearXNG interno.
- Registro automatico da tool `web_search` no boot.
- Documentacao completa em `api.md`.
- Ajustes no Docker para rede interna (`expose` em vez de `ports`).
- Configs de SearXNG em `.env.example` e `docker-compose.yml`.
- Suporte opcional a `DEEPSEEK_MODEL_TYPE`, mas deve ficar unset por padrao porque `expert` bugou.
- Melhoria no `/v1/chat/completions` para suportar resposta nao-streaming.
- Testes para models, responses, auto-execucao de tools e web search.

## Ordem Recomendada

1. Adicionar `src/routes/models.ts`.
2. Adicionar `src/routes/responses.ts`.
3. Adicionar `src/tools/webSearch.ts`.
4. Registrar models, responses e web search em `src/index.ts`.
5. Ajustar `src/routes/chat.ts` para resposta nao-streaming.
6. Ajustar `src/services/deepseek.ts` com `DEEPSEEK_MODEL_TYPE` opcional, mantendo `null` por padrao.
7. Atualizar `.env.example` e `docker-compose.yml`.
8. Adicionar testes.
9. Criar ou atualizar documentacao da API.

## Arquivos Novos

### `src/routes/models.ts`

Adiciona router Hono para modelos.

Rotas:

```text
GET /v1/models
GET /v1/models/:model
GET /models
GET /models/:model
```

Modelos expostos:

```ts
const MODEL_IDS = [
  'deepseek-thinking',
  'deepseek-no-thinking',
];
```

Formato de cada modelo:

```ts
{
  id,
  object: 'model',
  created: Math.floor(Date.now() / 1000),
  owned_by: 'deepseek',
  permission: [],
  root: id,
  parent: null,
}
```

Observacao: `GET /:model` nao valida se o modelo existe; apenas retorna um objeto compativel para o id solicitado.

### `src/routes/responses.ts`

Implementa `/v1/responses` e `/responses`.

Campos aceitos:

```ts
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
```

Responsabilidades:

- Converter `input`, `messages` e `instructions` para prompt textual.
- Injetar definicoes de tools no prompt.
- Coletar stream do DeepSeek.
- Converter blocos `<tool_call>...</tool_call>` em `function_call`.
- Quando `auto_execute_tools` estiver ativo, executar tools registradas localmente.
- Reenviar `Tool Response (...)` ao modelo ate obter resposta final.
- Retornar formato Responses API simplificado.
- Suportar SSE para `stream: true`.

Ativacao de auto-execucao:

```json
{
  "auto_execute_tools": true
}
```

ou header:

```http
X-Auto-Execute-Tools: true
```

ou ambiente:

```env
AUTO_EXECUTE_TOOLS=true
```

Regras importantes:

- O servidor so executa tools presentes no `registry`.
- Se o modelo chamar tool nao registrada, a resposta volta como `function_call` para o cliente executar.
- Quando `auto_execute_tools` esta ativo, as tools do `registry` sao automaticamente adicionadas ao prompt.
- `max_tool_turns` tem default `10` e limite efetivo `25`.

Normalizacao adicionada:

- Se a resposta final vier como:

```text
SEARCHING{ "message": "...", "fontes": [...] }
```

ela e transformada em texto final normal:

```md
...

## Fontes
- https://...
```

Isso evita vazar JSON final para a aplicacao cliente quando o modelo confunde o formato da chamada de tool com o formato da resposta final.

### `src/tools/webSearch.ts`

Registra a tool local:

```text
web_search
```

Ela consulta o SearXNG:

```text
http://searxng:8080/search?q={query_urlencoded}&format=json
```

Variaveis:

```env
SEARXNG_SEARCH_URL=http://searxng:8080/search
SEARXNG_TIMEOUT_MS=15000
```

Schema da tool:

```json
{
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
```

Resposta simplificada da tool:

```ts
{
  query,
  results: [
    {
      title,
      url,
      content,
      score,
      engine,
      publishedDate,
    }
  ],
  answers,
  suggestions,
  number_of_results,
}
```

Comportamento de erro:

- Timeout retorna objeto com `error`.
- HTTP status nao-ok retorna `error` e `details`.
- Erros de fetch tambem retornam `error`.
- A tool nao joga erro para fora em falhas de busca; ela retorna erro serializado para a IA conseguir responder.

## Arquivos Alterados

### `src/index.ts`

Novos imports:

```ts
import { models } from './routes/models.ts';
import { responses } from './routes/responses.ts';
import { registerWebSearchTool } from './tools/webSearch.ts';
```

Depois de carregar dotenv:

```ts
dotenv.config();
registerWebSearchTool();
```

Novas rotas:

```ts
app.post('/v1/responses', responses);
app.route('/v1/models', models);
app.post('/chat/completions', chatCompletions);
app.post('/responses', responses);
app.route('/models', models);
```

Foi adicionado handler `notFound` OpenAI-like:

```ts
app.notFound((c) => {
  return c.json({
    error: {
      message: `Route not found: ${c.req.method} ${new URL(c.req.url).pathname}`,
      type: 'invalid_request_error',
      code: 'route_not_found',
    },
  }, 404);
});
```

### `src/routes/chat.ts`

Mudancas principais:

- Adicionado suporte a resposta nao-streaming.
- Adicionado parser de `<tool_call>` para converter em `tool_calls`.
- Adicionado `reasoning_content` quando DeepSeek retorna chunks de thinking.
- Uso de `finish_reason: "tool_calls"` quando ha tool calls.
- Uso de `prompt_tokens_details.cached_tokens = 0`.
- Deteccao de modelo thinking mais explicita:

```ts
const normalizedModel = body.model.toLowerCase();
const isThinkingModel = normalizedModel.includes('reasoner')
  || (normalizedModel.includes('thinking') && !normalizedModel.includes('no-thinking'));
```

O fluxo de Chat Completions continua assim:

- Sem `stream`: coleta todo o stream do DeepSeek e retorna `chat.completion`.
- Com `stream`: emite `chat.completion.chunk` via SSE.
- Tools em Chat Completions nao sao executadas no servidor; sao apenas retornadas ao cliente como `tool_calls`.

### `src/services/deepseek.ts`

Foi adicionado suporte opcional a `DEEPSEEK_MODEL_TYPE`:

```ts
function getModelType(): string | null {
  return process.env.DEEPSEEK_MODEL_TYPE?.trim() || null;
}
```

Payload:

```ts
model_type: getModelType(),
```

Importante:

- Nao definir `DEEPSEEK_MODEL_TYPE` por padrao.
- Quando unset, o payload continua equivalente ao comportamento estavel: `model_type: null`.
- Foi testado `DEEPSEEK_MODEL_TYPE=expert`, mas causou respostas vazias/bugadas em alguns cenarios. Portanto, manter fora da env de producao.

### `src/routes/login.ts`

Pequena correcao no endpoint de screenshot:

```ts
const screenshot = await page.screenshot({ type: 'png', fullPage: false });
const image = new Uint8Array(screenshot.byteLength);
image.set(screenshot);

return c.body(image, 200, {
  'Content-Type': 'image/png',
  'Cache-Control': 'no-store',
});
```

Motivo: garantir corpo binario em formato aceito pelo Hono/runtime.

### `docker-compose.yml`

Mudanca de exposicao de porta:

Antes:

```yaml
ports:
  - "3000:3000"
```

Depois:

```yaml
expose:
  - "3000"
```

Motivo: a aplicacao sera consumida por rede interna, por exemplo:

```text
http://deepsproxy:3000/v1
```

Novas envs:

```yaml
- SEARXNG_SEARCH_URL=${SEARXNG_SEARCH_URL:-http://searxng:8080/search}
- SEARXNG_TIMEOUT_MS=${SEARXNG_TIMEOUT_MS:-15000}
```

### `.env.example`

Adicionar:

```env
# Web search tool (SearXNG)
SEARXNG_SEARCH_URL=http://searxng:8080/search
SEARXNG_TIMEOUT_MS=15000
```

Nao adicionar `DEEPSEEK_MODEL_TYPE=expert` no `.env` de producao.

### `README.md`

Atualizar exemplo Docker para usar:

```yaml
expose:
  - "3000"
```

em vez de `ports`.

### `api.md`

Foi criado um documento completo de referencia da API.

Base URL interna documentada:

```text
http://deepsproxy:3000/v1
```

Inclui:

- Autenticacao.
- Models.
- Chat Completions.
- Responses.
- Streaming.
- Login Playwright.
- Tool local `web_search`.
- Exemplos curl, Node e Python.

## Contratos De API Novos

### Responses Simples

Request:

```json
{
  "model": "deepseek-no-thinking",
  "input": "Responda apenas OK."
}
```

Response:

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

### Responses Com Web Search

Request recomendado para outro projeto:

```json
{
  "model": "deepseek-no-thinking",
  "auto_execute_tools": true,
  "input": "Pesquise na web por noticias recentes sobre TypeScript e resuma com fontes."
}
```

O modelo recebe automaticamente a tool `web_search` porque `auto_execute_tools` inclui tools do `registry` no prompt.

### Header Alternativo

```http
X-Auto-Execute-Tools: true
```

### Chat Completions Nao-Streaming

Request:

```json
{
  "model": "deepseek-thinking",
  "messages": [
    { "role": "user", "content": "Ola!" }
  ],
  "stream": false
}
```

Response:

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
        "content": "..."
      },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15,
    "prompt_tokens_details": {
      "cached_tokens": 0
    }
  }
}
```

## Tests Adicionados

### `src/index.test.ts`

Foram adicionados testes para:

- `GET /v1/models/:model`.
- Registro da rota `/v1/responses`.
- Payload default com `model_type: null`.
- `DEEPSEEK_MODEL_TYPE` opcional via env.

Observacao: o teste antigo de streaming thinking pode falhar dependendo da resposta real/mocada do DeepSeek, porque espera `reasoning_content`.

### `src/advanced.test.ts`

Foram adicionados testes para:

- Tool `web_search` montando URL SearXNG com query URL-encoded.
- Auto-execucao de tools registradas em `/v1/responses`.
- Reenvio de `Tool Response (...)` ao modelo.
- Normalizacao de resposta final `SEARCHING{ "message": ..., "fontes": [...] }`.

Comandos usados:

```bash
bun run build
bun test ./src/advanced.test.ts
```

Resultado esperado atual:

```text
build ok
advanced.test.ts ok
```

## Cuidados Conhecidos

### `DEEPSEEK_MODEL_TYPE=expert`

Nao ativar em producao.

Foi implementado suporte opcional, mas quando `expert` foi habilitado no ambiente, o DeepSeek passou a retornar respostas vazias ou bugadas em alguns fluxos.

Estado recomendado:

```env
# nao definir DEEPSEEK_MODEL_TYPE
```

### Tool Calling Em Chat Completions

`/v1/chat/completions` nao auto-executa tools.

Ele apenas retorna:

```json
{
  "tool_calls": [...]
}
```

O cliente precisa executar a tool e reenviar uma mensagem `tool`.

Para auto-execucao no servidor, usar:

```text
POST /v1/responses
```

com:

```json
{
  "auto_execute_tools": true
}
```

### Dependencia De Login DeepSeek

O proxy ainda depende da sessao Playwright logada no DeepSeek. A rota `/login` continua sendo necessaria quando a sessao expirar ou em deploy novo.

### Rede Interna

O outro projeto deve chamar:

```text
http://deepsproxy:3000/v1
```

desde que ambos estejam na mesma rede Docker/Coolify.

SearXNG deve estar acessivel como:

```text
http://searxng:8080/search
```

ou configure:

```env
SEARXNG_SEARCH_URL=http://nome-do-servico:8080/search
```

## Checklist De Portabilidade

- [ ] Copiar `src/routes/models.ts`.
- [ ] Copiar `src/routes/responses.ts`.
- [ ] Copiar `src/tools/webSearch.ts`.
- [ ] Registrar `models`, `responses` e `registerWebSearchTool()` em `src/index.ts`.
- [ ] Garantir que `src/tools/registry.ts`, `src/tools/executor.ts` e `src/utils/json.ts` existam no projeto destino.
- [ ] Atualizar `src/routes/chat.ts` se o projeto destino ainda nao tiver resposta nao-streaming.
- [ ] Adicionar envs SearXNG.
- [ ] Usar `expose: "3000"` se o consumo for por rede interna.
- [ ] Manter `DEEPSEEK_MODEL_TYPE` unset.
- [ ] Adicionar testes equivalentes.
- [ ] Documentar base URL interna `http://deepsproxy:3000/v1`.

## Commits Incluidos No Intervalo

Principais commits apos `62ed1fee`:

```text
5e250a8 fix: return Uint8Array for screenshot response in /screenshot route
694002a fix: change ports to expose in docker-compose for deepsproxy service
f6742ee feat: add models route to retrieve OpenAI-compatible model objects
caad1d4 feat: add responses endpoint for handling model responses
9d981aa feat: enhance responses endpoint to support structured input and capture prompts
d269ee1 feat: implement auto-execution of registered tools in responses endpoint
323098e feat: add DEEPSEEK_MODEL_TYPE environment variable and update payload structure
1ed76fe / 13abbdd parser experiments, later reverted
b09d327 / e43dc37 / c1a99eb reverts dos experimentos problematicos
42b888c feat: implement dynamic model_type retrieval from environment variable
c4a8acf feat: add web search tool integration with SearXNG and update environment configuration
8839fa9 feat: enhance tool response handling and normalize assistant text output
```

Os commits de parser SSE foram revertidos porque causaram comportamento instavel no deploy.
