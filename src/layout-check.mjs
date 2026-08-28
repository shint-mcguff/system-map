// layout-check.mjs — レイアウトの安定性を測る。
// 「1ファイル触っただけで街全体が動く」ことがないかを、実際に動いたビルの数で見る。
// 使い方: node src/layout-check.mjs <repo>
import fs from 'node:fs';
import path from 'node:path';
import { createSession } from './extract.mjs';
import { layout } from './render3d.mjs';

const repo = path.resolve(process.argv[2] ?? 'fixtures/synth-2000');
const ok = (n, extra = '') => console.log(`  ✅ ${n}${extra ? ' — ' + extra : ''}`);
const bad = (n, d) => { console.log(`  ❌ ${n}: ${d}`); process.exitCode = 1; };

const posOf = (L) => new Map(L.NODES.map((n) => [n.id, n.x + ',' + n.z]));
function moved(a, b) {
  const A = posOf(a), B = posOf(b);
  let n = 0;
  for (const [id, p] of A) if (B.has(id) && B.get(id) !== p) n++;
  return n;
}

const s = createSession(repo);
const base = layout(s.city());
console.log(`== ${path.basename(repo)}: ${base.NODES.length} files / ${base.PLATES.length} districts ==`);

// 1. 同じ入力なら同じ結果（決定的か）
const again = layout(s.city(), base);
moved(base, again) === 0 ? ok('同じ入力で位置が動かない') : bad('決定性', `${moved(base, again)}棟が動いた`);

// 2. ファイルを1つ編集（LOCが変わる＝高さは変わるが位置は変わらないはず）
const target = base.NODES.slice().sort((a, b) => b.fanIn - a.fanIn)[0].id;
const abs = path.join(repo, target);
const before = fs.readFileSync(abs, 'utf8');
let edited;
try {
  fs.writeFileSync(abs, before + '\n'.repeat(40) + 'export const __layoutCheck = 1;\n');
  s.update(abs);
  edited = layout(s.city(), base);
} finally { fs.writeFileSync(abs, before); s.update(abs); }
const m2 = moved(base, edited);
m2 === 0 ? ok('1ファイル編集で位置が動かない', target) : bad('編集の影響', `${m2}棟が動いた`);

// 3. 一番大きい区画にファイルを足す。区画の幅(=ceil(sqrt(件数)))が変わる所まで足して、
//    引き継ぎ有無で既存のビルがどれだけ動くかを比べる
const byDistrict = new Map();
for (const n of base.NODES) byDistrict.set(n.district, (byDistrict.get(n.district) ?? 0) + 1);
const biggest = [...byDistrict.entries()].sort((a, b) => b[1] - a[1])[0][0];
const sample = base.NODES.find((n) => n.district === biggest);
const dir = path.join(repo, path.dirname(sample.id));
const count = byDistrict.get(biggest);
const need = (base.districtCols[biggest] + 1) ** 2 - count + 1; // 区画の幅が1増えるまで足す
const addedPaths = [];
let withNew, withoutPrev;
try {
  for (let i = 0; i < need; i++) {
    const f = path.join(dir, `__layout_check_${i}.ts`);
    fs.writeFileSync(f, `export function layoutCheckAdded${i}() { return ${i}; }\n`);
    addedPaths.push(f);
    s.update(f);
  }
  withNew = layout(s.city(), base);          // 引き継ぎあり
  withoutPrev = layout(s.city());            // 引き継ぎなし（従来の挙動）
} finally {
  for (const f of addedPaths) { fs.rmSync(f, { force: true }); s.update(f); }
}

const m3 = moved(base, withNew);
const m3old = moved(base, withoutPrev);
withNew.NODES.length === base.NODES.length + need
  ? ok(`${need}ファイル追加でビルが建つ`, `${base.NODES.length} → ${withNew.NODES.length}棟（区画 ${biggest} が ${count}→${count + need}件）`)
  : bad('追加', `${withNew.NODES.length}棟`);
const pct = (n) => `${n}棟 (${(n / base.NODES.length * 100).toFixed(1)}%)`;
console.log(`     既存ビルの移動 — 引き継ぎなし: ${pct(m3old)} / 引き継ぎあり: ${pct(m3)}`);
m3 < m3old ? ok('引き継ぎで移動が減る') : bad('引き継ぎ', `減らなかった (${m3} vs ${m3old})`);

// 4. ファイルを削除（跡地が空くだけで、他は動かないはず）
const victim = base.NODES.slice().sort((a, b) => a.fanIn - b.fanIn)[0].id;
const vAbs = path.join(repo, victim);
const vBefore = fs.readFileSync(vAbs, 'utf8');
let removed;
try {
  fs.rmSync(vAbs);
  s.update(vAbs);
  removed = layout(s.city(), base);
} finally { fs.writeFileSync(vAbs, vBefore); s.update(vAbs); }
const m4 = moved(base, removed);
m4 === 0 ? ok('1ファイル削除で他が動かない', victim) : bad('削除の影響', `${m4}棟が動いた`);

console.log(process.exitCode ? '\nFAILED' : '\nALL PASS');
