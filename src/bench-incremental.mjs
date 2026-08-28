// bench-incremental.mjs — 差分抽出の効果測定。使い方: node src/bench-incremental.mjs <repo>
import fs from 'node:fs';
import path from 'node:path';
import { extract, createSession } from './extract.mjs';

const repo = process.argv[2] ?? 'fixtures/synth-2000';
const cache = path.join(process.env.TEMP ?? '.', 'system-map-bench-cache.json');
const ms = (t) => `${Math.round(performance.now() - t)}ms`;

fs.rmSync(cache, { force: true });

let t = performance.now();
const full = extract(repo);
console.log(`全量抽出（キャッシュなし）      : ${ms(t)}  ${full.stats.files} files`);

t = performance.now();
extract(repo, { cache });
console.log(`全量抽出（キャッシュ書き出し）  : ${ms(t)}`);

t = performance.now();
const warm = extract(repo, { cache });
console.log(`再抽出（キャッシュヒット）      : ${ms(t)}  hits=${warm.stats.cacheHits} parsed=${warm.stats.parsed}`);
console.log(`キャッシュサイズ                : ${(fs.statSync(cache).size / 1e6).toFixed(1)}MB`);

const s = createSession(repo);
console.log(`\nセッション初期化                : ${s.initMs}ms  ${s.size()} files`);

// 一番大きいファイルを1つ触って、更新→再組み立ての時間を測る
const target = full.nodes.slice().sort((a, b) => b.loc - a.loc)[0].id;
const abs = path.join(path.resolve(repo), target);
const before = fs.readFileSync(abs, 'utf8');
fs.writeFileSync(abs, before + '\nexport const __benchTouch = 1;\n');
try {
  const u = s.update(abs);
  t = performance.now();
  const city = s.city();
  const assembleMs = performance.now() - t;
  console.log(`1ファイル再解析                 : ${u.parseMs}ms  (${target}, ${full.nodes.find(n => n.id === target).loc} LOC)`);
  console.log(`city.json 再組み立て            : ${Math.round(assembleMs)}ms`);
  console.log(`保存→更新の合計                 : ${Math.round(u.parseMs + assembleMs)}ms  ← 目標<100ms`);
  const touched = city.nodes.find(n => n.id === target);
  console.log(`反映確認                        : ${touched.loc} LOC / __benchTouch=${(touched.syms ?? []).some(x => x.n === '__benchTouch')}`);
} finally {
  fs.writeFileSync(abs, before);
}
fs.rmSync(cache, { force: true });
