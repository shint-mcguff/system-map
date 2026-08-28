// extension.js — system-map を VS Code の中に置く。
// 生成物が単一自己完結HTMLなので webview にそのまま載せ、選択とファイルを双方向に繋ぐ。
// 表示先は複数持てる（アクティビティバーのビュー / エディタ列のパネル）。同じ街を両方に映す。
const vscode = require('vscode');
const path = require('path');
const cp = require('child_process');

const hosts = new Set();  // 街を映している webview たち { kind, webview, ready }
let worker = null;        // 解析＋描画の子プロセス
let root = null;          // ワークスペースの絶対パス
let indexed = false;      // workerのinitが済んでいるか
let booting = null;       // 起動処理の進行中プロミス（同時に2つ走らせない）
let panel = null;         // エディタ列のWebviewPanel（あれば）
let lastCam = null;       // 再描画をまたいで視点を保つ
let lastSelect = null;
let rebuildTimer = null;
const pending = new Set();
let echoGuard = false;    // 自分が開いたエディタを選択として跳ね返さない
let updateCount = 0;      // 保存起点の更新回数（拡張テスト用）
let lastPaint = null;     // 直近の描画結果（拡張テスト用）
let lastApply = null;     // 直近のシーン差分更新の結果（拡張テスト用）
let lastScene = null;     // 直近にwebviewへ渡したシーン（次回の差分計算用）
let glInfo = null;        // webviewのWebGLレンダラ名（拡張テスト用）

const cfg = () => vscode.workspace.getConfiguration('systemMap');
const relOf = (fsPath) => path.relative(root, fsPath).split(path.sep).join('/');
const out = vscode.window.createOutputChannel('System Map');

// --- 子プロセス（fork）。VS Code の実体は Electron なので ELECTRON_RUN_AS_NODE で素のNodeとして起動する ---
let seq = 0;
const waiting = new Map();

function startWorker() {
  const child = cp.fork(path.join(__dirname, 'worker.mjs'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    execArgv: [],
    silent: false,
  });
  worker = child;
  child.on('message', (m) => {
    const resolve = waiting.get(m.id);
    if (!resolve) return;
    waiting.delete(m.id);
    resolve(m);
  });
  // 解析しなおしで入れ替えたとき、古い子の終了で新しい子の参照を消さないようにする
  child.on('exit', (code) => {
    out.appendLine(`worker exited (${code})`);
    if (worker === child) { worker = null; indexed = false; }
  });
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

// --- 表示先（ホスト）の出し入れ ---
function attachHost(h) {
  hosts.add(h);
  h.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready') { h.ready = true; glInfo = m.gl ?? glInfo; return; }
    if (m.type === 'error') { out.appendLine(`[webview] ${m.message}`); return; }
    if (m.type !== 'select' || !m.id) return;
    lastSelect = m.id;
    broadcast({ type: 'select', id: m.id }, h); // もう一方の表示先にも選択を伝える
    if (!cfg().get('openFileOnClick')) return;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, m.id)));
      echoGuard = true;
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
      setTimeout(() => { echoGuard = false; }, 300);
    } catch { /* 消えたファイルなど */ }
  });
}

function broadcast(msg, except = null) {
  for (const h of hosts) if (h !== except) h.webview.postMessage(msg);
}

function anyReady() {
  for (const h of hosts) if (h.ready) return true;
  return false;
}

// 応答を1回だけ待つ。応答が無ければ null
function once(h, type, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sub.dispose(); resolve(null); }, ms);
    const sub = h.webview.onDidReceiveMessage((m) => {
      if (m.type !== type) return;
      clearTimeout(timer); sub.dispose(); resolve(m);
    });
  });
}

// --- 現在の視点を webview から取り出す（応答が無ければ前回値で続行） ---
async function grabCam() {
  const h = [...hosts].find((x) => x.ready) ?? [...hosts][0];
  if (!h) return lastCam;
  const p = once(h, 'cam', 300);
  h.webview.postMessage({ type: 'requestCam' });
  const m = await p;
  if (m && m.cam) lastCam = m.cam;
  return lastCam;
}

// HTMLごと作り直す。開いた直後と、差分更新が使えないときだけ通る
async function paint(reason, only = null) {
  const targets = only ? [only] : [...hosts];
  if (!targets.length) return;
  const t0 = Date.now();
  const cam = only ? lastCam : await grabCam();
  const r = await ask('render');
  const html = wrap(r.html, { cam, select: lastSelect });
  for (const h of targets) { h.ready = false; h.webview.html = html; }
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
  if (!hosts.size) return;
  const t0 = Date.now();
  const r = await ask('scene');
  const payload = scenePayload(r.data);
  lastScene = r.data;
  const targets = [...hosts];
  const replies = targets.map((h) => once(h, 'scene-applied', 10000));
  const tPost = Date.now();
  const bytes = JSON.stringify(payload).length;
  for (const h of targets) h.webview.postMessage({ type: 'scene', data: payload, t0: Date.now() });
  // 最初に描き終えた表示先で先に進む。隠れている側が遅くても引きずられない
  const applied = await new Promise((resolve) => {
    let left = replies.length, done = false;
    for (const pr of replies) {
      pr.then((m) => {
        if (m && m.result && !m.unsupported && !done) { done = true; resolve(m); }
        if (--left === 0 && !done) resolve(null);
      });
    }
  });
  if (!applied) {
    // 差分更新できないページ（古いwebviewの復元など）はHTMLごと入れ直す
    out.appendLine(`[${reason}] シーン差分更新が使えないためHTMLを作り直します`);
    lastScene = null;
    await paint(reason);
    return;
  }
  lastApply = applied.result;
  lastPaint = {
    reason, files: r.data.stats.files, edges: r.data.stats.edges,
    renderMs: r.ms, applyMs: lastApply.ms,
    roundTripMs: Date.now() - tPost, bytes, totalMs: Date.now() - t0,
  };
  out.appendLine(`[${reason}] ${r.data.stats.files} files / ${r.data.stats.edges} edges — layout ${r.ms}ms + 描画 ${lastApply.ms}ms, 合計 ${Date.now() - t0}ms`);
}

function scheduleUpdate(fsPath) {
  if (!hosts.size || !cfg().get('updateOnSave')) return;
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

// --- 解析の起動。表示先がいくつあっても1回だけ ---
function ensureIndexed(force = false) {
  if (indexed && !force) return Promise.resolve();
  if (booting) return booting;
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) {
    vscode.window.showErrorMessage('System Map: ワークスペースを開いてから実行してください');
    return Promise.resolve();
  }
  root = folder.uri.fsPath;
  booting = vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'System Map: コードベースを解析中…' },
    async () => {
      if (force && worker) { worker.kill(); worker = null; }
      if (!worker) startWorker();
      const r = await ask('init', { root });
      out.appendLine(`indexed ${r.files} files in ${r.ms}ms`);
      indexed = true;
      lastScene = null;
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document.uri.scheme === 'file' && !relOf(ed.document.uri.fsPath).startsWith('..')) {
        lastSelect = relOf(ed.document.uri.fsPath);
      }
    },
  ).finally(() => { booting = null; });
  return booting;
}

async function showIn(h) {
  await ensureIndexed();
  if (!indexed) return;
  await paint('open', h);
  // 初回HTMLに埋まっているシーンを差分計算の基準にしておく
  if (!lastScene) ask('scene').then((s) => { lastScene = s.data; }).catch(() => {});
}

// --- アクティビティバーのビュー（サイドバー。ユーザが右サイドバーや下パネルへ動かせる） ---
class CityViewProvider {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    const h = { kind: 'view', webview: view.webview, ready: false };
    attachHost(h);
    view.onDidDispose(() => hosts.delete(h));
    showIn(h);
  }
}

// --- エディタ列のパネル（大きく見たいとき） ---
async function openInEditor() {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }
  panel = vscode.window.createWebviewPanel('systemMap', 'System Map', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  const h = { kind: 'panel', webview: panel.webview, ready: false };
  attachHost(h);
  panel.onDidDispose(() => { hosts.delete(h); panel = null; });
  await showIn(h);
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('systemMap.city', new CityViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // 既定はエディタの右列。3D都市は横幅が要るので、細いサイドバーより広く見えるほうを既定にする
    vscode.commands.registerCommand('systemMap.open', () => (
      cfg().get('openLocation') === 'sidebar'
        ? vscode.commands.executeCommand('systemMap.city.focus')
        : openInEditor())),
    vscode.commands.registerCommand('systemMap.openInSidebar', () =>
      vscode.commands.executeCommand('systemMap.city.focus')),
    vscode.commands.registerCommand('systemMap.openInEditor', openInEditor),
    vscode.commands.registerCommand('systemMap.reveal', () => {
      const ed = vscode.window.activeTextEditor;
      if (!hosts.size || !ed || !root) return;
      const rel = relOf(ed.document.uri.fsPath);
      if (rel.startsWith('..')) return;
      lastSelect = rel;
      broadcast({ type: 'select', id: rel });
    }),
    vscode.commands.registerCommand('systemMap.reindex', async () => {
      if (!hosts.size) return vscode.commands.executeCommand('systemMap.city.focus');
      await ensureIndexed(true); // tsconfigのpaths変更やエディタ外での増減を拾い直す
      await paint('reindex');
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file' && root && !path.relative(root, doc.uri.fsPath).startsWith('..')) {
        scheduleUpdate(doc.uri.fsPath);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!hosts.size || !anyReady() || !ed || echoGuard) return;
      if (!cfg().get('followActiveEditor') || ed.document.uri.scheme !== 'file' || !root) return;
      const rel = relOf(ed.document.uri.fsPath);
      if (rel.startsWith('..')) return;
      lastSelect = rel;
      broadcast({ type: 'select', id: rel });
    }),
    out,
  );

  // 拡張テスト（vscode/e2e）から状態を見るための最小API
  return {
    isOpen: () => hosts.size > 0,
    isReady: () => anyReady(),
    hostKinds: () => [...hosts].map((h) => h.kind),
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
