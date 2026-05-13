import { Hono } from 'hono';
import { activePage, initPlaywright } from '../services/playwright.ts';

const login = new Hono();

const allowedKeys = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

function isAuthorized(c: any) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return true;

  const authHeader = c.req.header('Authorization');
  const xApiKey = c.req.header('X-API-Key');
  const queryKey = c.req.query('key');
  const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey || queryKey;

  return providedKey === apiKey;
}

function unauthorized() {
  return new Response('Unauthorized', { status: 401 });
}

async function ensureLoginPage() {
  if (!activePage) {
    await initPlaywright(true);
  }

  if (!activePage) {
    throw new Error('Playwright not initialized');
  }

  if (!activePage.url().includes('chat.deepseek.com')) {
    await activePage.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  }

  return activePage;
}

login.use('*', async (c, next) => {
  if (!isAuthorized(c)) return unauthorized();
  await next();
});

login.get('/', async (c) => {
  const key = c.req.query('key') || '';
  const keyParam = key ? `?key=${encodeURIComponent(key)}` : '';

  return c.html(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DeepSeek Login</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Arial, sans-serif;
      background: #101418;
      color: #eef2f4;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px;
      background: #1b2229;
      border-bottom: 1px solid #2f3a44;
    }

    input {
      flex: 1;
      min-width: 120px;
      padding: 9px 10px;
      border: 1px solid #3d4a55;
      border-radius: 6px;
      background: #111820;
      color: #eef2f4;
    }

    button {
      padding: 9px 12px;
      border: 1px solid #3d4a55;
      border-radius: 6px;
      background: #24313b;
      color: #eef2f4;
      cursor: pointer;
    }

    button:hover {
      background: #2e3c48;
    }

    .viewport {
      overflow: auto;
      display: grid;
      place-items: start center;
      padding: 12px;
    }

    img {
      max-width: 100%;
      height: auto;
      background: #fff;
      cursor: crosshair;
      user-select: none;
    }

    .status {
      font-size: 13px;
      color: #aeb8c2;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <input id="text" type="password" autocomplete="off" placeholder="Texto para digitar no campo focado" />
    <button id="type">Digitar</button>
    <button data-key="Enter">Enter</button>
    <button data-key="Tab">Tab</button>
    <button data-key="Backspace">Backspace</button>
    <button id="refresh">Atualizar</button>
    <span class="status" id="status">conectando...</span>
  </div>
  <div class="viewport">
    <img id="screen" alt="Tela do Playwright" />
  </div>
  <script>
    const keyParam = ${JSON.stringify(keyParam)};
    const screen = document.getElementById('screen');
    const status = document.getElementById('status');
    const text = document.getElementById('text');

    async function api(path, body) {
      const res = await fetch('/login' + path + keyParam, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      if (!res.ok) throw new Error(await res.text());
      return res;
    }

    function loginUrl(path) {
      const url = new URL('/login' + path, window.location.origin);
      if (keyParam) {
        url.search = keyParam.slice(1);
      }
      return url;
    }

    function refresh() {
      const url = loginUrl('/screenshot');
      url.searchParams.set('t', Date.now().toString());
      screen.src = url.toString();
      status.textContent = 'atualizando...';
    }

    screen.addEventListener('load', () => {
      status.textContent = 'online';
    });

    screen.addEventListener('error', () => {
      status.textContent = 'erro ao carregar';
    });

    screen.addEventListener('click', async (event) => {
      const rect = screen.getBoundingClientRect();
      const x = Math.round((event.clientX - rect.left) * (screen.naturalWidth / rect.width));
      const y = Math.round((event.clientY - rect.top) * (screen.naturalHeight / rect.height));
      status.textContent = 'clicando...';
      await api('/click', { x, y });
      setTimeout(refresh, 300);
    });

    document.getElementById('type').addEventListener('click', async () => {
      status.textContent = 'digitando...';
      await api('/type', { text: text.value });
      text.value = '';
      setTimeout(refresh, 300);
    });

    document.querySelectorAll('button[data-key]').forEach((button) => {
      button.addEventListener('click', async () => {
        status.textContent = 'enviando tecla...';
        await api('/key', { key: button.dataset.key });
        setTimeout(refresh, 300);
      });
    });

    document.getElementById('refresh').addEventListener('click', refresh);

    setInterval(refresh, 2500);
    refresh();
  </script>
</body>
</html>`);
});

login.get('/screenshot', async (c) => {
  const page = await ensureLoginPage();
  const screenshot = await page.screenshot({ type: 'png', fullPage: false });

  return c.body(screenshot, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'no-store',
  });
});

login.post('/click', async (c) => {
  const page = await ensureLoginPage();
  const body = await c.req.json().catch(() => ({}));
  const x = Number(body.x);
  const y = Number(body.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return c.json({ error: 'Invalid coordinates' }, 400);
  }

  await page.mouse.click(x, y);
  return c.json({ ok: true });
});

login.post('/type', async (c) => {
  const page = await ensureLoginPage();
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === 'string' ? body.text : '';

  if (text) {
    await page.keyboard.insertText(text);
  }

  return c.json({ ok: true });
});

login.post('/key', async (c) => {
  const page = await ensureLoginPage();
  const body = await c.req.json().catch(() => ({}));
  const key = typeof body.key === 'string' ? body.key : '';

  if (!allowedKeys.has(key)) {
    return c.json({ error: 'Invalid key' }, 400);
  }

  await page.keyboard.press(key);
  return c.json({ ok: true });
});

export { login };
