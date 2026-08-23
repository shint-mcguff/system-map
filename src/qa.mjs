// qa.mjs — Playwright(playwright-core)でsystem-mapを実機テストする
// 使い方: node qa.mjs <url>
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:7788/';
const findings = [];
const ok = (name) => { console.log(`  ✅ ${name}`); };
const bad = (name, detail) => { console.log(`  ❌ ${name}: ${detail}`); findings.push({ name, detail }); };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

console.log('== 1. 初期描画 ==');
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const vb = await page.getAttribute('#city', 'viewBox');
const parts = (vb ?? '').split(/\s+/).map(Number);
if (parts.length === 4 && parts.every(n => Number.isFinite(n)) && parts[2] > 100 && parts[3] > 100) ok(`viewBox正常: "${vb}"`);
else bad('viewBox', `"${vb}" — 幅/高さゼロまたは不正`);

const blockCount = await page.locator('#scene .b').count();
if (blockCount >= 5) ok(`ビル数: ${blockCount}`);
else bad('ビル数', `${blockCount} (<5)`);

const header = await page.textContent('header');
if (header && /files/.test(header)) ok('ヘッダ統計表示');

console.log('== 2. クリック→詳細パネル ==');
// 中央付のビルをクリック
const box = await page.locator('#city').boundingBox();
let panelShown = false;
for (const frac of [0.45, 0.55, 0.35, 0.62, 0.5]) {
  await page.mouse.click(box.x + box.width * frac, box.y + box.height * 0.55);
  await page.waitForTimeout(150);
  panelShown = await page.locator('#panel').isVisible();
  if (panelShown) break;
}
if (!panelShown) {
  // フォールバック: data-id経由で直接クリック（DOMは生きてるかの確認）
  const any = page.locator('#scene .b').first();
  await any.click({ force: true });
  await page.waitForTimeout(150);
  panelShown = await page.locator('#panel').isVisible();
}
if (panelShown) {
  const txt = await page.textContent('#panel');
  if (/kind|exports/.test(txt)) ok('パネル表示＋内容あり');
  else bad('パネル内容', txt.slice(0, 60));
} else bad('詳細パネル', 'どの座標をクリックしても開かない');

console.log('== 3. ドラッグ→消え問題 ==');
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.mouse.down();
for (let i = 1; i <= 8; i++) {
  await page.mouse.move(box.x + box.width * 0.5 + i * 25, box.y + box.height * 0.5 + i * 10);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(200);
const visibleAfterDrag = await page.evaluate(() => {
  const svg = document.getElementById('city');
  const vb = svg.viewBox.baseVal;
  // シーンの実bboxとviewBoxの交差を確認
  const scene = document.getElementById('scene');
  const bb = scene.getBBox();
  const overlapX = Math.min(vb.x + vb.width, bb.x + bb.width) - Math.max(vb.x, bb.x);
  const overlapY = Math.min(vb.y + vb.height, bb.y + bb.height) - Math.max(vb.y, bb.y);
  return { overlapX, overlapY, vb: `${vb.x} ${vb.y} ${vb.width} ${vb.height}`, sceneBBox: `${bb.x},${bb.y} ${bb.width}x${bb.height}` };
});
if (visibleAfterDrag.overlapX > 0 && visibleAfterDrag.overlapY > 0) ok(`ドラッグ後も都市が視野内（交差 ${Math.round(visibleAfterDrag.overlapX)}x${Math.round(visibleAfterDrag.overlapY)}）`);
else bad('ドラッグ後消失', `viewBox=(${visibleAfterDrag.vb}) vs scene(${visibleAfterDrag.sceneBBox}) — 視野外に飛んだ`);

console.log('== 4. ズーム連動ラベル ==');
// ホイールで拡大
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60); }
await page.waitForTimeout(200);
const labelsVisible = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.flabel')];
  return { total: els.length, shown: els.filter(e => e.style.display !== 'none').length };
});
if (labelsVisible.total > 0 && labelsVisible.shown > 0) ok(`拡大でラベル出現: ${labelsVisible.shown}/${labelsVisible.total}`);
else if (labelsVisible.total === 0) bad('ズームラベル', '.flabel要素が1つも生成されていない');
else bad('ズームラベル', `生成${labelsVisible.total}件だが表示0 — しきい値か座標更新の不具合`);

console.log('== 5. ダブルクリックリセット ==');
await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(200);
const vbNow = await page.getAttribute('#city', 'viewBox');
if (vbNow === vb) ok(`リセット成功 (${vbNow})`);
else bad('ダブルクリックリセット', `"${vbNow}" ≠ 初期 "${vb}"`);

console.log('== 6. JSエラー ==');
if (errors.length === 0) ok('コンソールエラーなし');
else bad('JSエラー', errors.slice(0, 3).join(' | '));

await browser.close();
console.log('\n==== 総合 ====');
if (findings.length === 0) console.log('ALL PASS');
else { console.log(`${findings.length}件の不具合:`); for (const f of findings) console.log(`- [${f.name}] ${f.detail}`); }
process.exit(findings.length ? 1 : 0);
