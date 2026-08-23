// history.mjs — git logから街の発展タイムラインを組む
// 使い方: node history.mjs <repo> [out.json]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repo = path.resolve(process.argv[2] ?? '.');
const out = process.argv[3] ?? 'timeline.json';

let raw;
try {
  raw = execSync('git log --format="%H|%at|%s" --numstat --diff-filter=AM', { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.error('not a git repository:', repo);
  process.exit(1);
}

// パース: コミット列挙（古い順へ）
const commits = [];
let cur = null;
for ( const line of raw.split('\n')) {
  if (!line.trim()) continue;
  const pipe = line.indexOf('|');
  if (pipe > 0 && /^\w{40}\|/.test(line)) {
    const [h, at, ...rest] = line.split('|');
    cur = { hash: h.slice(0, 8), ts: Number(at), msg: rest.join('|').slice(0, 60), added: {} };
    commits.push(cur);
    continue;
  }
  const parts = line.split('\t');
  if (cur && parts.length === 3) {
    const add = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
    const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
    const f = parts[2];
    // リネーム表記 {old => new} の処理
    const m = /^\{(.*) => (.*)\}$/.exec(f);
    cur.added[m ? m[2] : f] = { add, del };
  }
}
commits.reverse(); // 古い順

// 各時点での累積LOCを計算
const state = {}; // file -> loc
const frames = [];
for (const c of commits) {
  for (const [f, { add, del }] of Object.entries(c.added)) {
    if (!(f in state)) state[f] = 0;
    state[f] = Math.max(0, state[f] + add - del);
  }
  const files = {};
  for (const [f, loc] of Object.entries(state)) {
    if (loc > 0 && /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(f)) files[f] = loc;
  }
  frames.push({
    ts: c.ts,
    date: new Date(c.ts * 1000).toISOString().slice(0, 10),
    hash: c.hash,
    msg: c.msg,
    nFiles: Object.keys(files).length,
    totalLoc: Object.values(files).reduce((s, v) => s + v, 0),
    files,
  });
}

fs.writeFileSync(out, JSON.stringify({
  repo: path.basename(repo),
  commitCount: frames.length,
  spanDays: frames.length ? Math.max(1, Math.round((frames.at(-1).ts - frames[0].ts) / 86400)) : 0,
  frames,
}));
console.log(`timeline: ${frames.length} commits over ${frames.length ? Math.round((frames.at(-1).ts - frames[0].ts) / 86400) : 0} days -> ${out}`);
