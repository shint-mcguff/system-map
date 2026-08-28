// worker.mjs — 解析と描画を拡張ホストの外でやる子プロセス。
// createSession を常駐させ、保存されたファイルだけ再解析して city.json → HTML を組む。
// 拡張ホスト(UIスレッド)を数秒ブロックしないための分離。
import fs from 'node:fs';
import path from 'node:path';
import { createSession } from '../src/extract.mjs';
import { layout, render } from '../src/render3d.mjs';

let session = null;

// timeline-<repo>.json / insights.json がリポジトリ直下にあれば拾う（無くても動く）
function sidecars(root) {
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  return {
    timeline: readJson(path.join(root, `timeline-${path.basename(root)}.json`)) ?? readJson(path.join(root, 'timeline.json')),
    insights: readJson(path.join(root, 'insights.json')) ?? {},
  };
}

process.on('message', (m) => {
  try {
    if (m.type === 'init') {
      session = createSession(m.root);
      process.send({ id: m.id, type: 'ready', files: session.size(), ms: session.initMs });
    } else if (m.type === 'update') {
      const results = (m.files ?? []).map((f) => session.update(f)).filter(Boolean);
      process.send({ id: m.id, type: 'updated', results });
    } else if (m.type === 'scene') {
      // 差分更新: HTMLを作り直さず、レイアウト結果だけwebviewへ送る
      const t = performance.now();
      const city = session.city();
      process.send({
        id: m.id, type: 'scene', data: layout(city),
        ms: Math.round(performance.now() - t),
      });
    } else if (m.type === 'render') {
      const t = performance.now();
      const city = session.city();
      const { timeline, insights } = sidecars(session.root);
      const r = render(city, { out: null, timeline, insights });
      process.send({
        id: m.id, type: 'html', html: r.html, stats: city.stats,
        ms: Math.round(performance.now() - t),
        ids: city.nodes.map((n) => n.id),
      });
    }
  } catch (err) {
    process.send({ id: m.id, type: 'error', message: String(err && err.stack || err) });
  }
});
