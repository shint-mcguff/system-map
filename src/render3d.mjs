// render3d.mjs — city.json を three.js アイソメ都市の自己完結HTMLにする
// three.module.min.js をインライン埋め込み → 出力は依存ゼロの1枚
import fs from 'node:fs';
import path from 'node:path';

const THREE_SRC = new URL('../node_modules/three/build/three.module.min.js', import.meta.url);
const THREE_CORE_SRC = new URL('../node_modules/three/build/three.core.min.js', import.meta.url);

const KIND_COLORS = {
  page: 0xe0b34c, component: 0x7fb069, api: 0xd96c47, hook: 0x5aa9d6,
  lib: 0x9b7fd4, type: 0x6e6858, test: 0x5f7d5f, module: 0xb0a486,
};
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export function render(city, opts = {}) {
  const t0 = performance.now();
  const nodes = city.nodes;

  // --- レイアウト（密集街区: 建物はタイル整数座標にスナップ。道幅1タイル） ---
  const TILE = 4; // グリッド1マス=4世界単位。全座標はTILE整数倍でグリッド線に吸着させる
  const districts = new Map();
  for (const n of nodes) {
    if (!districts.has(n.district)) districts.set(n.district, []);
    districts.get(n.district).push(n);
  }
  const names = [...districts.keys()].sort((a, b) =>
    (districts.get(b).length - districts.get(a).length) || (a < b ? -1 : 1));
  const pos = new Map();
  const plates = []; // { name, ox, oy, cols, rows } すべてタイル単位
  const GAP = 1;
  const shapeOf = count => {
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    return { cols, rows: Math.ceil(count / cols) };
  };
  const widest = Math.max(...names.map(n => shapeOf(districts.get(n).length).cols));
  const shelfCols = Math.max(Math.ceil(Math.sqrt(nodes.length)), widest);
  let ox = 0, oy = 0, rowRows = 0;
  names.forEach(name => {
    const files = districts.get(name).sort((a, b) => (b.fanIn - a.fanIn) || (b.loc - a.loc));
    const { cols, rows } = shapeOf(files.length);
    if (ox > 0 && ox + cols > shelfCols) { ox = 0; oy += rowRows + GAP; rowRows = 0; }
    files.forEach((n, j) => {
      const c = ox + (j % cols), r = oy + Math.floor(j / cols);
      pos.set(n.id, { x: c * TILE, z: r * TILE }); // 整数タイル → グリッド境界に吸着
    });
    plates.push({ name, ox, oy, cols, rows });
    ox += cols + GAP;
    rowRows = Math.max(rowRows, rows);
  });

  const maxLoc = Math.max(...nodes.map(n => n.loc), 1);
  const maxFan = Math.max(...nodes.map(n => n.fanIn), 1);
  const heightOf = n => 2 + 22 * Math.pow(n.fanIn / maxFan, 0.7) + 4 * (n.loc / maxLoc);

  // --- three.jsシーンデータ（JS側でメッシュ生成させる） ---
  const sceneData = nodes.map(n => {
    const p = pos.get(n.id);
    return {
      id: n.id, kind: n.kind, district: n.district, loc: n.loc, fanIn: n.fanIn,
      deps: n.deps, syms: n.syms,
      x: p.x, z: p.z, h: heightOf(n),
      color: KIND_COLORS[n.kind] ?? KIND_COLORS.module,
    };
  });
  const CALLS = (city.calls ?? []).map(c => ({ f: c.f, fs: c.fs, t: c.t, ts: c.ts }));
  const PM = 0.3; // プレートの薄い縁
  const plateData = plates.map(p => ({
    name: p.name,
    x: (p.ox + (p.cols - 1) / 2) * TILE,
    z: (p.oy + (p.rows - 1) / 2) * TILE,
    w: p.cols * TILE + 2 * PM,
    d: p.rows * TILE + 2 * PM,
  }));
  // 街のバウンディボックス中心（カメラ初期位置・リセット先）
  let bb0=Infinity,bb1=-Infinity,bb2=Infinity,bb3=-Infinity;
  for(const p of plateData){
    bb0=Math.min(bb0,p.x-p.w/2);bb1=Math.max(bb1,p.x+p.w/2);
    bb2=Math.min(bb2,p.z-p.d/2);bb3=Math.max(bb3,p.z+p.d/2);
  }
  const CITY_CX=((bb0+bb1)/2).toFixed(1), CITY_CZ=((bb2+bb3)/2).toFixed(1);

  // エッジ（fan-in上位220）— 3D座標(x,z,高さ)を持たせる
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = city.edges
    .slice().sort((a, b) => byId.get(b.to).fanIn - byId.get(a.to).fanIn)
    .slice(0, 220)
    .map(e => {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return null;
      return {
        a: { x: a.x, z: a.z, h: heightOf(byId.get(e.from)) },
        b: { x: b.x, z: b.z, h: heightOf(byId.get(e.to)) },
      };
    }).filter(Boolean);

  const stats = city.stats;
  const kindLegend = Object.entries(KIND_COLORS).map(([k, c]) =>
    `<span class="lg"><i style="background:#${c.toString(16).padStart(6, '0')}"></i>${k}</span>`).join('');

  const threeSrc = fs.readFileSync(THREE_SRC, 'utf8');
  // three.module.min.jsは./three.core.min.jsをimportするため、
  // blob URL内で相対解決できるようcoreもblob化してimportmapで束ねる
  const threeCoreSrc = fs.readFileSync(THREE_CORE_SRC, 'utf8');

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>System Map 3D — ${esc(city.root)}</title>
<style>
:root{--bg:#efe8d6;--ink:#14120b;--card:#faf6ea;--accent:#d96c47}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}
header{position:fixed;top:0;left:0;right:0;z-index:10;padding:10px 20px;border-bottom:2px solid var(--ink);display:flex;gap:18px;align-items:center;flex-wrap:wrap;background:var(--card)}
header h1{font-size:16px;letter-spacing:.04em}
.stat b{font-size:15px}.stat span{opacity:.65;font-size:11px}
.legend{display:flex;gap:8px;flex-wrap:wrap;font-size:11px}
.lg i{display:inline-block;width:9px;height:9px;margin-right:4px;vertical-align:-1px;border:1px solid #14120b}
.meaning{font-size:11px;opacity:.75;border-left:3px solid var(--accent);padding-left:8px}
.mbtn{font:12px/1 inherit;padding:6px 12px;border:1.5px solid var(--ink);background:var(--card);cursor:pointer;color:var(--ink)}
.mbtn:hover{background:var(--accent);color:#fff}
#q{font:12px/1.4 inherit;padding:5px 9px;border:1.5px solid var(--ink);background:#fff;width:160px}
#results{position:fixed;top:56px;right:20px;width:300px;max-height:50vh;overflow:auto;background:var(--card);border:2px solid var(--ink);display:none;z-index:11}
#results .r{padding:6px 10px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
#results .r:hover{background:var(--accent);color:#fff}
#results .r small{opacity:.6}
#stage{position:fixed;inset:0}
#stage canvas{display:block;cursor:grab}#stage canvas.grabbing{cursor:grabbing}
#panel{position:fixed;top:64px;right:12px;width:320px;max-height:calc(100vh - 140px);overflow:auto;background:var(--card);border:2px solid var(--ink);padding:14px;display:none;z-index:9}
#panel h2{font-size:13px;word-break:break-all}
#panel .row{display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px dashed #d8cfb4}
#panel .sec{margin-top:10px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.6;border-bottom:1px solid #d8cfb4;padding-bottom:2px}
#panel .sym{font-size:11px;padding:2px 0;cursor:pointer}
#panel .sym:hover{background:rgba(217,108,71,.12)}
#panel .sym i{font-style:normal;color:var(--accent);margin-right:6px}
#panel .sym span{opacity:.45;margin-left:auto;float:right}
#panel .chip{display:inline-block;width:9px;height:9px;margin-right:6px;border:1px solid var(--ink);vertical-align:baseline}
#panel .one{font-size:12px;line-height:1.55;margin:8px 0 4px}
#panel details.more summary{cursor:pointer;font-size:11px;opacity:.6;user-select:none}
#panel details.more[open] summary{opacity:.4}
#panel .deps{margin-top:8px;font-size:11px;line-height:1.7;word-break:break-all}
#panel .deps a{color:var(--accent);cursor:pointer}
.hint{margin-left:auto;font-size:11px;opacity:.55}
#timebar{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;display:flex;gap:8px;align-items:center;background:var(--card);border:2px solid var(--ink);padding:8px 12px;z-index:10;width:min(92vw,760px)}
#tb-play{flex:none;width:34px;height:30px;border:1.5px solid var(--ink);background:var(--accent);color:#fff;cursor:pointer}
#tb-now{flex:none;height:30px;border:1.5px solid var(--ink);background:var(--card);cursor:pointer;font:11px inherit;padding:0 10px;color:var(--ink)}
#tb-range{flex:1;min-width:60px;accent-color:var(--accent)}
#tb-label{flex:1;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
@media(max-width:720px){
  header{gap:10px;padding:8px 12px}.meaning,.hint{display:none}
  #timebar{flex-wrap:wrap;bottom:8px}
  #tb-label{order:-1;width:100%;flex:none}
  #panel{width:calc(100vw - 24px)}
}
</style></head><body>
<header>
<h1>⬡ ${esc(city.root)}</h1>
<span class="stat"><b>${stats.files}</b><span>files</span></span>
<span class="stat"><b>${stats.loc.toLocaleString()}</b><span>loc</span></span>
<span class="stat"><b>${stats.edges}</b><span>imports</span></span>
<span class="legend">${kindLegend}</span>
<span class="meaning">高さ＝使われている数 · 色＝種類</span>
<button id="mode-flow" class="mbtn">⇢ フローで見る</button>
<input id="q" placeholder="⌕ 検索 ( / )" autocomplete="off">
<div id="results"></div>
<span class="hint">drag:移動 · 右drag/⌘drag:回転 · wheel:ズーム · click:詳細 · dbl-click:リセット</span>
</header>
<div id="stage"></div>
<div id="panel"></div>
${opts.timeline ? `<div id="timebar"><button id="tb-play">▶︎</button><input type="range" id="tb-range" min="0" value="0"><span id="tb-label"></span><button id="tb-now">現在</button></div>` : ''}
<script type="module">
// three.jsをインラインで読み込む。three.moduleは./three.core.min.jsに依存するため、
// coreを先にblob化→そのURLを差し込んだmodule文字列をさらにblob化してimportする
const coreBlob = new Blob([${JSON.stringify(threeCoreSrc)}], {type:'text/javascript'});
const coreUrl = URL.createObjectURL(coreBlob);
const mainSrc = ${JSON.stringify(threeSrc)}.split('\\"./three.core.min.js\\"').join(JSON.stringify(coreUrl));
const threeBlob = new Blob([mainSrc], {type:'text/javascript'});
const THREE = await import(URL.createObjectURL(threeBlob));

var NODES=${JSON.stringify(sceneData)};
var EDGES=${JSON.stringify(edges)};
var CALLS=${JSON.stringify(CALLS)};
var NOTES=${JSON.stringify(opts.annotations ?? {})};
var TIMELINE=${JSON.stringify(opts.timeline ?? null)};
// 種別ごとの一文説明（アノテーションがなければこれ。insightsで上書き前提のフォールバック）
var ONE_LINERS={page:'ユーザーが触る画面。この街の表玄関。',component:'UIの部品。画面を組み上げるレンガ。',api:'外の世界との窓口。リクエストを受け処理を依頼する。',hook:'状態と副作用を束ねる、Reactの神経。',lib:'横串のロジック。各棟から呼ばれる公共施設。',type:'データの契約書。街中の会話の語彙を定める。',test:'品質の門番。',module:'設定・基盤。街のインフラ。'};
function besc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ---- シーン基本 ----
const stage=document.getElementById('stage');
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setSize(innerWidth,innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
stage.appendChild(renderer.domElement);
const scene=new THREE.Scene();
scene.background=new THREE.Color(0xefe8d6);
scene.fog=new THREE.Fog(0xefe8d6,260,520);

// アイソメ風: OrthographicCamera。回転・ズーム・パン対応
const aspect=innerWidth/innerHeight;
const FRUSTUM=90;
let camera=new THREE.OrthographicCamera(-FRUSTUM*aspect/2,FRUSTUM*aspect/2,FRUSTUM/2,-FRUSTUM/2,0.1,2000);

// 建設: グループ階層（回転の中心は街の中心）
const cityGroup=new THREE.Group();
scene.add(cityGroup);

// ライティング（明るめ: ambient強め+主光2灯）
scene.add(new THREE.AmbientLight(0xffffff,0.72));
const hemi=new THREE.HemisphereLight(0xfff8ec,0xcabb9a,0.45);
scene.add(hemi);
const sun=new THREE.DirectionalLight(0xffffff,1.1);
sun.position.set(60,140,40);scene.add(sun);
const fill=new THREE.DirectionalLight(0xe8f0ff,0.5);
fill.position.set(-60,90,-70);scene.add(fill);

// 地面プレート（区画）— {x,z}=ブロック中心, w×d=実寸+薄い縁
const TILE=${TILE};
const groundMat=new THREE.MeshLambertMaterial({color:0xe6ddc4});
for(const p of ${JSON.stringify(plateData)}){
  const geo=new THREE.BoxGeometry(p.w,0.4,p.d);
  const m=new THREE.Mesh(geo,groundMat);
  m.position.set(p.x,-0.2,p.z);
  cityGroup.add(m);
}

// ベースグリッド（線を建物のタイル境界に正確に合わせる）
(function buildGrid(){
  var minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for(const n of NODES){minX=Math.min(minX,n.x);maxX=Math.max(maxX,n.x);minZ=Math.min(minZ,n.z);maxZ=Math.max(maxZ,n.z);}
  var pad=TILE*4;
  // 建物中心=TILE整数倍 → 境界は±TILE/2。線の始点を境界に置けば全線が境界に乗る
  var x0=minX-TILE/2-pad, z0=minZ-TILE/2-pad;
  var S=Math.max(maxX+TILE/2+pad-x0, maxZ+TILE/2+pad-z0);
  var grid=new THREE.GridHelper(S,Math.round(S/TILE),0xc9bd9c,0xd8cfb4);
  grid.position.set(x0+S/2,-0.02,z0+S/2);
  cityGroup.add(grid);
})();

// ビル（InstancedMeshでなく個別メッシュ: 高さ個別変更とピッキングのため）+ アウトライン
const boxGeo=new THREE.BoxGeometry(TILE*0.86,1,TILE*0.86);
boxGeo.translate(0,0.5,0); // 底面基準にする（scale.yで高さ変更）
const edgeGeo=new THREE.EdgesGeometry(boxGeo);
const outlineMat=new THREE.LineBasicMaterial({color:0x14120b});
const meshes={};
const pickables=[];
for(const n of NODES){
  const mat=new THREE.MeshLambertMaterial({color:n.color});
  const m=new THREE.Mesh(boxGeo,mat);
  m.position.set(n.x,0,n.z);
  m.scale.y=n.h;
  m.userData.node=n;
  const ol=new THREE.LineSegments(edgeGeo,outlineMat.clone());
  m.add(ol); // アウトライン: scale.yに追従して伸びる
  cityGroup.add(m);pickables.push(m);meshes[n.id]=m;
}
// 新築マーカー: 地面に呼吸するリング（錐より静かに「ここ新規」を示す）
const ringGeo=new THREE.RingGeometry(TILE*0.55,TILE*0.72,40);
ringGeo.rotateX(-Math.PI/2);
// 建設予定地の区画（ビル足元サイズの平面）
const lotGeo=new THREE.PlaneGeometry(TILE*0.86,TILE*0.86);
lotGeo.rotateX(-Math.PI/2);
// 建設予定地のストライプテクスチャ（斜め縞・透過）
const stripes=(function(){
  var cv=document.createElement('canvas');cv.width=cv.height=28;
  var g=cv.getContext('2d');
  g.strokeStyle='rgba(110,102,84,0.9)';g.lineWidth=6;
  g.beginPath();
  for(var i=-1;i<3;i++){g.moveTo(i*14-14,28);g.lineTo(i*14+14,0);}
  g.stroke();
  var tx=new THREE.CanvasTexture(cv);
  tx.wrapS=tx.wrapT=THREE.RepeatWrapping;
  return tx;
})();

// エッジ（呼び出しを弧で描く）: 主線は太めのグレー、太さはfan-in比例
// タイムラインでビル高さが動くので、端点のscale.yに毎フレーム追従して弧を張り直す。
// 高さが変わらなかったエッジは再生成しない（idle時コストほぼゼロ）
const edgeGroup=new THREE.Group();cityGroup.add(edgeGroup);
const nodeAt={};
for(const n of NODES)nodeAt[n.x+','+n.z]=n;
const liveEdges=[]; // {m, ra(radius), ha, hb}
function rebuildEdges(){
  while(edgeGroup.children.length){const c=edgeGroup.children[0];edgeGroup.remove(c);c.geometry.dispose();c.material.dispose();}
  const maxFan=Math.max(...NODES.map(n=>n.fanIn),1);
  for(const e of EDGES){
    const na=nodeAt[e.a.x+','+e.a.z], nb=nodeAt[e.b.x+','+e.b.z];
    if(!na||!nb)continue;
    const importance=Math.pow(nb.fanIn/maxFan,0.6);      // 0..1（fan-in比例）
    const radius=0.02+importance*0.05;                   // ヘアライン寄り
    var col=importance>0.45?0x6f6754:0xb3ab92;
    var op=0.2+importance*0.28;                          // 既定0.2、主線でも~0.48
    const m=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshLambertMaterial({color:col,transparent:true,opacity:op}));
    m.userData={aM:meshes[na.id],bM:meshes[nb.id],col:col,op:op};
    edgeGroup.add(m);
    liveEdges.push({m:m,ra:radius,ha:-1,hb:-1});
  }
}
rebuildEdges();
function updateEdgeHeights(){
  for(const e of liveEdges){
    const ma=e.m.userData.aM, mb=e.m.userData.bM;
    if(!ma||!mb||!ma.visible||!mb.visible){e.m.visible=false;continue;} // 未誕生ビルへは配線しない
    e.m.visible=true;
    var ha=Math.round(ma.scale.y*10)/10, hb=Math.round(mb.scale.y*10)/10; // 量子化で再張りを抑制
    if(ha===e.ha&&hb===e.hb)continue;
    e.ha=ha;e.hb=hb;
    e.m.geometry.dispose();
    const curve=new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(ma.position.x,ha,ma.position.z),
      new THREE.Vector3((ma.position.x+mb.position.x)/2,Math.max(ha,hb)+16,(ma.position.z+mb.position.z)/2),
      new THREE.Vector3(mb.position.x,hb,mb.position.z));
    e.curve=curve; // パケットが弧上を歩くのに使う
    e.m.geometry=new THREE.TubeGeometry(curve,20,e.ra,5,false);
  }
}

// ---- パケット: ワイヤ上を流れる点（ウォーク=呼び出し連鎖の追跡 / 常時=fan-in上位の静かな流れ） ----
const packetGroup=new THREE.Group();cityGroup.add(packetGroup);
function makePacket(color,size){
  const m=new THREE.Mesh(new THREE.SphereGeometry(size||0.55,10,8),new THREE.MeshBasicMaterial({color:color||0xd96c47}));
  m.visible=false;
  packetGroup.add(m);
  return m;
}
// edgeKey(aFile,bFile)→liveEdge。方向はa→b固定だがcurveは逆走できる
var edgeByKey=null;
function findEdge(fa,fb){
  if(!edgeByKey){
    edgeByKey={};
    for(const le of liveEdges){
      const A=le.m.userData.aM,B=le.m.userData.bM;
      if(!A||!B)continue;
      edgeByKey[A.userData.node.id+'|'+B.userData.node.id]=le;
    }
  }
  return edgeByKey[fa+'|'+fb]||edgeByKey[fb+'|'+fa];
}
// ウォーク: 選択関数からcalls連鎖をDFS（深さ≤5・訪問済み抑止）→経路の弧リストを作る
var walk=null; // {hops:[{le,rev,t}], i, t, flash:[mesh...]}
function buildRoute(file,fn){
  const adj={}; // key: file::fn → 隣接ノード配列
  for(const c of CALLS){
    const k=c.f+'::'+c.fs;
    (adj[k]=adj[k]||[]).push({f:c.t,fs:c.ts});
    // 呼ばれ側からの逆辺も探索に含める（誰が自分を呼んでるかも追える）
    (adj[c.t+'::'+c.ts]=adj[c.t+'::'+c.ts]||(adj[c.t+'::'+c.ts]=[])).push({f:c.f,fs:c.fs,back:true});
  }
  const seen=new Set([file+'::'+fn]);
  const route=[];
  function dfs(f,fn,depth){
    if(depth>=5)return;
    for(const nx of (adj[f+'::'+fn])||[]){
      const key=nx.f+'::'+nx.fs;
      if(seen.has(key))continue;
      seen.add(key);
      const le=findEdge(f,nx.f);
      if(le){route.push({le:le,aF:f,bF:nx.f});}
      dfs(nx.f,nx.fs,depth+1);
      if(route.length>=12)return; // 経路は最大12ホップで十分読める
    }
  }
  dfs(file,fn,0);
  return route;
}
function startWalk(file,fn){
  stopWalk();
  const hops=buildRoute(file,fn).map(function(h,i){
    return {le:h.le,aF:h.aF,t:-i*0.45}; // 負のt=開始待ち（前のパケットが弧の中腹で次が発車）
  });
  walk={hops:hops};
  window.__walkState=function(){return {hops:hops.length,active:hops.filter(function(h){return h.t>=0&&h.t<1}).length,done:hops.filter(function(h){return h.t>=1}).length};};
}
window.__packets=function(){ // QA用: 流動中パケット数
  var v=0;for(var i=0;i<packetGroup.children.length;i++)if(packetGroup.children[i].visible)v++;
  return {visible:v,ambient:ambient.length};
};
function stopWalk(){
  walk=null;
  window.__walkState=function(){return null;};
}
// 常時パケット: fan-in上位ワイヤを静かに流す（量は少なく）
var ambient=[];
function seedAmbient(){
  const byFan=[...NODES].sort((a,b)=>b.fanIn-a.fanIn).slice(0,6); // fan-in上位6ビルに入る線
  let n=0;
  for(const le of liveEdges){
    const A=le.m.userData.aM,B=le.m.userData.bM;
    if(!A||!B)continue;
    if(byFan.some(nd=>nd.id===B.userData.node.id)){
      ambient.push({le:le,m:makePacket(0xb3ab92,0.4),t:Math.random(),speed:0.0016+Math.random()*0.0012});
      if(++n>=10)break; // 同時に流れるのは10個まで
    }
  }
}
seedAmbient();

// ---- カメラ操作（ドラッグ=パン / 右・⌘+Ctrl+ドラッグ=回転）----
let yaw=Math.PI/4, pitch=Math.PI/5, zoom=1, target=new THREE.Vector3(${CITY_CX},0,${CITY_CZ});
window.__cam=function(){return {yaw,pitch,zoom,target:{x:target.x,z:target.z}}}; // QA用
window.__select=function(id){selectNode(id);return window.__sel?window.__sel():{sel:id}}; // QA用
function updateCamera(){
  const d=140; // 正射影なので距離は固定、zoomで拡縮
  camera.position.set(
    target.x+d*Math.cos(pitch)*Math.cos(yaw),
    target.y+d*Math.sin(pitch),
    target.z+d*Math.cos(pitch)*Math.sin(yaw));
  camera.lookAt(target);
  camera.zoom=zoom;
  camera.updateProjectionMatrix();
}
updateCamera();
const cv=renderer.domElement;
let drag=null,moved=false;
cv.addEventListener('pointerdown',function(e){
  drag={x:e.clientX,y:e.clientY,rotate:(e.button===2||e.ctrlKey||e.metaKey)};moved=false;
  try{cv.setPointerCapture(e.pointerId);}catch(_){}
  cv.classList.add('grabbing');
});
cv.addEventListener('pointermove',function(e){
  if(!drag)return;
  var dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if(!moved&&Math.abs(dx)<4&&Math.abs(dy)<4)return;
  moved=true;
  var scale=(FRUSTUM/zoom)/innerHeight;
  if(drag.rotate){
    // 回転: 街をぐるっと見る。パン・ズームとは別ジェスチャなので干渉しない
    yaw+=dx*0.006;
    pitch=Math.max(0.12,Math.min(1.45,pitch+dy*0.005));
  } else {
    // パン: 画面の動きにそのまま追従
    // 画面右(世界) = normalize(cross(forward, up)) = (cos(yaw), 0, -sin(yaw))
    // 画面上(地面射影) = forward の水平成分 = (-cos(yaw), 0, -sin(yaw))
    var rx=-Math.cos(yaw), rz=Math.sin(yaw);
    var fx=-Math.cos(yaw), fz=-Math.sin(yaw);
    target.x+=rx*dx*scale; target.z+=rz*dx*scale;
    target.x+=fx*dy*scale/Math.max(0.3,Math.cos(pitch));
    target.z+=fz*dy*scale/Math.max(0.3,Math.cos(pitch));
  }
  drag={x:e.clientX,y:e.clientY,rotate:drag.rotate};
  updateCamera();
});
function endDrag(){drag=null;cv.classList.remove('grabbing');setTimeout(function(){moved=false;},0);}
cv.addEventListener('pointerup',endDrag);
cv.addEventListener('pointercancel',endDrag);
cv.addEventListener('contextmenu',function(e){e.preventDefault();});
// トラックパッド対応（Google Maps / Figma方式）:
// - 2本指スクロール = パン
// - ピンチ (ctrlKey+wheel) = カーソル位置アンカーでズーム
// - マウスホイール = 同じくカーソルアンカーでズーム
// - deltaMode=1（行単位・Firefox）はpxに正規化
var rc=new THREE.Raycaster();
function groundAt(ndc){ // 画面点→地面(y=0)交点。ズームアンカー計算に使う
  rc.setFromCamera(ndc,camera);
  var t=-rc.ray.origin.y/rc.ray.direction.y;
  if(!isFinite(t)||t<=0)return null;
  return rc.ray.origin.clone().addScaledVector(rc.ray.direction,t);
}
function zoomAt(ndc,nz){ // ndcの地面点を動かさずにズームする
  var b=groundAt(ndc);
  zoom=nz;updateCamera();
  var a=groundAt(ndc);
  if(b&&a){target.x+=b.x-a.x;target.z+=b.z-a.z;updateCamera();}
}
window.__groundAt=function(sx,sy){ // QA用: 画面px→地面ワールド座標
  var g=groundAt({x:(sx/innerWidth)*2-1,y:-(sy/innerHeight)*2+1});
  return g?{x:+g.x.toFixed(2),z:+g.z.toFixed(2)}:null;
};
cv.addEventListener('wheel',function(e){
  e.preventDefault();
  var dy=e.deltaY*(e.deltaMode===1?16:1);
  var ndc={x:(e.clientX/innerWidth)*2-1,y:-(e.clientY/innerHeight)*2+1};
  if(e.ctrlKey){
    // ピンチ: 開く(deltaY負)=拡大。指を広げたら世界が広がる直感に合わせる
    zoomAt(ndc,Math.max(0.35,Math.min(8,zoom*Math.exp(-dy*0.008))));
  } else {
    // マウスホイール: 下回し=縮小（標準の向き）
    zoomAt(ndc,Math.max(0.35,Math.min(8,zoom*Math.exp(dy*0.0012))));
  }
},{passive:false});
cv.addEventListener('dblclick',function(){yaw=Math.PI/4;pitch=Math.PI/5;zoom=1;target.set(${CITY_CX},0,${CITY_CZ});updateCamera();});

// リサイズ
addEventListener('resize',function(){
  renderer.setSize(innerWidth,innerHeight);
  var a=innerWidth/innerHeight;
  camera.left=-FRUSTUM*a/2;camera.right=FRUSTUM*a/2;
  camera.top=FRUSTUM/2;camera.bottom=-FRUSTUM/2;
  camera.updateProjectionMatrix();
});

// ---- ピッキング＋パネル ----
const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();
const panel=document.getElementById('panel');
var selected=null;
function selectNode(id){
  // 前回選択の解除: ビルは種別色へ、ワイヤは基本値へ
  if(selected){
    selected.material.emissive.setHex(0x000000);
    selected.children[0].material.color.setHex(0x14120b);selected.children[0].material.opacity=1;
    selected=null;
  }
  for(const le of liveEdges){le.m.material.color.setHex(le.m.userData.col);le.m.material.opacity=le.m.userData.op;}
  if(!id)return;
  const m=meshes[id];if(!m)return;
  selected=m;
  m.material.emissive.setHex(0x2a1a08);
  m.children[0].material.color.setHex(0xd96c47);m.children[0].material.opacity=1;
  // 非選択ビルを灰転、関連ワイヤを強調
  for(const n of NODES){
    const b=meshes[n.id];
    if(b!==m)b.material.emissive.setHex(0x111008);
  }
  for(const le of liveEdges){
    const A=le.m.userData.aM,B=le.m.userData.bM;
    if(A===m||B===m){le.m.material.color.setHex(0xd96c47);le.m.material.opacity=Math.min(1,le.m.userData.op*3);}
    else le.m.material.opacity=le.m.userData.op*0.4;
  }
  var n=m.userData.node;
  showPanel(n);
}
// ヘッダーはflex-wrapで段数が変わる → 固定topでなく実高さから配置する
function belowHeader(){return (document.querySelector('header').offsetHeight+10)+'px';}
function showPanel(n){
  var note=(NOTES[n.id]||{})['_file']||'';
  // 一文説明: アノテーション → 種別テンプレ（insights.jsonがあれば後で上書き）
  var one=note||(ONE_LINERS[n.kind]||('「'+n.id.split('/').pop()+'」はこの街の'+n.kind+'.'));
  var symRows=(n.syms||[]).filter(function(s){return s.k!=='type'&&s.k!=='route';}).slice(0,40).map(function(s){
    var fi=SYM_FANIN[n.id+'::'+s.n]||0;
    return '<div class="sym" data-sym="'+besc(s.n)+'" title="'+s.l+(s.e?'–'+s.e:'')+'行 · クリックで呼び出しを追う"><i>·</i>'+besc(s.n)+
      '<span>'+(fi?('×'+fi+' '):'')+s.l+'</span></div>';
  }).join('');
  panel.innerHTML='<h2><i class="chip" style="background:#'+n.color.toString(16).padStart(6,'0')+'"></i>'+besc(n.id)+'</h2>'+
    '<p class="one">'+besc(one)+'</p>'+
    '<details class="more"><summary>Read more</summary>'+
    '<div class="row"><span>kind</span><b>'+n.kind+'</b></div>'+
    '<div class="row"><span>loc</span><b>'+n.loc+'</b></div>'+
    '<div class="row"><span>fanned in by</span><b>'+n.fanIn+'</b></div>'+
    '<div class="deps">imports: '+(n.deps.map(function(d){return d.split('/').pop()}).join(' · ')||'—')+'</div>'+
    '</details>'+
    ((symRows)?'<div class="sec">functions</div>'+symRows:'');
  panel.style.top=belowHeader();
  panel.dataset.nodeId=n.id;
  panel.style.display='block';
}
// 関数クリック → 呼び出しウォーク（startWalk本体はパケットセクションでfunction宣言済み）
panel.addEventListener('click',function(e){
  var sym=e.target.closest('.sym');
  if(sym&&sym.getAttribute('data-sym'))startWalk(panel.dataset.nodeId,sym.getAttribute('data-sym'));
});
// 関数のfan-in（呼び出され側カウント）をCALLSから事前計算
var SYM_FANIN={};
for(const c of CALLS)SYM_FANIN[c.t+'::'+c.ts]=(SYM_FANIN[c.t+'::'+c.ts]||0)+1;
let downPos=null;
cv.addEventListener('pointerdown',function(e){downPos={x:e.clientX,y:e.clientY};});
cv.addEventListener('pointerup',function(e){
  if(!downPos)return;
  var dx=e.clientX-downPos.x,dy=e.clientY-downPos.y;
  if(Math.abs(dx)>4||Math.abs(dy)>4){downPos=null;return;}
  pointer.x=(e.clientX/innerWidth)*2-1;
  pointer.y=-(e.clientY/innerHeight)*2+1;
  raycaster.setFromCamera(pointer,camera);
  var hits=raycaster.intersectObjects(pickables,false);
  if(hits.length)selectNode(hits[0].object.userData.node.id);
  else {selectNode(null);panel.style.display='none';}
  downPos=null;
});
// ホバーでカーソル変更
cv.addEventListener('pointermove',function(e){
  if(drag)return;
  pointer.x=(e.clientX/innerWidth)*2-1;
  pointer.y=-(e.clientY/innerHeight)*2+1;
  raycaster.setFromCamera(pointer,camera);
  cv.style.cursor=raycaster.intersectObjects(pickables,false).length?'pointer':'grab';
});

// 検索ジャンプ（フォーカス）
function focusNode(id){
  var m=meshes[id];if(!m)return;
  selectNode(id);
  target.set(m.position.x,0,m.position.z);
  zoom=Math.max(zoom,2.2);
  updateCamera();
}

// 検索UI
var qInput=document.getElementById('q'),results=document.getElementById('results');
function renderResults(list){
  if(!list.length){results.style.display='none';return;}
  results.innerHTML=list.slice(0,12).map(function(n){
    return '<div class="r" data-id="'+n.id.replace(/"/g,'&quot;')+'"><span>'+n.id.split('/').pop()+'</span><small>'+n.district+'</small></div>';
  }).join('');
  results.style.top=belowHeader();
  results.style.display='block';
}
qInput.addEventListener('input',function(){
  var v=qInput.value.toLowerCase();
  renderResults(v?NODES.filter(function(n){return n.id.toLowerCase().indexOf(v)>=0}):[]);
});
results.addEventListener('click',function(e){
  var r=e.target.closest('.r');if(!r)return;
  qInput.value='';results.style.display='none';
  focusNode(r.getAttribute('data-id'));
});
window.addEventListener('keydown',function(e){
  if(e.key==='/'&&document.activeElement!==qInput){e.preventDefault();qInput.focus();}
  if(e.key==='Escape'){selectNode(null);panel.style.display='none';results.style.display='none';qInput.blur();}
});

// レンダーループ（回転慣性なし、必要時のみ描画で省電力）
var timeAnims=[],breathT=0,timeMarkers=[]; // 誕生アニメ: {m,h0,h1,t} / リング呼吸位相 / タイムバーマーカー
var reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
function loop(){
  requestAnimationFrame(loop);
  // 誕生アニメ進行（cubic-out、0.5s）
  for(var i=timeAnims.length-1;i>=0;i--){
    var a=timeAnims[i];a.t+=1/30;
    var k=Math.min(1,a.t/15),e=1-Math.pow(1-k,3);
    a.m.scale.y=a.h0+(a.h1-a.h0)*e;
    if(k>=1)timeAnims.splice(i,1);
  }
  updateEdgeHeights(); // ワイヤ端点をビル高さに追従（変化なしフレームは実質ゼロコスト）
  if(timeMarkers.length){ // 新築リングの呼吸（scale+opacity、静かに脈打つ）
    breathT+=0.016;
    var br=1+Math.sin(breathT*2.6)*0.12;
    for(var bi=0;bi<timeMarkers.length;bi++){
      var mk=timeMarkers[bi];
      if(mk.material.map)continue; // ストライプ区画は呼吸させない
      mk.scale.set(br,1,br);
      mk.material.opacity=0.65+Math.sin(breathT*2.6)*0.25;
    }
  }
  // 常時パケット: 弧上をゆっくり（reduced-motion尊重）
  if(!reduceMotion){
    for(const ap of ambient){
      ap.t=(ap.t+ap.speed)%1;
      if(!ap.le.m.visible||!ap.le.curve){ap.m.visible=false;continue;}
      const A=ap.le.m.userData.aM,B=ap.le.m.userData.bM;
      const rev=A.userData.node.fanIn<B.userData.node.fanIn; // fan-in弱い方から強い方へ流す
      const p=rev?ap.le.curve.getPoint(1-ap.t):ap.le.curve.getPoint(ap.t);
      ap.m.position.copy(p);ap.m.visible=true;
    }
    // ウォークパケット: 順番に発車、弧を1秒で走る
    if(walk){
      let allDone=true;
      for(const h of walk.hops){
        if(h.pk)h.pk.visible=false; // 毎フレーム一旦消す（完了・待機を単純に）
        h.t+=0.02;
        if(h.t<0){allDone=false;continue;} // まだ発車しない
        if(h.t>=1)continue;               // 完着
        allDone=false;
        if(!h.pk)h.pk=makePacket(0xd96c47,0.7);
        if(!h.le.m.visible||!h.le.curve)continue;
        const A=h.le.m.userData.aM,B=h.le.m.userData.bM;
        const rev=A.userData.node.id!==h.aF; // aF側が始点になるよう向き決め
        const p=rev?h.le.curve.getPoint(1-h.t):h.le.curve.getPoint(h.t);
        h.pk.position.copy(p);h.pk.visible=true;
      }
      if(allDone)stopWalk();
    }
  } else {
    packetGroup.visible=false;
  }
  renderer.render(scene,camera);
}
loop();

// ---- タイムバー: git履歴で街の成長を再生（SVG版ロジックの3D移植） ----
if(TIMELINE&&TIMELINE.frames&&TIMELINE.frames.length){
  const range=document.getElementById('tb-range'),label=document.getElementById('tb-label'),playBtn=document.getElementById('tb-play');
  range.max=TIMELINE.frames.length-1;
  var playTimer=null,anims=timeAnims;
  function setHeight(m,h){ // 誕生アニメ: 現在値→目標へcubic-outで立ち上がる
    anims.push({m,h0:m.scale.y,h1:h,t:0});
  }
  function applyFrame(i){
    // 前フレーム掃除: 実行中アニメを完成値に落着させ、マーカー撤去
    for(const a of anims)a.m.scale.y=a.h1;
    anims=[];
    for(const mk of timeMarkers){cityGroup.remove(mk);mk.material.dispose();}
    timeMarkers=[];
    breathT=0;
    if(i<0){ // -1 = 現在
      label.textContent='現在 — '+NODES.length+'files';
      for(const n of NODES){
        const m=meshes[n.id];
        m.scale.y=n.h;m.visible=true;
        m.material.map=null;m.material.needsUpdate=true;
        m.material.opacity=1;m.material.transparent=false;
      }
      range.value=TIMELINE.frames.length-1;
      return;
    }
    var f=TIMELINE.frames[i];
    label.textContent=f.date+' '+f.hash+' · '+f.msg.slice(0,28)+' ('+f.nFiles+'files/'+f.totalLoc+'loc)';
    for(const n of NODES){
      const m=meshes[n.id];
      var loc=f.files[n.id];
      if(loc!==undefined){
        // 当時存在: 目標高さ=LOC比率。現在高さから目標へ必ずアニメで動く
        var targetH=Math.max(0.5,n.h*ratioOf(n,loc));
        m.visible=true;
        m.material.opacity=1;m.material.transparent=false;
        var prev=i>0?TIMELINE.frames[i-1].files[n.id]:undefined;
        if(prev===undefined){
          // 新築: 0から立ち上がる＋地面リング
          m.scale.y=0.001;
          anims.push({m,h0:0,h1:targetH,t:0});
          var mk=new THREE.Mesh(ringGeo,new THREE.MeshBasicMaterial({color:0xd96c47,transparent:true,opacity:0.85,side:THREE.DoubleSide}));
          mk.position.set(n.x,0.05,n.z);
          cityGroup.add(mk);
          timeMarkers.push(mk);
        } else if(Math.abs(m.scale.y-targetH)>0.05){
          anims.push({m,h0:m.scale.y,h1:targetH,t:0}); // 成長・縮小もなめらか
        } else {
          m.scale.y=targetH;
        }
      } else {
        // 未誕生: ビルは出さず、地面にストライプの建設区画を敷く
        m.visible=false;
        var lot=new THREE.Mesh(lotGeo,new THREE.MeshBasicMaterial({map:stripes,transparent:true,opacity:0.9}));
        lot.position.set(n.x,0.04,n.z);
        cityGroup.add(lot);
        timeMarkers.push(lot);
      }
    }
    range.value=i;
  }
  function ratioOf(n,loc){return Math.max(loc,1)/Math.max(n.loc,1);}
  window.__applyTimeframe=applyFrame; // QA用
  window.__sel=function(){ // QA用: 選択ハイライト状態
    if(!selected)return {sel:null};
    var hot=0,dim=0;
    for(var i=0;i<liveEdges.length;i++){
      var le=liveEdges[i];
      if(!le.m.visible)continue;
      var U=le.m.userData;
      if((U.aM===selected||U.bM===selected)&&le.m.material.color.getHexString()==='d96c47')hot++;
      else if(le.m.material.opacity<U.op)dim++;
    }
    return {sel:selected.userData.node.id,outline:'#'+selected.children[0].material.color.getHexString(),
      emissive:'#'+selected.material.emissive.getHexString(),hotWires:hot,dimmedWires:dim};
  };
  window.__edges=function(){ // QA用: ワイヤ追従状態
    var vis=0,bad=0;
    for(var i=0;i<liveEdges.length;i++){
      var e=liveEdges[i];
      if(!e.m.visible)continue;
      vis++;
      var A=e.m.userData.aM,B=e.m.userData.bM;
      if(Math.abs(e.ha-A.scale.y)>0.05||Math.abs(e.hb-B.scale.y)>0.05)bad++;
    }
    return {total:liveEdges.length,visible:vis,detached:bad};
  };
  window.__nodes=function(){ // QA用: 各ビルの材質色・高さ・画面座標
    var out=[];
    for(var k in meshes){
      var m=meshes[k];
      var v=new THREE.Vector3(m.position.x,m.scale.y*0.6,m.position.z).project(camera);
      var vt=new THREE.Vector3(m.position.x,m.scale.y,m.position.z).project(camera);
      out.push({id:k,color:'#'+m.material.color.getHexString(),opacity:m.material.opacity,
        h:+m.scale.y.toFixed(2),
        sx:Math.round((v.x*0.5+0.5)*innerWidth),sy:Math.round((-v.y*0.5+0.5)*innerHeight),
        tx:Math.round((vt.x*0.5+0.5)*innerWidth),ty:Math.round((-vt.y*0.5+0.5)*innerHeight)});
    }
    return out;
  };
  window.__tlState=function(){return {
    rings:timeMarkers.filter(function(mk){return !mk.material.map}).length,
    lots:timeMarkers.length-timeMarkers.filter(function(mk){return !mk.material.map}).length,
    moving:timeAnims.length,
    breath:(function(){ // QA用: リング呼吸の振れ幅
      var mn=1,mx=0,n=0;
      for(var i=0;i<timeMarkers.length;i++){
        var mk=timeMarkers[i];if(mk.material.map)continue;
        n++;mn=Math.min(mn,mk.material.opacity);mx=Math.max(mx,mk.material.opacity);
      }
      return n?{n:n,min:+mn.toFixed(2),max:+mx.toFixed(2)}:{n:0};
    })()
  }};
  applyFrame(-1);
  range.addEventListener('input',function(){stopPlay();applyFrame(+range.value);});
  document.getElementById('tb-now').onclick=function(){stopPlay();applyFrame(-1);};
  function stopPlay(){if(playTimer){clearInterval(playTimer);playTimer=null;playBtn.textContent='▶︎';}}
  playBtn.onclick=function(){
    if(playTimer){stopPlay();return;}
    playBtn.textContent='⏸';
    var i=+range.value>=TIMELINE.frames.length-1?0:+range.value;
    applyFrame(i);
    playTimer=setInterval(function(){
      i++;
      if(i>=TIMELINE.frames.length){stopPlay();return;}
      applyFrame(i);
    },900);
  };
}
</script>
</body></html>`;

  void sceneData; void plateData; void edges; void threeSrc;
  fs.writeFileSync(opts.out ?? 'dist/index.html', html);
  return { ms: Math.round(performance.now() - t0), bytes: html.length };
}

if (process.argv[1] && process.argv[1].endsWith('render3d.mjs')) {
  const city = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const out = process.argv[3] ?? 'dist/index3d.html';
  // タイムライン: TIMELINE env or timeline-<name>.json。city-<name>.json なら timeline-<name>.json を引く
  const base = path.basename(String(process.argv[2] ?? ''));
  const nameMatch = base.match(/^city-(.*)\.json$/);
  let timeline = null;
  try { timeline = JSON.parse(fs.readFileSync(process.env.TIMELINE ?? (nameMatch ? `timeline-${nameMatch[1]}.json` : 'timeline.json'), 'utf8')); } catch { /* なしでも動く */ }
  const r = render(city, { out, timeline });
  console.log(`rendered ${out} (${(r.bytes / 1024).toFixed(0)}KB) in ${r.ms}ms${timeline ? ` +timeline(${timeline.frames?.length ?? 0}f)` : ''}`);
}
