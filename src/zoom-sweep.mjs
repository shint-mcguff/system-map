// zoom-sweep.mjs — ズームレベルを掃いて各段で描画破綻がないか検査・撮影する
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:7788/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

const box = await page.locator('#city').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

console.log('zoom sweep: viewBox幅とスケールを記録');
for (let step = 0; step <= 10; step++) {
  // stepごとにズームイン（wheel 3回）
  for (let i = 0; i < 3; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await page.waitForTimeout(40); }
  await page.waitForTimeout(120);
  const state = await page.evaluate(() => {
    const svg = document.getElementById('city');
    const vb = svg.viewBox.baseVal;
    const r = svg.getBoundingClientRect();
    const scene = document.getElementById('scene');
    const bb = scene.getBBox();
    // スクリーン上でのビルの見え方: 最初のビルのtop面のscreen size
    const g = document.querySelector('.b polygon');
    const tb = g ? g.getBBox() : null;
    const s = Math.min(r.width / vb.width, r.height / vb.height);
    return {
      vw: Math.round(vb.width), vh: Math.round(vb.height),
      scale: s.toFixed(2),
      sceneVisible: bb.width > 0,
      tileScreenPx: tb ? Math.round(tb.width * s) : -1,
      labelsShown: document.getElementById('labels').classList.contains('show'),
    };
  });
  console.log(`step${String(step).padStart(2)} vb=${state.vw}x${state.vh} scale=${state.scale} tile≈${state.tileScreenPx}px labels=${state.labelsShown ? 'ON' : 'off'}`);
  if ([0, 3, 6, 9].includes(step)) {
    await page.screenshot({ path: `/tmp/zoom-step${step}.png` });
  }
}
await browser.close();
console.log('screenshots: /tmp/zoom-step{0,3,6,9}.png');
