// render3d.mjs — city.json を three.js アイソメ都市の自己完結HTMLにする
// three.module.min.js をインライン埋め込み → 出力は依存ゼロの1枚
import fs from 'node:fs';
import path from 'node:path';

const THREE_SRC = new URL('../node_modules/three/build/three.module.min.js', import.meta.url);
const THREE_CORE_SRC = new URL('../node_modules/three/build/three.core.min.js', import.meta.url);

const KIND_COLORS = {
  page: 0xe0b34c, component: 0x7fb069, api: 0xd96c47, hook: 0x5aa9d6,
  lib: 0x9b7fd4, type: 0x8a8a8a, test: 0x5f7d5f, module: 0xb0a486,
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
      deps: n.deps, syms: n.syms, uses: n.uses,
      x: p.x, z: p.z, h: heightOf(n),
      color: KIND_COLORS[n.kind] ?? KIND_COLORS.module,
    };
  });
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
#panel .sym{font-size:11px;padding:2px 0}
#panel .sym i{font-style:normal;color:var(--accent);margin-right:6px}
#panel .sym span{opacity:.45;margin-left:auto;float:right}
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
var NOTES=${JSON.stringify(opts.annotations ?? {})};
var TIMELINE=${JSON.stringify(opts.timeline ?? null)};

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
scene.add(new THREE.AmbientLight(0xffffff,1.15));
const hemi=new THREE.HemisphereLight(0xfff8ec,0xcabb9a,0.55);
scene.add(hemi);
const sun=new THREE.DirectionalLight(0xffffff,1.6);
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
// 屋上マーカー（新築表示用）
const newGeo=new THREE.ConeGeometry(1.2,2.2,4);
for(const id in meshes){ /* 必要時のみ生成 */ }

// エッジ（呼び出しを弧で描く）: 主線は太めのグレー、太さはfan-in比例
const edgeGroup=new THREE.Group();cityGroup.add(edgeGroup);
function rebuildEdges(){
  while(edgeGroup.children.length){const c=edgeGroup.children[0];edgeGroup.remove(c);c.geometry.dispose();}
  // 太い線: TubeGeometry（LineBasicMaterialのlinewidthは効かないため）
  const maxFan=Math.max(...NODES.map(n=>n.fanIn),1);
  for(const e of EDGES){
    var fanInTo=0;
    for(const n of NODES){if(n.x===e.b.x&&n.z===e.b.z){fanInTo=n.fanIn;break;}}
    const importance=Math.pow(fanInTo/maxFan,0.6);       // 0..1
    const radius=0.03+importance*0.1;                    // 細め。主線だけ少し太い
    const curve=new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(e.a.x,e.a.h,e.a.z),
      new THREE.Vector3((e.a.x+e.b.x)/2,Math.max(e.a.h,e.b.h)+16,(e.a.z+e.b.z)/2),
      new THREE.Vector3(e.b.x,e.b.h,e.b.z));
    const g=new THREE.TubeGeometry(curve,20,radius,5,false);
    // 主線（importance高い）は濃グレー、それ以外は薄グレー
    var col=importance>0.45?0x55503f:0x9a927a;
    var op=0.5+importance*0.35;
    const m=new THREE.Mesh(g,new THREE.MeshLambertMaterial({color:col,transparent:true,opacity:op}));
    edgeGroup.add(m);
  }
}
rebuildEdges();

// ---- カメラ操作（ドラッグ=パン / 右・⌘+Ctrl+ドラッグ=回転）----
let yaw=Math.PI/4, pitch=Math.PI/5, zoom=1, target=new THREE.Vector3(${CITY_CX},0,${CITY_CZ});
window.__cam=function(){return {yaw,pitch,zoom,target:{x:target.x,z:target.z}}}; // QA用
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
// トラックパッド対応:
// - 2本指スクロール (deltaX/deltaY) = パン
// - ピンチ (ctrlKey+wheel) = ズーム
// - マウスホイール = ズーム
cv.addEventListener('wheel',function(e){
  e.preventDefault();
  if(e.ctrlKey){
    // ピンチジェスチャ（MacはctrlKeyが立つ）: 開く=拡大
    zoom=Math.max(0.35,Math.min(8,zoom*Math.exp(e.deltaY*0.008)));
    updateCamera();
  } else {
    // マウスホイール: 下回し=縮小（標準の向き）
    zoom=Math.max(0.35,Math.min(8,zoom*Math.exp(e.deltaY*0.0012)));
    updateCamera();
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
  if(selected){selected.material.emissive.setHex(0x000000);}
  selected=meshes[id];
  if(selected){
    selected.material.emissive.setHex(0x664411);
    var n=selected.userData.node;
    showPanel(n);
  }
}
// ヘッダーはflex-wrapで段数が変わる → 固定topでなく実高さから配置する
function belowHeader(){return (document.querySelector('header').offsetHeight+10)+'px';}
function showPanel(n){
  var note=(NOTES[n.id]||{})['_file']||'';
  var symRows=(n.syms||[]).slice(0,40).map(function(s){
    return '<div class="sym"><i>·</i>'+s.n+' <span>:'+s.l+'</span></div>';
  }).join('');
  panel.innerHTML='<h2>'+n.id+'</h2>'+
    '<div class="row"><span>kind</span><b>'+n.kind+'</b></div>'+
    '<div class="row"><span>loc</span><b>'+n.loc+'</b></div>'+
    '<div class="row"><span>fanned in by</span><b>'+n.fanIn+'</b></div>'+
    ((n.syms||[]).length?'<div class="sec">exports ('+n.syms.length+')</div>'+symRows:'')+
    '<div class="deps">imports: '+(n.deps.map(function(d){return d.split('/').pop()}).join(' · ')||'—')+'</div>';
  panel.style.top=belowHeader();
  panel.style.display='block';
}
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
  else panel.style.display='none';
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
});

// レンダーループ（回転慣性なし、必要時のみ描画で省電力）
function loop(){
  requestAnimationFrame(loop);
  renderer.render(scene,camera);
}
loop();
</script>
</body></html>`;

  void sceneData; void plateData; void edges; void threeSrc;
  fs.writeFileSync(opts.out ?? 'dist/index.html', html);
  return { ms: Math.round(performance.now() - t0), bytes: html.length };
}

if (process.argv[1] && process.argv[1].endsWith('render3d.mjs')) {
  const city = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const out = process.argv[3] ?? 'dist/index3d.html';
  const r = render(city, { out });
  console.log(`rendered ${out} (${(r.bytes / 1024).toFixed(0)}KB) in ${r.ms}ms`);
}
