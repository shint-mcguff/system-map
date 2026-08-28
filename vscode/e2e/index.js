// e2e/index.js — 本物のVS Code内で拡張を通しで動かす。
//   code --extensionDevelopmentPath=<repo>/vscode --extensionTestsPath=<repo>/vscode/e2e <対象リポジトリ>
// run() が解決すれば成功、throwすれば失敗（終了コードに出る）。
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const log = [];
const LOG_PATH = process.env.SYSTEM_MAP_E2E_LOG || path.join(require('os').tmpdir(), 'system-map-e2e.log');
const flush = (verdict) => { try { fs.writeFileSync(LOG_PATH, log.concat(verdict).join('\n') + '\n'); } catch { /* 書けなくても本体は続ける */ } };
const say = (s) => { log.push(s); console.log(s); };
const ok = (n, extra = '') => say(`  OK  ${n}${extra ? ' — ' + extra : ''}`);
const fail = (n, d) => { throw new Error(`${n}: ${d}`); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return Date.now() - t0;
    await sleep(100);
  }
  fail(what, `${ms}ms 待っても成立しませんでした`);
}

async function run() {
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  say(`== VS Code ${vscode.version} / workspace: ${path.basename(root)} ==`);

  const ext = vscode.extensions.getExtension('shint-mcguff.system-map');
  if (!ext) fail('拡張の解決', 'shint-mcguff.system-map が見つからない');
  const api = await ext.activate();
  ok('activate', typeof api.isOpen === 'function' ? 'test API あり' : '');

  // --- 1. 街を開く（worker init → render → webview → ブリッジのready） ---
  const t0 = Date.now();
  await vscode.commands.executeCommand('systemMap.open');
  if (!api.isOpen()) fail('街を開く', 'パネルが作られていない');
  const readyMs = await waitFor(() => api.isReady(), 90000, 'webviewのready');
  const p = api.lastPaint();
  ok('街を開く', `${p.files} files / ${p.edges} edges, render ${p.renderMs}ms, ready まで ${Date.now() - t0}ms(内 webview ${readyMs}ms) / GL: ${api.glInfo()}`);

  // --- 2. エディタ切替 → ビル選択が追従する ---
  const files = (await vscode.workspace.findFiles('**/*.ts', null, 5)).map((u) => u.fsPath);
  if (files.length < 2) fail('対象ファイル', `.ts が ${files.length} 件しかない`);
  const relOf = (f) => path.relative(root, f).split(path.sep).join('/');

  api.setSelect(null);
  const docA = await vscode.workspace.openTextDocument(files[0]);
  await vscode.window.showTextDocument(docA, { preserveFocus: false });
  await waitFor(() => api.lastSelect() === relOf(files[0]), 10000, 'エディタ切替→選択追従');
  ok('エディタ切替→ビル選択', relOf(files[0]));

  const docB = await vscode.workspace.openTextDocument(files[1]);
  await vscode.window.showTextDocument(docB, { preserveFocus: false });
  await waitFor(() => api.lastSelect() === relOf(files[1]), 10000, '2回目の切替');
  ok('もう一度切替', relOf(files[1]));

  // --- 3. 保存 → そのファイルだけ再解析して街が更新される ---
  const target = files[1];
  const before = fs.readFileSync(target, 'utf8');
  // 編集はエディタ上で行い、ディスクへの復元は最後にまとめてやる
  // （途中でディスクだけ戻すと、開いているドキュメントと食い違って以降のsave()が通らない）
  async function touchAndSave(label) {
    const n = api.updateCount();
    const t = Date.now();
    const ed = await vscode.window.showTextDocument(docB);
    await ed.edit((b) => b.insert(new vscode.Position(0, 0), `// e2e ${label}\n`));
    if (!(await docB.save())) fail(label, 'save()がfalseを返した');
    await waitFor(() => api.updateCount() > n, 30000, label);
    const p = api.lastPaint(), a = api.lastApply();
    if (p.reason !== 'save') fail('更新の理由', JSON.stringify(p));
    if (!a) fail('シーン差分更新', 'webviewから scene-applied が返っていない（HTML入れ直しにフォールバックした可能性）');
    ok(label, `${Date.now() - t}ms（layout ${p.renderMs}ms / 送受 ${p.roundTripMs}ms(${Math.round(p.bytes / 1024)}KB, 往路 ${a.recvMs}ms) / 組み直し ${a.ms}ms、${a.nodes}棟）`);
  }

  try {
    await touchAndSave('保存→街の更新');
    await touchAndSave('2回目の保存');   // 1回目の往復が暖機ぶんだけ遅い可能性の切り分け
  } finally {
    // エディタの変更を捨ててからディスクを戻す
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(undefined, () => {});
    fs.writeFileSync(target, before);
  }

  // 選択が更新後も保たれている
  if (api.lastSelect() !== relOf(files[1])) fail('更新後の選択維持', String(api.lastSelect()));
  ok('更新後も選択を維持', api.lastSelect());

  // --- 4. コマンド: このファイルのビルへ ---
  await vscode.commands.executeCommand('systemMap.reveal');
  ok('systemMap.reveal', '例外なし');

  say('');
  flush('ALL PASS');
}

// 失敗もログに残す（VS CodeのGUIプロセスは標準出力が拾えないことがある）
module.exports = {
  run: () => run().catch((e) => { flush('FAILED: ' + (e && e.stack || e)); throw e; }),
};
