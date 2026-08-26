#!/usr/bin/env node
// insightsバッチランナー: 上位シンボルの one/what を claude -p (Max枠・オフライン一括) で生成し
// insights.json にキャッシュする。手編集のエントリは保護（上書きしない）。
// 使い方: node src/insights.mjs <city.json> [--root <repoRoot>] [--out insights.json] [--limit 50] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function rankSymbols(city, limit) {
  // 重要度 = 呼び出しfan-in × 2 + import fan-in + LOC/200。上位だけLLMに渡す
  const callFan = new Map();
  for (const c of city.calls ?? []) {
    const k = c.t + '::' + c.ts;
    callFan.set(k, (callFan.get(k) ?? 0) + 1);
  }
  const out = [];
  for (const n of city.nodes) {
    for (const s of n.syms ?? []) {
      if (s.k === 'type' || s.k === 'route') continue;
      const cf = callFan.get(n.id + '::' + s.n) ?? 0;
      const score = cf * 2 + n.fanIn + n.loc / 200;
      if (score <= 0.5) continue; // 無名の定数等は飛ばす
      out.push({ file: n.id, kind: n.kind, name: s.n, l: s.l, e: s.e ?? s.l, score, callFan: cf });
    }
    // ファイルレベルも候補に（hotビル）
    if (n.fanIn >= 3) out.push({ file: n.id, kind: n.kind, name: '_file', l: 1, e: n.loc, score: n.fanIn * 1.5, callFan: 0 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

function readSnippet(root, file, l, e) {
  try {
    const src = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    return src.slice(Math.max(0, l - 1), Math.min(e, l + 40)).join('\n').slice(0, 1800);
  } catch { return ''; }
}

function askClaude(prompt) {
  return new Promise((resolve) => {
    execFile('claude', ['-p', '--output-format', 'json', prompt], { timeout: 120000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err && !stdout) { resolve(null); return; }
      try {
        const j = JSON.parse(stdout);
        resolve(j.result ?? j.content ?? null);
      } catch { resolve(stdout.trim() || null); }
    });
  });
}

const WANTED = 'Return ONLY compact JSON: {"one":"<one sentence in Japanese, what this is>","what":"<2-3 sentences in Japanese: what it does and how>}';

if (process.argv[1] && process.argv[1].endsWith('insights.mjs')) {
  const args = process.argv.slice(2);
  const cityPath = args[0];
  if (!cityPath || !fs.existsSync(cityPath)) { console.error('usage: node src/insights.mjs <city.json> [--root dir] [--out f] [--limit N] [--dry]'); process.exit(1); }
  const get = (flag, dflt) => { const i = args.indexOf(flag); return i > 0 ? args[i + 1] : dflt; };
  const root = get('--root', path.dirname(cityPath));
  const outFile = get('--out', 'insights.json');
  const limit = parseInt(get('--limit', '50'), 10);
  const dry = args.includes('--dry');

  const city = JSON.parse(fs.readFileSync(cityPath, 'utf8'));
  const insights = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
  const ranked = rankSymbols(city, limit);

  let made = 0, skipped = 0;
  for (const r of ranked) {
    const key = r.name === '_file' ? '_file/' + r.file : `${r.file}::${r.name}`;
    if (insights[key]?.lock || insights[key]?.gen === 'claude') { skipped++; continue; } // 手書き＆再生成済みを保護
    if (dry) { console.log(`[dry] ${key} (score ${r.score.toFixed(1)})`); continue; }
    const snippet = readSnippet(root, r.file, r.l, Math.max(r.e, r.l));
    if (!snippet.trim()) continue;
    const prompt = `You are documenting a codebase for an interactive 3D map. File: ${r.file} (${r.kind}), symbol: ${r.name}.\n\n\`\`\`\n${snippet}\n\`\`\`\n\n${WANTED}`;
    process.stdout.write(`→ ${key} ... `);
    const res = await askClaude(prompt);
    if (!res) { console.log('FAIL'); continue; }
    try {
      const m = String(res).match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(m[0]);
      if (parsed.one) {
        insights[key] = { one: parsed.one, what: parsed.what ?? '', gen: 'claude', date: new Date().toISOString().slice(0, 10) };
        made++;
        console.log('OK');
      } else { console.log('BAD SHAPE'); }
    } catch { console.log('PARSE ERR'); }
    await new Promise(rs => setTimeout(rs, 300)); // 端末負荷のなだめ
  }
  fs.writeFileSync(outFile, JSON.stringify(insights, null, 1));
  console.log(`insights: ${made} generated, ${skipped} protected/skipped -> ${outFile}`);
}
