// extension.js — system-map を VS Code の横に並べる。
// 生成物が単一自己完結HTMLなので webview にそのまま載せ、選択とファイルを双方向に繋ぐ。
const vscode = require('vscode');
const path = require('path');
const cp = require('child_process');

let panel = null;      // WebviewPanel
let worker = null;     // 解析＋描画の子プロセス
let root = null;       // ワークスペースの絶対パス
let lastCam = null;    // 再描画をまたいで視点を保つ
let lastSelect = null;
let ready = false;
let rebuildTimer = null;
const pending = new Set();
let echoGuard = false; // 自分が開いたエディタを選択として跳ね返さない
let updateCount = 0;   // 保存起点の更新回数（拡張テスト用）
let lastPaint = null;  // 直近の描画結果（拡張テスト用）
let lastApply = null;  // 直近のシーン差分更新の結果（拡張テスト用）
let lastScene = null;  // 直近にwebviewへ渡したシーン（次回の差分計算用）
let glInfo = null;     // webviewのWebGLレンダラ名（拡張テスト用）

const cfg = () => vscode.workspace.getConfiguration('systemMap');
const relOf = (fsPath) => path.relative(root, fsPath).split(path.sep).join('/');
const out = vscode.window.createOutputChannel('System Map');

// --- 子プロセス（fork）。VS Code の実体は Electron なので ELECTRON_RUN_AS_NODE で素のNodeとして起動する ---
let seq = 0;
const waiting = new Map();

function startWorker() {
  worker = cp.fork(path.join(__dirname, 'worker.mjs'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    execArgv: [],
    silent: false,
  });
  worker.on('message', (m) => {
    const resolve = waiting.get(m.id);
    if (!resolve) return;
    waiting.delete(m.id);
    resolve(m);
  });
  worker.on('exit', (code) => { out.appendLine(`worker exited (${code})`); worker = null; });
}

function ask(type, payload = {}) {
  if (!worker) startWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, (m) => (m.type === 'error' ? reject(new Error(m.message)) : resolve(m)));
    worker.send({ id, type, ...payload });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${type} timeout`)); }, 120000);
  });
}

// --- webview に渡す前に CSP とブリッジを差し込む ---
function wrap(html, boot) {
  // three.js は Blob URL を作って動的importするので blob: を許す（外部通信は一切しない）
  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' blob:; img-src data:; connect-src blob:; worker-src blob:;";
  const bridge = `
<script>
(function(){
  var vs = acquireVsCodeApi();
  var BOOT = ${JSON.stringify(boot)};
  // ユーザがビルをクリック/検索ジャンプしたとき（ホスト起点の選択では呼ばれない）
  window.__onSelect = function(id){ vs.postMessage({ type:'select', id:id }); };
  window.addEventListener('message', function(e){
    var m = e.data || {};
    if (m.type === 'select' && window.__select) window.__select(m.id);
    else if (m.type === 'requestCam') vs.postMessage({ type:'cam', cam: window.__cam ? window.__cam() : null });
    else if (m.type === 'scene') {
      // 視点も選択もそのまま、街だけ作り直す
      if (!window.__applyScene) { vs.postMessage({ type:'scene-applied', result:null, unsupported:true }); return; }
      var recvMs = m.t0 ? Date.now() - m.t0 : null;
      var res = window.__applyScene(m.data) || {};
      res.recvMs = recvMs;
      vs.postMessage({ type:'scene-applied', result: res });
    }
  });
  // 本体は <script type="module">（deferred）なのでフックが生えるのを待つ
  (function whenReady(n){
    if (window.__select && window.__cam && window.__sel) {
      if (BOOT.cam && window.__setCam) window.__setCam(BOOT.cam);
      if (BOOT.select) window.__select(BOOT.select);
      vs.postMessage({ type:'ready', gl: window.__gl ? window.__gl() : null });
      return;
    }
    if (n > 400) { vs.postMessage({ type:'error', message:'3D初期化がタイムアウトしました' }); return; }
    setTimeout(function(){ whenReady(n + 1); }, 25);
  })(0);
})();
</script>`;
  return html
    .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .replace('</body>', `${bridge}</body>`);
}

// --- 現在の視点を webview から取り出す（応答が無ければ前回値で続行） ---
function grabCam() {
  if (!panel) return Promise.resolve(lastCam);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sub.dispose(); resolve(lastCam); }, 300);
    const sub = panel.webview.onDidReceiveMessage((m) => {
      if (m.type !== 'cam') return;
      clearTimeout(timer); sub.dispose();
      if (m.cam) lastCam = m.cam;
      resolve(lastCam);
    });
    panel.webview.postMessage({ type: 'requestCam' });
  });
}

async function paint(reason) {
  if (!panel) return;
  const t0 = Date.now();
  const cam = await grabCam();
  const r = await ask('render');
  panel.webview.html = wrap(r.html, { cam, select: lastSelect });
  lastPaint = { reason, files: r.stats.files, edges: r.stats.edges, renderMs: r.ms, totalMs: Date.now() - t0 };
  out.appendLine(`[${reason}] ${r.stats.files} files / ${r.stats.edges} edges — render ${r.ms}ms, 合計 ${Date.now() - t0}ms`);
}

// 前回webviewへ渡した内容と比べ、変わったノードだけのパッチにする。
// シーン全体は数百KBあり、VS Codeのメッセージ往復だけで無視できない時間がかかるため。
function scenePayload(next) {
  if (!lastScene) return next;
  const prev = new Map(lastScene.NODES.map((n) => [n.id, JSON.stringify(n)]));
  const nodes = [];
  const alive = new Set();
  for (const n of next.NODES) {
    alive.add(n.id);
    if (prev.get(n.id) !== JSON.stringify(n)) nodes.push(n);
  }
  const removed = lastScene.NODES.filter((n) => !alive.has(n.id)).map((n) => n.id);
  if (nodes.length > next.NODES.length / 2) return next; // 半分以上動くなら全体を送ったほうが速い
  const p = { patch: true, nodes, removed, stats: next.stats };
  const changed = (k) => JSON.stringify(next[k]) !== JSON.stringify(lastScene[k]);
  if (changed('EDGES')) p.EDGES = next.EDGES;
  if (changed('CALLS')) p.CALLS = next.CALLS;
  if (changed('PLATES')) p.PLATES = next.PLATES;
  return p;
}

// 保存時: HTMLを作り直さず、シーンデータだけ送って街を組み直す（視点と選択は維持される）
async function applyScene(reason) {
  if (!panel) return;
  const t0 = Date.now();
  const r = await ask('scene');
  const applied = new Promise((resolve) => {
    const timer = setTimeout(() => { sub.dispose(); resolve(null); }, 10000);
    const sub = panel.webview.onDidReceiveMessage((m) => {
      if (m.type !== 'scene-applied') return;
      clearTimeout(timer); sub.dispose(); resolve(m.unsupported ? 'unsupported' : m.result);
    });
  });
  const payload = scenePayload(r.data);
  lastScene = r.data;
  const tPost = Date.now();
  const bytes = JSON.stringify(payload).length;
  panel.webview.postMessage({ type: 'scene', data: payload, t0: Date.now() });
  const res = await applied;
  if (res === 'unsupported' || res === null) {
    // 差分更新できないページ（古いwebviewの復元など）はHTMLごと入れ直す
    out.appendLine('[' + reason + '] シーン差分更新が使えないためHTMLを作り直します');
    lastScene = null;
    await paint(reason);
    return;
  }
  lastApply = res;
  const roundTripMs = Date.now() - tPost;
  lastPaint = {
    reason, files: r.data.stats.files, edges: r.data.stats.edges,
    renderMs: r.ms, applyMs: lastApply ? lastApply.ms : null,
    roundTripMs, bytes, totalMs: Date.now() - t0,
  };
  out.appendLine(`[${reason}] ${r.data.stats.files} files / ${r.data.stats.edges} edges — layout ${r.ms}ms + 描画 ${lastApply ? lastApply.ms : '?'}ms, 合計 ${Date.now() - t0}ms`);
}

function scheduleUpdate(fsPath) {
  if (!panel || !cfg().get('updateOnSave')) return;
  pending.add(fsPath);
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    const files = [...pending]; pending.clear();
    try {
      const u = await ask('update', { files });
      const hit = u.results.filter((x) => x);
      if (!hit.length) return; // 対象外の拡張子だけだった
      out.appendLine(`update: ${hit.map((x) => `${x.id} ${x.parseMs}ms`).join(', ')}`);
      await applyScene('save');
      updateCount++;
    } catch (err) {
      out.appendLine(`update failed: ${err.message}`); // 編集途中の壊れた状態は無視して前の街を保つ
    }
  }, 200);
}

async function openCity(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) { vscode.window.showErrorMessage('System Map: ワークスペースを開いてから実行してください'); return; }
  root = folder.uri.fsPath;

  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
  panel = vscode.window.createWebviewPanel('systemMap', 'System Map', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.onDidDispose(() => {
    panel = null; ready = false;
    if (worker) { worker.kill(); worker = null; }
  }, null, context.subscriptions);

  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') { ready = true; glInfo = m.gl; return; }
    if (m.type !== 'select' || !m.id) return;
    lastSelect = m.id;
    if (!cfg().get('openFileOnClick')) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, m.id)));
      echoGuard = true;
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
      setTimeout(() => { echoGuard = false; }, 300);
    } catch { /* 消えたファイルなど */ }
  }, null, context.subscriptions);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'System Map: コードベースを解析中…' },
    async () => {
      startWorker();
      const r = await ask('init', { root });
      out.appendLine(`indexed ${r.files} files in ${r.ms}ms`);
      lastScene = null;
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document.uri.scheme === 'file') lastSelect = relOf(ed.document.uri.fsPath);
      await paint('open');
      // 初回HTMLに埋まっているシーンを差分計算の基準にしておく
      ask('scene').then((s) => { lastScene = s.data; }).catch(() => {});
    },
  );
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('systemMap.open', () => openCity(context)),
    vscode.commands.registerCommand('systemMap.reveal', () => {
      const ed = vscode.window.activeTextEditor;
      if (!panel || !ed) return;
      panel.webview.postMessage({ type: 'select', id: relOf(ed.document.uri.fsPath) });
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file' && root && !path.relative(root, doc.uri.fsPath).startsWith('..')) {
        scheduleUpdate(doc.uri.fsPath);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!panel || !ready || !ed || echoGuard) return;
      if (!cfg().get('followActiveEditor') || ed.document.uri.scheme !== 'file' || !root) return;
      const rel = relOf(ed.document.uri.fsPath);
      if (rel.startsWith('..')) return;
      lastSelect = rel;
      panel.webview.postMessage({ type: 'select', id: rel });
    }),
    out,
  );

  // 拡張テスト（vscode/e2e）から状態を見るための最小API
  return {
    isOpen: () => !!panel,
    isReady: () => ready,
    updateCount: () => updateCount,
    lastSelect: () => lastSelect,
    lastPaint: () => lastPaint,
    lastApply: () => lastApply,
    glInfo: () => glInfo,
    setSelect: (id) => { lastSelect = id; },
  };
}

function deactivate() { if (worker) worker.kill(); }

module.exports = { activate, deactivate };
