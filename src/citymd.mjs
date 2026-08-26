#!/usr/bin/env node
// CITY.md生成器: city.json (+任意insights.json) から街の要約を吐く。
// 用途: エージェントや人が「このコードベースの全体像」を1枚で掴むためのテキスト双子。
// 使い方: node src/citymd.mjs city-fox.json [CITY.md] [--insights insights.json]
import fs from 'node:fs';
import path from 'node:path';

export function generateCityMd(city, insights = {}) {
  const { nodes, edges, calls = [], stats } = city;
  const byDistrict = new Map();
  for (const n of nodes) {
    (byDistrict.get(n.district) ?? byDistrict.set(n.district, []).get(n.district)).push(n);
  }
  const hot = [...nodes].sort((a, b) => b.fanIn - a.fanIn || b.loc - a.loc).slice(0, 8);
  const big = [...nodes].sort((a, b) => b.loc - a.loc).slice(0, 5);
  const orphans = nodes.filter(n => n.fanIn === 0 && n.deps.length === 0 && n.kind !== 'page' && n.kind !== 'module');
  // 呼び出しグラフ: 関数レベルfan-in上位
  const symFan = new Map();
  for (const c of calls) {
    const k = `${c.t}::${c.ts}`;
    symFan.set(k, (symFan.get(k) ?? 0) + 1);
  }
  const hotFns = [...symFan.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => ({ k, v }));

  const L = [];
  L.push(`# ${city.root} — City Report`);
  L.push('');
  L.push(`> generatedAt: ${city.generatedAt} · ${stats.files} files / ${stats.loc} LOC / ${stats.edges} import edges / ${calls.length} call edges / ${stats.districts} districts`);
  L.push('');
  L.push('## 街の概要');
  L.push('');
  L.push(`このリポジトリは${stats.districts}区画・${stats.files}棟の街。`);
  L.push(`最も依存を集めるビルは **${hot[0]?.id}**（fan-in ${hot[0]?.fanIn}）。ここが改修時の最重要箇所。`);
  if (hotFns[0]) {
    const [f, fn] = hotFns[0].k.split('::');
    L.push(`最も呼ばれる関数は **${fn}**（\`${f}\`、×${hotFns[0].v}）。`);
  }
  L.push('');
  L.push('## 区画一覧');
  L.push('');
  L.push('| 区画 | files | LOC | 主要ビル |');
  L.push('|---|---|---|---|');
  for (const [d, list] of [...byDistrict.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const loc = list.reduce((s, n) => s + n.loc, 0);
    const top = list.sort((a, b) => b.fanIn - a.fanIn)[0];
    L.push(`| ${d} | ${list.length} | ${loc} | ${top.id.split('/').pop()} (fan-in ${top.fanIn}) |`);
  }
  L.push('');
  L.push('## 最重要ビル（fan-in上位）');
  L.push('');
  L.push('| ファイル | kind | fan-in | LOC | one |');
  L.push('|---|---|---|---|---|');
  for (const n of hot) {
    const ins = insights[n.id] ?? insights['_file/' + n.id] ?? {};
    L.push(`| \`${n.id}\` | ${n.kind} | ${n.fanIn} | ${n.loc} | ${ins.one ?? '—'} |`);
  }
  L.push('');
  L.push('## 最大ビル（LOC上位）');
  L.push('');
  for (const n of big) {
    const syms = (n.syms ?? []).filter(s => s.k === 'fn' || s.k === 'class').slice(0, 6).map(s => s.n);
    L.push(`- \`${n.id}\` (${n.loc} LOC): ${syms.join(', ') || '—'}`);
  }
  L.push('');
  if (hotFns.length) {
    L.push('## よく呼ばれる関数（呼び出しfan-in上位）');
    L.push('');
    L.push('| 関数 | 場所 | ×calls |');
    L.push('|---|---|---|');
    for (const { k, v } of hotFns) {
      const [f, fn] = k.split('::');
      L.push(`| ${fn} | \`${f}\` | ${v} |`);
    }
    L.push('');
  }
  if (orphans.length) {
    L.push(`## 孤立ビル（importもされずimportもしない: ${orphans.length}件）`);
    L.push('');
    for (const n of orphans.slice(0, 10)) L.push(`- \`${n.id}\` (${n.kind}, ${n.loc} LOC)`);
    L.push('');
  }
  L.push('## 見方');
  L.push('');
  L.push('- `node src/render3d.mjs ' + path.basename(process.argv[2] ?? 'city.json') + ' dist/view.html` で3D地図を開ける。ビルクリック→関数→呼び出しウォーク。');
  L.push('- 本ファイルはcity.jsonから自動生成。手編集はinsights.jsonへ（one/whatを書くとこちらに反映）。');
  return L.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('citymd.mjs')) {
  const cityPath = process.argv[2];
  if (!cityPath) { console.error('usage: node src/citymd.mjs <city.json> [out.md]'); process.exit(1); }
  const city = JSON.parse(fs.readFileSync(cityPath, 'utf8'));
  let insights = {};
  const iArg = process.argv.indexOf('--insights');
  const iPath = iArg > 0 ? process.argv[iArg + 1] : null;
  if (iPath && fs.existsSync(iPath)) insights = JSON.parse(fs.readFileSync(iPath, 'utf8'));
  const md = generateCityMd(city, insights);
  const out = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'CITY.md';
  fs.writeFileSync(out, md);
  console.log(`CITY.md written (${md.split('\n').length} lines) -> ${out}`);
}
