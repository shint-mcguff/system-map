// run.mjs — 本物のVS Codeで拡張テストを回す。
// 使い方: node vscode/e2e/run.mjs [対象リポジトリ]   （省略時は使い捨てフィクスチャを生成）
//
// 素の `code --extensionTestsPath` は、他のVS Codeが起動していると
// 「only supported if no other instance of Code is running」で弾かれる。
// 専用の --user-data-dir / --extensions-dir を与えて別インスタンスにする。
// また ELECTRON_RUN_AS_NODE が環境に残っていると Code.exe がNodeとして起動して
// 引数を解釈できない（VS Code内のターミナルから叩くと起きる）ので落とす。
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.dirname(here);
const repoRoot = path.dirname(extDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'system-map-e2e-'));

function findCode() {
  if (process.env.VSCODE_EXE && fs.existsSync(process.env.VSCODE_EXE)) return process.env.VSCODE_EXE;
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe'),
       'C:/Program Files/Microsoft VS Code/Code.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
      : ['/usr/share/code/code', '/usr/bin/code'];
  const hit = candidates.find((p) => p && fs.existsSync(p));
  if (!hit) { console.error('VS Code本体が見つかりません。VSCODE_EXE で指定してください。'); process.exit(1); }
  return hit;
}

// 対象リポジトリ: 指定が無ければ使い捨てのフィクスチャを作る
let ws = process.argv[2];
if (!ws) {
  ws = path.join(tmp, 'ws');
  cp.execFileSync(process.execPath, [path.join(repoRoot, 'src/gen-fixture.mjs'), ws, '60'], { stdio: 'inherit' });
}

const logPath = path.join(tmp, 'e2e.log');
const env = { ...process.env, SYSTEM_MAP_E2E_LOG: logPath };
delete env.ELECTRON_RUN_AS_NODE;

const r = cp.spawnSync(findCode(), [
  `--extensionDevelopmentPath=${extDir}`,
  `--extensionTestsPath=${here}`,
  `--user-data-dir=${path.join(tmp, 'user')}`,
  `--extensions-dir=${path.join(tmp, 'ext')}`,
  '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  path.resolve(ws),
], { env, encoding: 'utf8' });

const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
console.log(log || r.stdout || '(結果ログなし)');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(log.includes('ALL PASS') ? 0 : 1);
