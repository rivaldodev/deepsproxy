# Fix Problems - DeepsProxy / API OpenAI-Compatible

Este documento lista problemas reais que apareceram durante a implementacao do DeepsProxy e como corrigir em outro projeto com arquitetura parecida.

## 1. LangChain `MODEL_NOT_FOUND`

Erro visto:

```text
The resource you are requesting could not be found
404 404 Not Found
Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_NOT_FOUND/
```

### Causa Provavel

O cliente LangChain/OpenAI SDK tentou consultar ou usar um modelo que a API proxy nao expunha corretamente.

Casos comuns:

- Faltava `GET /v1/models/:model`.
- So existia `GET /v1/models`, mas nao a rota por id.
- A base URL estava errada.
- O projeto cliente usava modelo como `gpt-4o`, `deepseek-chat` ou outro id nao listado.
- A rota sem `/v1` era usada por algum cliente, mas nao existia alias.

### Fix

Criar uma rota dedicada de models.

Arquivo:

```text
src/routes/models.ts
```

Implementacao:

```ts
import { Hono } from 'hono';

const models = new Hono();

const MODEL_IDS = [
  'deepseek-thinking',
  'deepseek-no-thinking',
];

function modelObject(id: string) {
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'deepseek',
    permission: [],
    root: id,
    parent: null,
  };
}

models.get('/', (c) => {
  return c.json({
    object: 'list',
    data: MODEL_IDS.map(modelObject),
  });
});

models.get('/:model', (c) => {
  const id = c.req.param('model');
  return c.json(modelObject(id));
});

export { models, MODEL_IDS };
```

Registrar:

```ts
app.route('/v1/models', models);
app.route('/models', models);
```

### Config Do Cliente

Use exatamente um modelo exposto:

```text
deepseek-thinking
deepseek-no-thinking
```

Base URL na rede interna:

```text
http://deepsproxy:3000/v1
```

Exemplo LangChain/OpenAI-compatible:

```ts
model: "deepseek-no-thinking"
```

Nao usar:

```text
gpt-4o
gpt-3.5-turbo
deepseek-chat
deepseek-reasoner
```

a menos que sua API tambem exponha esses ids.

## 2. Base URL Errada Em Rede Interna

### Sintoma

- 404.
- `ECONNREFUSED`.
- LangChain acusa modelo inexistente.
- Cliente chama localhost mas esta em outro container.

### Causa

Dentro de outro container, `localhost` aponta para o proprio container, nao para o DeepsProxy.

### Fix

Usar nome do servico na rede Docker/Coolify:

```text
http://deepsproxy:3000/v1
```

No `docker-compose.yml` do DeepsProxy:

```yaml
services:
  deepsproxy:
    expose:
      - "3000"
    networks:
      - coolify

networks:
  coolify:
    external: true
    name: ${COOLIFY_NETWORK:-coolify}
```

No outro projeto, ele precisa estar na mesma rede:

```yaml
networks:
  - coolify
```

## 3. Porta Exposta Incorretamente

### Sintoma

- Funciona localmente, mas nao entre containers.
- Coolify nao resolve pelo nome interno.
- Porta publica desnecessaria.

### Causa

Uso de:

```yaml
ports:
  - "3000:3000"
```

quando a intencao era acesso interno.

### Fix

Usar:

```yaml
expose:
  - "3000"
```

E consumir por:

```text
http://deepsproxy:3000/v1
```

## 4. `model_type=expert` Quebra Respostas

### Sintoma

Resposta vazia:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": ""
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "completion_tokens": 0
  }
}
```

ou comportamento estranho no stream.

### Causa

Foi testado enviar:

```json
"model_type": "expert"
```

no payload para o DeepSeek. Isso bugou em alguns fluxos.

### Fix Seguro

Manter `model_type` como `null` por padrao.

Se quiser suporte opcional, implementar assim:

```ts
function getModelType(): string | null {
  return process.env.DEEPSEEK_MODEL_TYPE?.trim() || null;
}
```

Payload:

```ts
model_type: getModelType(),
```

E nao declarar `DEEPSEEK_MODEL_TYPE` em producao.

Evitar:

```env
DEEPSEEK_MODEL_TYPE=expert
```

## 5. Resposta Vazia Mesmo Com DeepSeek Respondendo Na UI

### Sintoma

Na UI do DeepSeek a resposta aparece, mas a API retorna:

```json
"content": ""
```

### Causas Possiveis

- Parser do stream nao reconheceu o formato dos chunks.
- Alteracoes experimentais no parser SSE quebraram compatibilidade.
- `model_type=expert` alterou o comportamento do DeepSeek.
- Stream retornou somente reasoning ou formato inesperado.

### O Que Aprendemos

Tentamos mudar o parser para aceitar formatos como:

- `data:{...}`
- JSON cru sem `data:`
- objetos aninhados
- buffer final sem newline

Mas no deploy isso continuou problematico. O rollback para o comportamento anterior estabilizou.

### Fix Pratico

1. Reverter alteracoes experimentais do parser.
2. Remover `DEEPSEEK_MODEL_TYPE=expert`.
3. Voltar para:

```ts
model_type: null
```

ou:

```ts
model_type: getModelType()
```

com env unset.

4. Validar com uma chamada simples:

```bash
curl http://deepsproxy:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -d '{
    "model": "deepseek-no-thinking",
    "messages": [
      { "role": "user", "content": "Diga OK" }
    ]
  }'
```

## 6. `/v1/responses` Nao Existe

### Sintoma

Cliente moderno tenta usar Responses API e recebe:

```json
{
  "error": {
    "message": "Route not found: POST /v1/responses",
    "type": "invalid_request_error",
    "code": "route_not_found"
  }
}
```

### Fix

Adicionar rota:

```ts
import { responses } from './routes/responses.ts';

app.post('/v1/responses', responses);
app.post('/responses', responses);
```

A rota deve:

- aceitar `input`;
- aceitar `instructions`;
- aceitar `stream`;
- converter tool calls;
- retornar objeto `response`.

## 7. Tool Calls Nao Sao Executadas

### Sintoma

O modelo "chama" uma tool, mas nada acontece.

Ou a resposta vem com:

```json
{
  "tool_calls": [...]
}
```

e o usuario acha que a API deveria executar.

### Causa

Em Chat Completions, o comportamento esperado e retornar `tool_calls` para o cliente executar.

No DeepsProxy:

- `/v1/chat/completions` nao auto-executa tools.
- `/v1/responses` pode auto-executar tools se `auto_execute_tools` estiver ativo.

### Fix

Para auto-execucao no servidor, usar:

```json
{
  "model": "deepseek-no-thinking",
  "auto_execute_tools": true,
  "input": "Pesquise na web e responda com fontes."
}
```

ou header:

```http
X-Auto-Execute-Tools: true
```

ou env:

```env
AUTO_EXECUTE_TOOLS=true
```

## 8. Tool De Web Search Nao Funciona

### Sintoma

- A IA tenta pesquisar, mas nao traz resultados.
- Tool retorna erro.
- Fetch para SearXNG falha.

### Causa

- SearXNG nao esta na mesma rede.
- Nome do servico nao e `searxng`.
- URL interna esta errada.
- `format=json` nao esta sendo enviado.

### Fix

Configurar:

```env
SEARXNG_SEARCH_URL=http://searxng:8080/search
SEARXNG_TIMEOUT_MS=15000
```

Tool deve chamar:

```ts
const url = new URL(searchEndpoint());
url.searchParams.set('q', query);
url.searchParams.set('format', 'json');
```

Teste rapido de dentro da mesma rede:

```bash
curl "http://searxng:8080/search?q=teste&format=json"
```

Se o servico tiver outro nome, ajustar:

```env
SEARXNG_SEARCH_URL=http://nome-correto:8080/search
```

## 9. Modelo Retorna `SEARCHING{...}` Ou JSON Final

### Sintoma

A resposta final vem assim:

```text
SEARCHING{ "message": "...", "codigo": "", "analise": "...", "fontes": [...] }
```

### Causa

O modelo confundiu:

- JSON usado para chamar tool;
- JSON usado pela aplicacao cliente;
- resposta final para usuario.

### Fix No Prompt

Nas instrucoes de tools, adicionar regras:

```text
RULES:
1. Use JSON only inside <tool_call> blocks.
2. After tool results are provided, write the final answer as normal user-facing text, not as a JSON object.
3. Do not prefix the final answer with SEARCHING, JSON, or status labels.
```

### Fix Defensivo No Backend

Normalizar resposta final:

```ts
function normalizeAssistantText(text: string) {
  const trimmed = text.trim();
  const withoutSearchPrefix = trimmed.replace(/^SEARCHING\s*/i, '').trim();
  if (!withoutSearchPrefix.startsWith('{')) return trimmed;

  try {
    const parsed = robustParseJSON(withoutSearchPrefix);
    if (!parsed || typeof parsed.message !== 'string') return trimmed;

    let finalText = parsed.message.trim();
    if (Array.isArray(parsed.fontes) && parsed.fontes.length > 0) {
      const sources = parsed.fontes
        .filter((source: unknown) => typeof source === 'string' && source.trim())
        .map((source: string) => `- ${source.trim()}`)
        .join('\n');

      if (sources && !finalText.includes('## Fontes')) {
        finalText += `\n\n## Fontes\n${sources}`;
      }
    }

    return finalText || trimmed;
  } catch {
    return trimmed;
  }
}
```

Usar quando nao ha mais tool calls e a resposta final sera retornada ao cliente.

## 10. `/login` Da 401

### Sintoma

Ao abrir:

```text
/login
```

retorna:

```text
Unauthorized
```

### Causa

`API_KEY` esta configurada e a rota `/login` tambem exige autenticacao.

### Fix

Abrir:

```text
https://SEU_DOMINIO/login?key=SUA_API_KEY
```

ou enviar header:

```http
Authorization: Bearer SUA_API_KEY
```

## 11. Timeout Esperando Campo Do DeepSeek

Erro comum:

```text
Timeout waiting for chat input. Are you logged in?
```

### Causa

O Playwright abriu DeepSeek, mas nao encontrou `textarea`.

Possiveis motivos:

- nao esta logado;
- sessao expirou;
- Cloudflare/desafio;
- pagina carregou tela diferente;
- perfil `deepseek_profile` foi apagado.

### Fix

1. Abrir:

```text
/login?key=SUA_API_KEY
```

2. Fazer login manualmente.
3. Garantir que a tela de chat apareceu.
4. Testar `/v1/chat/completions` novamente.

## 12. Screenshot Do Login Quebra

### Sintoma

`/login/screenshot` nao renderiza imagem corretamente.

### Fix

Converter screenshot para `Uint8Array` antes de responder:

```ts
const screenshot = await page.screenshot({ type: 'png', fullPage: false });
const image = new Uint8Array(screenshot.byteLength);
image.set(screenshot);

return c.body(image, 200, {
  'Content-Type': 'image/png',
  'Cache-Control': 'no-store',
});
```

## 13. Sessao Nao Persiste Apos Redeploy

### Sintoma

Todo deploy exige login novamente.

### Causa

Volume `deepseek_profile` nao esta persistido.

### Fix

No Docker Compose:

```yaml
volumes:
  - ./deepseek_profile:/app/deepseek_profile
```

No Coolify, garantir que o volume nao seja descartado em rebuild/redeploy.

## 14. Rota Inexistente Retorna HTML/Texto Em Vez De JSON

### Sintoma

Cliente OpenAI-compatible recebe erro estranho ao chamar rota errada.

### Fix

Adicionar handler:

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

## Checklist Para Outro Projeto

Use este checklist quando uma API parecida apresentar os mesmos problemas:

- [ ] `GET /v1/models` existe.
- [ ] `GET /v1/models/:model` existe.
- [ ] Modelo usado pelo cliente esta na lista.
- [ ] Base URL interna esta correta: `http://deepsproxy:3000/v1`.
- [ ] Containers estao na mesma rede.
- [ ] `docker-compose` usa `expose` para rede interna.
- [ ] `model_type` esta `null` ou env unset.
- [ ] `/v1/responses` existe se o cliente usa Responses API.
- [ ] Auto-execucao de tools esta ativa somente em `/v1/responses`.
- [ ] SearXNG esta acessivel por `http://searxng:8080/search`.
- [ ] `/login?key=...` funciona.
- [ ] `deepseek_profile` esta persistido.
- [ ] `notFound` retorna JSON estruturado.
- [ ] Teste simples de chat retorna `content` nao-vazio.
- [ ] Teste de web search retorna resultados.

## Testes Rapidos

### Models

```bash
curl http://deepsproxy:3000/v1/models \
  -H "Authorization: Bearer SUA_API_KEY"
```

```bash
curl http://deepsproxy:3000/v1/models/deepseek-no-thinking \
  -H "Authorization: Bearer SUA_API_KEY"
```

### Chat

```bash
curl http://deepsproxy:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -d '{
    "model": "deepseek-no-thinking",
    "messages": [
      { "role": "user", "content": "Diga apenas OK" }
    ]
  }'
```

### Responses Com Tool Search

```bash
curl http://deepsproxy:3000/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -d '{
    "model": "deepseek-no-thinking",
    "auto_execute_tools": true,
    "input": "Pesquise na web por TypeScript e responda com fontes."
  }'
```

### SearXNG Direto

```bash
curl "http://searxng:8080/search?q=typescript&format=json"
```
