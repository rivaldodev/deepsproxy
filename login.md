# Rota de Login do DeepsProxy

Este documento explica em detalhes como funciona a rota `/login`, usada para autenticar manualmente a sessao do DeepSeek dentro do navegador Playwright do DeepsProxy.

## Objetivo

O DeepsProxy nao usa uma API oficial autenticada por chave do DeepSeek. Ele depende de uma sessao web autenticada em `https://chat.deepseek.com/`.

A rota `/login` existe para resolver o problema comum em VPS, Docker e Coolify:

- O browser roda em modo headless dentro do container.
- Nao ha interface grafica direta para fazer login.
- O proxy precisa de cookies, authorization e headers PoW gerados pela pagina do DeepSeek.

Entao `/login` cria uma pequena interface web que:

- Mostra screenshots do navegador Playwright.
- Permite clicar na tela remota.
- Permite digitar texto no campo focado.
- Permite enviar algumas teclas, como `Enter`, `Tab` e `Backspace`.
- Mantem a sessao salva no volume `deepseek_profile`.

## Arquivos Envolvidos

```text
src/routes/login.ts
src/services/playwright.ts
src/index.ts
docker-compose.yml
deepseek_profile/
```

Em `src/index.ts`, a rota e registrada antes do middleware global de API key:

```ts
app.route('/login', login);
```

A propria rota `/login` possui autenticacao interna.

## Persistencia Da Sessao

O Playwright e iniciado com contexto persistente:

```ts
const profilePath = path.resolve('deepseek_profile');

context = await chromium.launchPersistentContext(profilePath, {
  headless,
  userAgent: 'Mozilla/5.0 ... Chrome/130.0.0.0 Safari/537.36',
});
```

Isso significa que cookies, local storage e outros dados de sessao ficam salvos em:

```text
deepseek_profile/
```

No Docker Compose, esse diretorio e montado como volume:

```yaml
volumes:
  - ./deepseek_profile:/app/deepseek_profile
```

Consequencia pratica:

- Depois de fazer login uma vez, a sessao tende a continuar valida entre restarts do container.
- Se o volume for apagado, a sessao sera perdida.
- Se o DeepSeek invalidar cookies ou pedir novo desafio, sera necessario acessar `/login` novamente.

## Autenticacao Da Rota

Se `API_KEY` nao estiver configurada, `/login` fica aberta.

Se `API_KEY` estiver configurada, a rota aceita tres formas:

### Bearer Token

```http
Authorization: Bearer SUA_API_KEY
```

### Header `X-API-Key`

```http
X-API-Key: SUA_API_KEY
```

### Query String

```text
/login?key=SUA_API_KEY
```

O uso com query string existe porque a interface HTML precisa carregar imagens e fazer `fetch` para subrotas sem configurar headers manualmente no navegador do usuario.

Quando a chave e invalida:

```text
Unauthorized
```

Status:

```text
401
```

## Fluxo De Uso Em VPS/Coolify

1. Suba o DeepsProxy com o volume `deepseek_profile`.
2. Acesse:

```text
https://SEU_DOMINIO/login?key=SUA_API_KEY
```

3. A pagina carrega um screenshot do Chromium controlado pelo Playwright.
4. Se o browser ainda nao estiver no DeepSeek, ele navega para:

```text
https://chat.deepseek.com/
```

5. Use os controles da pagina para fazer login:

- Clique na imagem para clicar na tela remota.
- Digite texto no input superior e clique em `Digitar`.
- Use `Enter`, `Tab` ou `Backspace` quando necessario.
- Clique em `Atualizar` se quiser forcar um novo screenshot.

6. Quando o login terminar, teste uma chamada normal:

```bash
curl http://deepsproxy:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SUA_API_KEY" \
  -d '{
    "model": "deepseek-no-thinking",
    "messages": [
      { "role": "user", "content": "Ola" }
    ]
  }'
```

## Como A Pagina `/login` Funciona

`GET /login` retorna uma pagina HTML simples.

Ela tem:

- Um campo `<input type="password">` para digitar texto.
- Botao `Digitar`.
- Botoes de teclas: `Enter`, `Tab`, `Backspace`.
- Botao `Atualizar`.
- Uma imagem `<img id="screen">` que recebe screenshots do browser.

A pagina faz refresh automatico do screenshot a cada 2,5 segundos:

```js
setInterval(refresh, 2500);
```

Cada screenshot recebe um parametro `t=Date.now()` para evitar cache:

```js
url.searchParams.set('t', Date.now().toString());
```

Quando o usuario clica na imagem, o frontend converte coordenadas da imagem exibida para coordenadas reais do screenshot:

```js
const x = Math.round((event.clientX - rect.left) * (screen.naturalWidth / rect.width));
const y = Math.round((event.clientY - rect.top) * (screen.naturalHeight / rect.height));
```

Depois envia:

```http
POST /login/click
```

com:

```json
{
  "x": 100,
  "y": 200
}
```

## Inicializacao Da Pagina Do DeepSeek

Todas as subrotas operacionais chamam `ensureLoginPage()`.

Essa funcao:

1. Inicializa o Playwright se `activePage` ainda nao existe:

```ts
if (!activePage) {
  await initPlaywright(true);
}
```

2. Falha se a pagina ainda nao existir:

```ts
throw new Error('Playwright not initialized');
```

3. Se a pagina atual nao estiver no DeepSeek, navega para:

```ts
await activePage.goto('https://chat.deepseek.com/', {
  waitUntil: 'domcontentloaded',
});
```

4. Retorna a pagina ativa.

## Endpoints

## GET /login

Retorna a interface HTML de controle remoto.

### Exemplo

```text
https://SEU_DOMINIO/login?key=SUA_API_KEY
```

### Resposta

```http
Content-Type: text/html
```

Corpo: HTML da interface.

## GET /login/screenshot

Captura a tela atual do navegador Playwright.

Internamente:

```ts
const screenshot = await page.screenshot({
  type: 'png',
  fullPage: false,
});
```

O resultado e convertido para `Uint8Array` antes de responder:

```ts
const image = new Uint8Array(screenshot.byteLength);
image.set(screenshot);
```

### Resposta

```http
Content-Type: image/png
Cache-Control: no-store
```

Corpo: imagem PNG.

## POST /login/click

Envia clique para a pagina Playwright.

### Request

```json
{
  "x": 100,
  "y": 200
}
```

### Validacao

`x` e `y` precisam ser numeros finitos:

```ts
if (!Number.isFinite(x) || !Number.isFinite(y)) {
  return c.json({ error: 'Invalid coordinates' }, 400);
}
```

### Execucao

```ts
await page.mouse.click(x, y);
```

### Resposta

```json
{
  "ok": true
}
```

### Erro

```json
{
  "error": "Invalid coordinates"
}
```

Status:

```text
400
```

## POST /login/type

Digita texto no campo focado.

### Request

```json
{
  "text": "texto para digitar"
}
```

### Execucao

Se `text` for string nao-vazia:

```ts
await page.keyboard.insertText(text);
```

### Resposta

```json
{
  "ok": true
}
```

Observacao: se `text` estiver vazio ou nao for string, a rota apenas retorna `{ "ok": true }` sem digitar nada.

## POST /login/key

Pressiona uma tecla permitida.

### Request

```json
{
  "key": "Enter"
}
```

### Teclas Permitidas

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

### Validacao

Se a tecla nao estiver na allowlist:

```json
{
  "error": "Invalid key"
}
```

Status:

```text
400
```

### Execucao

```ts
await page.keyboard.press(key);
```

### Resposta

```json
{
  "ok": true
}
```

## Relacao Com `getDeepSeekHeaders`

A rota `/login` apenas autentica e controla a pagina.

O uso real da sessao acontece quando uma rota de geracao chama `getDeepSeekHeaders()`.

Essa funcao:

1. Verifica se `activePage` existe.
2. Garante que a pagina esta no DeepSeek.
3. Aguarda o seletor `textarea`.
4. Registra um interceptor para:

```text
**/api/v0/chat/completion
```

5. Digita `a` no textarea e pressiona `Enter`.
6. Intercepta a request real que a UI do DeepSeek faria.
7. Extrai headers importantes:

```ts
{
  'x-ds-pow-response': ...,
  'x-hif-dliq': ...,
  'x-hif-leim': ...,
  'authorization': ...,
  'cookie': ...
}
```

8. Extrai tambem, se existirem:

```ts
chat_session_id
parent_message_id
```

9. Aborta a request interceptada para nao poluir o historico:

```ts
await route.abort('aborted');
```

10. Retorna headers e ids para `createDeepSeekStream()`.

Isso explica por que o login precisa estar valido: sem sessao autenticada, o textarea pode nao aparecer, ou os headers de authorization/PoW nao serao gerados corretamente.

## Erros Comuns

### `Unauthorized`

Causa:

- `API_KEY` configurada, mas `?key=...` ou headers nao foram enviados.

Solucao:

```text
/login?key=SUA_API_KEY
```

ou envie:

```http
Authorization: Bearer SUA_API_KEY
```

### `Timeout waiting for chat input. Are you logged in?`

Causa:

- DeepSeek abriu tela de login.
- Sessao expirou.
- Cloudflare/desafio bloqueou a tela.
- O seletor `textarea` nao apareceu em ate 30s.

Solucao:

- Acesse `/login`.
- Complete login/desafio.
- Confirme que a tela de chat aparece.

### Screenshot nao atualiza

Possiveis causas:

- Playwright nao inicializou.
- Container sem dependencias de browser.
- Rota protegida sem `key`.
- Browser travado em alguma tela intermediaria.

Passos:

1. Acessar `/login?key=SUA_API_KEY`.
2. Clicar em `Atualizar`.
3. Ver logs do container.
4. Reiniciar o servico se `activePage` estiver travada.

### Login nao persiste depois do deploy

Causa provavel:

- Volume `deepseek_profile` nao esta persistido.
- Coolify recriou o container sem manter volume.
- O diretorio nao tem permissao de escrita.

Solucao:

Garantir volume:

```yaml
volumes:
  - ./deepseek_profile:/app/deepseek_profile
```

## Seguranca

`/login` e sensivel porque permite controlar o navegador autenticado.

Recomendacoes:

- Sempre definir `API_KEY` em producao.
- Acessar `/login` apenas temporariamente quando precisar autenticar.
- Nao compartilhar URL com `?key=...`.
- Preferir rede privada ou dominio protegido.
- Rotacionar `API_KEY` se ela aparecer em logs ou historico.

## Fluxo Completo

Resumo operacional:

```text
Usuario abre /login?key=...
        |
        v
HTML carrega /login/screenshot
        |
        v
ensureLoginPage() inicializa/navega Playwright para chat.deepseek.com
        |
        v
Usuario clica/digita/envia teclas pela interface
        |
        v
Login e cookies ficam salvos em deepseek_profile/
        |
        v
Chamadas /v1/chat/completions ou /v1/responses usam getDeepSeekHeaders()
        |
        v
getDeepSeekHeaders intercepta request da UI para obter headers e PoW
        |
        v
createDeepSeekStream usa esses headers para chamar /api/v0/chat/completion
```

## Checklist Para Ambiente Novo

- [ ] Configurar `API_KEY`.
- [ ] Persistir volume `deepseek_profile`.
- [ ] Subir container com Playwright funcionando.
- [ ] Acessar `/login?key=SUA_API_KEY`.
- [ ] Fazer login no DeepSeek pela interface remota.
- [ ] Confirmar que a tela de chat carregou.
- [ ] Testar `/v1/chat/completions`.
- [ ] Se falhar por timeout, voltar a `/login` e verificar tela atual.
