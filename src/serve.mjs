// serve.mjs — watchモード: ファイル保存→再抽出→再描画→ブラウザ自動リロード
// ゼロ依存。node:http + fs.watch(再帰、macOS/Windows対応)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { extract } from './extract.mjs';
import { render } from './render.mjs';

const [repo, portArg] = process.argv.slice(2);
if (!repo) { console.error('usage: node serve.mjs <repo> [port]'); process.exit(1); }
const PORT = parseInt(portArg ?? '7788', 10);

// AI注釈（annotations.json）: あればrenderに渡す。環境変数で別ファイルも指定可
let ANNOTATIONS = {};
const ANN_FILE = process.env.ANNOTATIONS ?? 'annotations.json';
try { ANNOTATIONS = JSON.parse(fs.readFileSync(ANN_FILE, 'utf8')); } catch { /* なしでも動く */ }

// タイムライン（timeline-<repo>.json or TIMELINE env）: あればタイムバーを出す
let TIMELINE = null;
try { TIMELINE = JSON.parse(fs.readFileSync(process.env.TIMELINE ?? `timeline-${path.basename(repo)}.json`, 'utf8')); } catch { /* なしでも動く */ }

const OUT_HTML = 'dist/live.html';
let clients = new Set();
let rebuildTimer = null;

function rebuild(reason) {
  const t0 = performance.now();
  try {
    const city = extract(repo);
    fs.mkdirSync('dist', { recursive: true });
    // renderにlive注入フラグを渡すため一時的にscriptを足す
    const r = renderLive(city, OUT_HTML, ANNOTATIONS, TIMELINE);
    console.log(`[${new Date().toLocaleTimeString('ja-JP')}] rebuilt (${reason}): ${city.stats.files} files, ${city.stats.edges} edges — extract+render ${Math.round(performance.now() - t0)}ms`);
    for (const res of clients) res.write(`data: reload\n\n`);
  } catch (err) {
    // 編集中の構文エラーなどは静かに無視（前回の地図を表示し続ける）
    console.error(`[${reason}] parse error (keeping last map):`, err.message);
  }
}

function renderLive(city, out, annotations, timeline) {
  const r = render(city, { out, annotations, timeline });
  // リロード用scriptを</body>直前に挿入
  const html = fs.readFileSync(out, 'utf8').replace('</body>',
    `<script>new EventSource('/events').addEventListener('reload',()=>location.reload());</script></body>`);
  fs.writeFileSync(out, html);
  return r;
}

fs.watch(repo, { recursive: true }, (_ev, filename) => {
  if (!filename) return;
  const f = String(filename);
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) return;
  if (f.includes('node_modules') || f.includes('.next')) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild(f), 150); // デバウンス
});

http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(OUT_HTML));
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => {
  console.log(`system-map live: http://localhost:${PORT}  (watching ${repo})`);
  rebuild('startup');
});
