// test-bridge.mjs — VS Code無しで拡張の中身を検証する。
// worker.mjs をforkしてIPCを叩き、返ったHTMLをwebview相当（CSP+ブリッジ注入）にして
// headless Chromeで開き、クリック→ホスト通知 / ホスト→選択 / 視点復元 を確認する。
// 使い方: node vscode/test-bridge.mjs <repo>
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2] ?? '.');
const ok = (n, extra = '') => console.log(`  ✅ ${n}${extra ? ' — ' + extra : ''}`);
const bad = (n, d) => { console.log(`  ❌ ${n}: ${d}`); process.exitCode = 1; };

// --- 1. worker のIPCプロトコル ---
console.log('== 1. worker (fork + IPC) ==');
const worker = cp.fork(path.join(__dirname, 'worker.mjs'), [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
let seq = 0;
const waiting = new Map();
worker.on('message', (m) => { const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m); } });
const ask = (type, payload = {}) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, (m) => (m.type === 'error' ? rej(new Error(m.message)) : res(m)));
  worker.send({ id, type, ...payload });
});

const init = await ask('init', { root: repo });
init.files > 0 ? ok('init', `${init.files} files / ${init.ms}ms`) : bad('init', 'ファイルが0件');

const r1 = await ask('render');
r1.html.startsWith('<!doctype html') || r1.html.startsWith('<!DOCTYPE html')
  ? ok('render', `${(r1.html.length / 1024).toFixed(0)}KB / ${r1.ms}ms`)
  : bad('render', 'HTMLに見えない');

// 実ファイルを触って差分更新（内容は戻す）
const target = r1.ids.slice().sort()[0];
const abs = path.join(repo, target);
const before = fs.readFileSync(abs, 'utf8');
fs.writeFileSync(abs, before + '\nexport const __bridgeTest = 1;\n');
let upd;
try {
  upd = await ask('update', { files: [abs] });
} finally { fs.writeFileSync(abs, before); }
upd.results[0] && upd.results[0].parseMs < 100
  ? ok('update', `${upd.results[0].id} を ${upd.results[0].parseMs}ms で再解析`)
  : bad('update', JSON.stringify(upd.results));
await ask('update', { files: [abs] }); // 元に戻した状態を反映

// --- 2. webview相当のHTMLを組む（extension.js の wrap と同じ手順） ---
console.log('== 2. webview HTML ==');
const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' blob:; img-src data:; connect-src blob:; worker-src blob:;";
const boot = { cam: { yaw: 0.9, pitch: 0.62, zoom: 3.3, target: { x: 12, z: -8 } }, select: target };
const bridge = `
<script>
(function(){
  var vs = acquireVsCodeApi();
  var BOOT = ${JSON.stringify(boot)};
  window.__onSelect = function(id){ vs.postMessage({ type:'select', id:id }); };
  window.addEventListener('message', function(e){
    var m = e.data || {};
    if (m.type === 'select' && window.__select) window.__select(m.id);
    else if (m.type === 'requestCam') vs.postMessage({ type:'cam', cam: window.__cam ? window.__cam() : null });
    else if (m.type === 'scene' && window.__applyScene) vs.postMessage({ type:'scene-applied', result: window.__applyScene(m.data) });
  });
  (function whenReady(n){
    if (window.__select && window.__cam && window.__sel) {
      if (BOOT.cam && window.__setCam) window.__setCam(BOOT.cam);
      if (BOOT.select) window.__select(BOOT.select);
      vs.postMessage({ type:'ready' });
      return;
    }
    if (n > 400) { vs.postMessage({ type:'error', message:'3D初期化がタイムアウトしました' }); return; }
    setTimeout(function(){ whenReady(n + 1); }, 25);
  })(0);
})();
</script>`;
const html = r1.html
  .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
  .replace('</body>', `${bridge}</body>`);
const tmp = path.join(process.env.TEMP ?? '.', 'system-map-webview-test.html');
fs.writeFileSync(tmp, html);
ok('CSP+ブリッジ注入', `${(html.length / 1024).toFixed(0)}KB`);

// --- 3. 実ブラウザで双方向を確認 ---
console.log('== 3. ブリッジ動作（headless Chrome, CSP有効） ==');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// VS Code が注入する API のスタブ
await page.addInitScript(() => {
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), setState() {}, getState() { return null; } });
});
await page.goto('file:///' + tmp.replace(/\\/g, '/'), { waitUntil: 'load' });
await page.waitForTimeout(2500);

const posted = await page.evaluate(() => window.__posted);
posted.some((m) => m.type === 'ready') ? ok('ready通知') : bad('ready通知', JSON.stringify(posted));

const cam = await page.evaluate(() => window.__cam());
Math.abs(cam.zoom - 3.3) < 0.01 && Math.abs(cam.target.x - 12) < 0.01
  ? ok('起動時の視点復元', `zoom=${cam.zoom} target.x=${cam.target.x}`)
  : bad('起動時の視点復元', JSON.stringify(cam));

const sel0 = await page.evaluate(() => window.__sel());
sel0 && sel0.sel === target ? ok('起動時の選択復元', sel0.sel) : bad('起動時の選択復元', JSON.stringify(sel0));

// ホスト → webview: 別のビルを選択（__onSelect は呼ばれない＝ループしない）
const other = r1.ids.slice().sort()[1] ?? target;
const loop = await page.evaluate((id) => {
  const n = window.__posted.length;
  window.postMessage({ type: 'select', id }, '*');
  return new Promise((res) => setTimeout(() => res({ sel: window.__sel(), newPosts: window.__posted.length - n }), 300));
}, other);
loop.sel.sel === other && loop.newPosts === 0
  ? ok('ホスト→選択（エコーバック無し）', other)
  : bad('ホスト→選択', JSON.stringify(loop));

// webview → ホスト: 検索ジャンプはユーザ操作なので通知される
const notify = await page.evaluate((id) => {
  const n = window.__posted.length;
  window.__select && window.__select(id); // これは通知しない（QAフック経路）
  const afterHook = window.__posted.length - n;
  return { afterHook };
}, target);
notify.afterHook === 0 ? ok('__select()はホスト通知しない') : bad('__select()', JSON.stringify(notify));

// 実クリック: 画面中央付近のビルを拾って押す
const click = await page.evaluate(() => {
  const n = window.__posted.length;
  const cv = document.querySelector('canvas');
  const r = cv.getBoundingClientRect();
  // 建物が写っている点に当たるまで画面全体を走査する（視点は復元済みなので中央とは限らない）
  const pts = [];
  for (let gy = 1; gy <= 5; gy++) for (let gx = 1; gx <= 7; gx++) pts.push([r.width * gx / 8, r.height * gy / 6]);
  for (const [x, y] of pts) {
    for (const t of ['pointerdown', 'pointerup']) {
      cv.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, button: 0 }));
    }
    if (window.__posted.length > n) break;
  }
  return window.__posted.slice(n);
});
click.some((m) => m.type === 'select' && m.id)
  ? ok('クリック→ホスト通知', click.find((m) => m.type === 'select').id)
  : bad('クリック→ホスト通知', 'selectメッセージが飛ばなかった');

// ホストからの視点要求
const camReq = await page.evaluate(() => {
  const n = window.__posted.length;
  window.postMessage({ type: 'requestCam' }, '*');
  return new Promise((res) => setTimeout(() => res(window.__posted.slice(n)), 200));
});
camReq.some((m) => m.type === 'cam' && m.cam) ? ok('視点要求→応答') : bad('視点要求', JSON.stringify(camReq));

// --- 4. シーン差分更新: HTMLを入れ直さず街だけ組み直す ---
console.log('== 4. シーン差分更新（__applyScene） ==');
const before4 = await page.evaluate(() => ({ cam: window.__cam(), sel: window.__sel().sel, nodes: window.__nodes().length }));

// ファイルを1つ足して差分更新 → ビルが1棟増えるはず
const addedPath = path.join(repo, 'system-map-e2e-added.ts');
fs.writeFileSync(addedPath, "export function addedByTest() { return 1; }\n");
let scene;
try {
  await ask('update', { files: [addedPath] });
  scene = await ask('scene');
} finally { fs.rmSync(addedPath, { force: true }); }

const applied = await page.evaluate((data) => {
  const n = window.__posted.length;
  window.postMessage({ type: 'scene', data }, '*');
  return new Promise((res) => setTimeout(() => res({
    posted: window.__posted.slice(n),
    cam: window.__cam(),
    sel: window.__sel().sel,
    nodes: window.__nodes().length,
  }), 500));
}, scene.data);

const res = (applied.posted.find((m) => m.type === 'scene-applied') || {}).result;
res && res.nodes === before4.nodes + 1
  ? ok('差分更新でビルが増える', `${before4.nodes} → ${res.nodes}棟 / ${res.ms}ms（layout ${scene.ms}ms）`)
  : bad('差分更新', JSON.stringify({ res, before: before4.nodes }));

JSON.stringify(applied.cam) === JSON.stringify(before4.cam)
  ? ok('視点が動かない', `zoom=${applied.cam.zoom}`)
  : bad('視点維持', `${JSON.stringify(before4.cam)} → ${JSON.stringify(applied.cam)}`);

applied.sel === before4.sel ? ok('選択が保たれる', String(applied.sel)) : bad('選択維持', `${before4.sel} → ${applied.sel}`);

// 元に戻す（削除の反映も差分更新で通す）
await ask('update', { files: [addedPath] });
const back = await ask('scene');
const restored = await page.evaluate((data) => {
  const n = window.__posted.length;
  window.postMessage({ type: 'scene', data }, '*');
  return new Promise((res) => setTimeout(() => res(window.__posted.slice(n)), 500));
}, back.data);
const r2 = (restored.find((m) => m.type === 'scene-applied') || {}).result;
r2 && r2.nodes === before4.nodes
  ? ok('削除も反映される', `${res.nodes} → ${r2.nodes}棟`)
  : bad('削除の反映', JSON.stringify(r2));

// 構造が変わらない保存（同じシーンをもう一度当てる）＝日常のケース
const again = await page.evaluate((data) => {
  const t = performance.now();
  const r = window.__applyScene(data);
  return { r, wall: Math.round(performance.now() - t) };
}, back.data);
again.r ? ok("変化なしの再適用", again.wall + "ms（" + again.r.nodes + "棟）") : bad("再適用", "nullが返った");

worker.kill();

errors.length === 0 ? ok('CSP下でJSエラーなし') : bad('JSエラー', errors.slice(0, 3).join(' / '));
await page.screenshot({ path: 'dist/vscode-webview.png' });
await browser.close();
console.log(process.exitCode ? '\nFAILED' : '\nALL PASS');
