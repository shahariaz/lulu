export function renderUiBuildRequiredHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude-Zen UI not built</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b12;color:#e8edf7;font:16px system-ui}.card{max-width:560px;padding:32px;border:1px solid #293247;border-radius:16px;background:#101622}code{display:block;margin-top:18px;padding:14px;border-radius:8px;background:#070a10;color:#82aaff}p{color:#9ca9bd;line-height:1.6}</style>
</head><body><main class="card"><h1>UI not built</h1><p>The API is running, but the React application has not been compiled. Build it locally, then refresh this page.</p><code>npm run build:ui</code></main></body></html>`
}
