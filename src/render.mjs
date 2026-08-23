// render.mjs — city.json を受け取り、アイソメ都市の自己完結HTMLを吐く
// 描画は素のSVG（nagmotiテンプレと同路線）。ゼロ依存。
import fs from 'node:fs';
import path from 'node:path';

const ISO = { tileW: 44, tileH: 22 };

function iso(col, row, h = 0) {
  return { x: (col - row) * ISO.tileW, y: (col + row) * ISO.tileH - h };
}

function cubePolys(col, row, height) {
  const w = ISO.tileW, d = ISO.tileH, hgt = height;
  const top = iso(col, row, hgt);
  const N = { x: top.x, y: top.y - d }, E = { x: top.x + w, y: top.y };
  const S = { x: top.x, y: top.y + d }, W = { x: top.x - w, y: top.y };
  return {
    top: `${N.x},${N.y} ${E.x},${E.y} ${S.x},${S.y} ${W.x},${W.y}`,
    left: `${W.x},${W.y} ${S.x},${S.y} ${S.x},${S.y + hgt} ${W.x},${W.y + hgt}`,
    right: `${S.x},${S.y} ${E.x},${E.y} ${E.x},${E.y + hgt} ${S.x},${S.y + hgt}`,
    apex: { x: N.x, y: N.y },
  };
}

const KIND_COLORS = {
  page: '#e0b34c', component: '#7fb069', api: '#d96c47', hook: '#5aa9d6',
  lib: '#9b7fd4', type: '#8a8a8a', test: '#5f7d5f', module: '#b0a486',
};

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, (n >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 255) + amt));
  const b = Math.min(255, Math.max(0, (n & 255) + amt));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

const FAVICON = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='%23efe8d6'/><path d='M8 2l6 3.5v5L8 14l-6-3.5v-5z' fill='%23d96c47'/></svg>`;

export function render(city, opts = {}) {
  const t0 = performance.now();
  const nodes = city.nodes;

  // --- レイアウト: 区画ごとに必要サイズの正方形を確保し、行に流し込む ---
  const districts = new Map();
  for (const n of nodes) {
    if (!districts.has(n.district)) districts.set(n.district, []);
    districts.get(n.district).push(n);
  }
  const names = [...districts.keys()].sort();
  const perRow = Math.max(1, Math.ceil(Math.sqrt(names.length)));
  const pos = new Map();
  const plates = []; // {name, ox, oy, size}
  // 区画間の道: ビル最大高さ(≈70px)が画面yで潰れないよう、グリッド3タイル空ける
  const GAP = 3;
  let ox = 0, oy = 0, rowMax = 0, maxCol = 0, maxRow = 0;
  names.forEach((name, i) => {
    const size = Math.max(1, Math.ceil(Math.sqrt(districts.get(name).length)));
    if (i > 0 && i % perRow === 0) { ox = 0; oy += rowMax + GAP; rowMax = 0; }
    const files = districts.get(name).sort((a, b) => (b.fanIn - a.fanIn) || (b.loc - a.loc));
    files.forEach((n, j) => pos.set(n.id, { col: ox + (j % size), row: oy + Math.floor(j / size) }));
    plates.push({ name, ox, oy, size });
    ox += size + GAP;
    rowMax = Math.max(rowMax, size);
    maxCol = Math.max(maxCol, ox);
    maxRow = Math.max(maxRow, oy + size);
  });

  const maxLoc = Math.max(...nodes.map(n => n.loc), 1);
  const maxFan = Math.max(...nodes.map(n => n.fanIn), 1);
  const heightOf = n => 8 + Math.round(56 * Math.pow(n.fanIn / maxFan, 0.7)) + Math.round(10 * (n.loc / maxLoc));

  // --- 地面（区画プレート） ---
  let ground = '', labels = '';
  for (const p of plates) {
    const c = [
      iso(p.ox - 0.6, p.oy - 0.6), iso(p.ox + p.size - 0.4, p.oy - 0.6),
      iso(p.ox + p.size - 0.4, p.oy + p.size - 0.4), iso(p.ox - 0.6, p.oy + p.size - 0.4),
    ];
    ground += `<polygon points="${c.map(q => `${q.x},${q.y}`).join(' ')}" class="dist"/>`;
    // ラベルは区画の手前下（最も隠れにくい位置）に置く
    const lc = iso(p.ox + (p.size - 1) / 2, p.oy + p.size + 0.7);
    labels += `<text x="${lc.x}" y="${lc.y}" class="dist-label">${esc(p.name)}</text>`;
  }

  // --- ビル: 奥(col+rowが小さい)から手前へ描く（ペインター法） ---
  const blocks = [];
  for (const n of nodes) {
    const { col, row } = pos.get(n.id);
    const h = heightOf(n);
    const p = cubePolys(col, row, h);
    const color = KIND_COLORS[n.kind] ?? KIND_COLORS.module;
    // ラベルはビルの<g>内に同梱 → パン/ズームに自動追従、取り残されない
    blocks.push({
      depth: col + row,
      svg: `<g class="b" data-id="${esc(n.id)}">` +
        `<polygon points="${p.left}" fill="${shade(color, -28)}" stroke="#14120b" stroke-width="0.5"/>` +
        `<polygon points="${p.right}" fill="${shade(color, -14)}" stroke="#14120b" stroke-width="0.5"/>` +
        `<polygon points="${p.top}" fill="${color}" stroke="#14120b" stroke-width="0.5"><title>${esc(n.id)} · loc:${n.loc} in:${n.fanIn}</title></polygon>` +
        `<text class="flabel" x="${p.apex.x}" y="${p.apex.y - 4}">${esc(path.basename(n.id))}</text>` +
        `</g>`,
    });
  }
  blocks.sort((a, b) => a.depth - b.depth);
  const blocksSvg = blocks.map(b => b.svg).join('');

  // --- エッジ（fan-in上位のみ） ---
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edgesSvg = city.edges
    .slice().sort((a, b) => byId.get(b.to).fanIn - byId.get(a.to).fanIn)
    .slice(0, 220)
    .map(e => {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return '';
      const pa = iso(a.col, a.row, heightOf(byId.get(e.from))), pb = iso(b.col, b.row, heightOf(byId.get(e.to)));
      const mx = (pa.x + pb.x) / 2, my = Math.min(pa.y, pb.y) - 30;
      return `<path class="edge" d="M${pa.x},${pa.y} Q${mx},${my} ${pb.x},${pb.y}"/>`;
    }).join('');

  const stats = city.stats;
  const kindLegend = Object.entries(KIND_COLORS).map(([k, c]) =>
    `<span class="lg"><i style="background:${c}"></i>${k}</span>`).join('');

  // --- viewBox: 実際の投影範囲から外接矩形 ---
  const minX = -(maxRow + 2) * ISO.tileW, width = (maxCol + maxRow + 4) * ISO.tileW;
  const minY = -150, maxY = (maxCol + maxRow) * ISO.tileH + 90;
  const vb = `${minX.toFixed(0)} ${minY} ${width.toFixed(0)} ${Math.max(maxY - minY, 600).toFixed(0)}`;

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="icon" href="${FAVICON}">
<title>System Map — ${esc(city.root)}</title>
<style>
:root{--bg:#efe8d6;--ink:#14120b;--card:#faf6ea;--accent:#d96c47}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
header{padding:14px 20px;border-bottom:2px solid var(--ink);display:flex;gap:24px;align-items:baseline;flex-wrap:wrap;background:var(--card)}
header h1{font-size:18px;letter-spacing:.04em}
.stat b{font-size:16px}.stat span{opacity:.65;font-size:12px}
#wrap{position:relative;height:calc(100vh - 58px);overflow:hidden}
svg{width:100%;height:100%;cursor:grab;touch-action:none}
svg.grabbing{cursor:grabbing}
.dist{fill:#e6ddc4;stroke:#c9bd9c;stroke-width:1}
.dist-label{font-size:11px;fill:#7a7052;text-anchor:middle;text-transform:uppercase;letter-spacing:.08em}
.edge{fill:none;stroke:#d96c47;stroke-width:.7;opacity:.35;pointer-events:none}
.b:hover polygon{filter:brightness(1.15)}
.b.sel polygon{stroke:var(--accent);stroke-width:2}
.flabel{font-size:9px;fill:#3d3826;text-anchor:middle;pointer-events:none;font-weight:600;display:none}
svg.zoomed-in .flabel{display:block}
#panel{position:absolute;top:12px;right:12px;width:320px;max-height:calc(100% - 24px);overflow:auto;background:var(--card);border:2px solid var(--ink);padding:14px;display:none}
#panel h2{font-size:13px;word-break:break-all}
#panel .row{display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px dashed #d8cfb4}
#panel .sec{margin-top:10px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.6;border-bottom:1px solid #d8cfb4;padding-bottom:2px}
#panel .sym{display:flex;gap:6px;align-items:baseline;font-size:11px;padding:2px 0}
#panel .sym i{font-style:normal;color:var(--accent);width:12px;flex:none}
#panel .sym code{word-break:break-all}
#panel .sym span{opacity:.45;margin-left:auto;flex:none}
#panel .sym.none{opacity:.5}
#panel .users{font-size:10px;opacity:.75;padding:0 0 4px 18px;line-height:1.6}
#panel .users a{color:var(--accent);cursor:pointer;text-decoration:none}
#panel .sym-note{font-size:10.5px;color:#5a5238;padding:0 0 4px 18px;line-height:1.5;border-left:2px solid var(--accent);margin-left:4px}
#panel .deps{margin-top:8px;font-size:11px;line-height:1.7;word-break:break-all}
#panel .deps a{color:var(--accent);cursor:pointer;text-decoration:none}
.legend{display:flex;gap:10px;flex-wrap:wrap;font-size:11px}
.lg i{display:inline-block;width:9px;height:9px;margin-right:4px;vertical-align:-1px;border:1px solid #14120b}
.hint{margin-left:auto;font-size:11px;opacity:.55}
.meaning{font-size:11px;opacity:.75;border-left:3px solid var(--accent);padding-left:8px}
.mbtn{font:12px/1 inherit;padding:6px 12px;border:1.5px solid var(--ink);background:var(--card);cursor:pointer;color:var(--ink)}
.mbtn:hover{background:var(--accent);color:#fff}
#q{font:12px/1.4 inherit;padding:5px 9px;border:1.5px solid var(--ink);background:#fff;width:170px}
#q:focus{outline:2px solid var(--accent)}
#results{position:absolute;top:52px;right:20px;width:300px;max-height:50vh;overflow:auto;background:var(--card);border:2px solid var(--ink);display:none;z-index:10}
#results .r{padding:6px 10px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
#results .r:hover,#results .r.on{background:var(--accent);color:#fff}
#results .r small{opacity:.6}
#drill{margin-top:10px;width:100%;padding:8px;background:var(--ink);color:var(--card);border:0;font:inherit;cursor:pointer}
#drill:hover{background:#3a3423}
#sub{position:absolute;inset:0;background:rgba(239,232,214,.97);display:none;flex-direction:column;padding:16px 20px;z-index:5}
.subhead{font-size:13px;border-bottom:2px solid var(--ink);padding-bottom:6px;margin-bottom:8px}
#subsvg{flex:1;width:100%;min-height:0}
.flabel2{font-size:11px;fill:#14120b;text-anchor:middle;font-weight:700;pointer-events:none}
.fedge{fill:none;stroke:#7a7052;stroke-width:1.4;opacity:.55;marker-end:url(#arrow)}
.fnode{cursor:pointer}
.fnode:hover rect{filter:brightness(1.12);stroke-width:2}
.fsub{font-size:9px;fill:#3d3826;text-anchor:middle;opacity:.7;pointer-events:none}
.panzoom{cursor:grab;touch-action:none}
.panzoom.grabbing{cursor:grabbing}
.fb.has-note .fbrect{stroke-width:1.6}
.notedot{fill:#fff200;stroke:#14120b;stroke-width:.8}
#notebox{position:absolute;top:56px;right:16px;width:300px;background:var(--card);border:2px solid var(--ink);padding:10px 12px;z-index:7;box-shadow:4px 4px 0 rgba(20,18,11,.12)}
.nb-title{font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.55;margin-bottom:4px}
.nb-body{font-size:12px;line-height:1.6}
.chips{display:flex;gap:6px;flex-wrap:wrap;padding-top:10px}
.chip{font-size:11px;border:1.5px solid var(--ink);background:var(--card);padding:3px 8px;cursor:pointer}
.chip:hover{background:var(--accent);color:#fff}
.chip em{opacity:.55;font-style:normal}
#subinfo{position:absolute;left:20px;top:52px;max-width:46%;background:var(--card);border:2px solid var(--ink);padding:10px 12px;font-size:12px;display:none;z-index:6}
#subinfo a{color:var(--accent);cursor:pointer;text-decoration:none}
.b.lit polygon{stroke:#fff200;stroke-width:2.5;filter:brightness(1.25)}
.b.dim polygon{opacity:.18}
@media(max-width:720px){#panel{width:calc(100% - 24px)}}
</style></head><body>
<header>
<h1>⬡ ${esc(city.root)}</h1>
<span class="stat"><b>${stats.files}</b><span>files</span></span>
<span class="stat"><b>${stats.loc.toLocaleString()}</b><span>loc</span></span>
<span class="stat"><b>${stats.edges}</b><span>imports</span></span>
<span class="stat"><b>${stats.districts}</b><span>districts</span></span>
<span class="stat"><b>${stats.externalPkgs}</b><span>ext pkgs</span></span>
<span class="legend">${kindLegend}</span>
<span class="meaning">高さ＝使われている数 · 色＝種類</span>
<button id="mode-flow" class="mbtn">⇢ フロー表示</button>
<input id="q" placeholder="⌕ ファイルを検索 ( / )" autocomplete="off">
<div id="results"></div>
<span class="hint">drag:pan · wheel:zoom · click:詳細 · dbl-click:reset</span>
</header>
<div id="wrap">
<svg id="city" viewBox="${vb}">
<g id="scene">${ground}${edgesSvg}${blocksSvg}${labels}</g>
</svg>
<div id="panel"></div>
<div id="sub"></div>
<div id="subinfo"></div>
</div>
<script>
(function(){
  var NODES=${JSON.stringify(nodes.map(n=>({id:n.id,kind:n.kind,district:n.district,loc:n.loc,fanIn:n.fanIn,deps:n.deps,syms:n.syms,uses:n.uses,calls:n.calls,ext:n.ext})))};
  var NOTES=${JSON.stringify(opts.annotations ?? {})};
  var SYMK={route:'⚡',api:'⚡',fn:'ƒ',class:'◆',type:'τ',const:'•'};
  // HTML文字列組み立て用のエスケープ（テンプレート内で使うためJS側にも定義）
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  var svg=document.getElementById('city'),panel=document.getElementById('panel');
  var vb=svg.viewBox.baseVal;
  var HOME={x:vb.x,y:vb.y,w:vb.width,h:vb.height};
  function apply(){svg.setAttribute('viewBox',vb.x+' '+vb.y+' '+vb.width+' '+vb.height);
    // ズーム連動: ビルに同梱されたラベルを一括切替（座標はSVGが追従、壊れない）
    svg.classList.toggle('zoomed-in', vb.width < HOME.w*0.55);}
  function resetView(){vb.x=HOME.x;vb.y=HOME.y;vb.width=HOME.w;vb.height=HOME.h;apply();}
  svg.addEventListener('wheel',function(e){e.preventDefault();
    var f=Math.exp(e.deltaY*0.0012);
    var r=svg.getBoundingClientRect();
    var mx=vb.x+(e.clientX-r.left)/r.width*vb.width,my=vb.y+(e.clientY-r.top)/r.height*vb.height;
    var nw=Math.min(4000,Math.max(60,vb.width*f));var k=nw/vb.width;
    vb.x=mx-(mx-vb.x)*k;vb.y=my-(my-vb.y)*k;vb.width=nw;vb.height*=k;
    apply();},{passive:false});
  var drag=null,moved=false;
  svg.addEventListener('pointerdown',function(e){
    if(e.button!==0)return;
    drag={x:e.clientX,y:e.clientY,vx:vb.x,vy:vb.y};moved=false;
    try{svg.setPointerCapture(e.pointerId);}catch(_){}
    svg.classList.add('grabbing');
  });
  svg.addEventListener('pointermove',function(e){
    if(!drag)return;
    var dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(!moved&&Math.abs(dx)<4&&Math.abs(dy)<4)return;
    moved=true;
    var r=svg.getBoundingClientRect();
    vb.x=drag.vx-dx*vb.width/r.width;vb.y=drag.vy-dy*vb.height/r.height;apply();
  });
  function endDrag(){drag=null;svg.classList.remove('grabbing');setTimeout(function(){moved=false;},0);}
  svg.addEventListener('pointerup',endDrag);
  svg.addEventListener('pointercancel',endDrag);
  svg.addEventListener('dblclick',function(e){if(e.target.closest('.b'))return;resetView();});
  function selectBlock(g){
    document.querySelectorAll('.b.sel').forEach(function(x){x.classList.remove('sel')});g.classList.add('sel');
    var id=g.getAttribute('data-id');var n=NODES.find(function(x){return x.id===id});
    // exports一覧 + 各シンボルの使用者
    var symRows=(n.syms||[]).map(function(s){
      var users=[];
      NODES.forEach(function(other){
        (other.uses||[]).forEach(function(u){
          if(u.to===n.id&&(u.name===s.n||(u.name==='default'&&s.d)))users.push(other.id);
        });
      });
      return '<div class="sym" data-sym="'+esc(s.n)+'"><i>'+(SYMK[s.k]||'·')+'</i><code>'+s.n+'</code><span>:'+s.l+'</span></div>'+
        ((NOTES[id]||{})[s.n]||(s.d?(NOTES[id]||{})['default']:null)?'<div class="sym-note">'+esc((NOTES[id]||{})[s.n]||(NOTES[id]||{})['default'])+'</div>':'')+
        (users.length?'<div class="users">'+users.map(function(u){return '<a class="jump" data-target="'+u.replace(/"/g,'&quot;')+'">'+u.split('/').pop()+'</a>'}).join(' · ')+' が使用</div>':'');
    }).join('')||'<div class="sym none">exportsなし</div>';
    var deps=n.deps.map(function(d){return '<a data-target="'+d.replace(/"/g,'&quot;')+'">'+d.split('/').pop()+'</a>'}).join(' · ')||'—';
    var drillable=(n.syms||[]).length>0;
    panel.innerHTML='<h2>'+id+'</h2>'+
      '<div class="row"><span>kind</span><b>'+n.kind+'</b></div>'+
      '<div class="row"><span>district</span><b>'+n.district+'</b></div>'+
      '<div class="row"><span>loc</span><b>'+n.loc+'</b></div>'+
      '<div class="row"><span>fanned into by</span><b>'+n.fanIn+'</b></div>'+
      '<div class="sec">exports ('+((n.syms||[]).length)+')</div>'+ symRows +
      '<div class="deps">imports: '+deps+'</div>'+
      (drillable?'<button id="drill">⤵ 関数マップに入る</button>':'');
    panel.style.display='block';
    var btn=document.getElementById('drill');
    if(btn)btn.onclick=function(){enterFile(n);};
  }
  // ---- 関数マップ（サブシーン）: 呼び出し関係を左→右フローで描く。パン/ズーム可 ----
  var sub=document.getElementById('sub');
  function enterFile(n){
    var syms=(n.syms||[]).filter(function(s){return s.k!=='route'});
    if(!syms.length)return;
    var usersOf={};
    NODES.forEach(function(other){
      (other.uses||[]).forEach(function(u){
        if(u.to!==n.id)return;
        var key=u.name==='default'?'default':u.name;
        (usersOf[key]=usersOf[key]||[]).push(other.id.split('/').pop());
      });
    });
    // レイヤー割り: 呼ばれてない（=入口）を0として呼び出し先へ+1
    var calls=n.calls||[];
    var layer={},queue=[];
    syms.forEach(function(s){
      var isEntry=!calls.some(function(c){return c.to===s.n});
      if(isEntry&&layer[s.n]===undefined){layer[s.n]=0;queue.push(s.n);}
    });
    while(queue.length){
      var cur=queue.shift();
      calls.filter(function(c){return c.from===cur}).forEach(function(c){
        if(layer[c.to]===undefined||layer[c.to]<layer[cur]+1){layer[c.to]=(layer[cur]??0)+1;queue.push(c.to);}
      });
    }
    syms.forEach(function(s){if(layer[s.n]===undefined)layer[s.n]=0;});
    var byL={};
    syms.forEach(function(s){(byL[layer[s.n]]=byL[layer[s.n]]||[]).push(s)});
    var COLW=200,ROWH=52,PAD=50;
    var posF={};
    Object.keys(byL).sort((a,b)=>a-b).forEach(function(L){
      var arr=byL[L];
      arr.forEach(function(s,i){
        posF[s.n]={x:PAD+(+L)*COLW, y:(i-(arr.length-1)/2)*ROWH};
      });
    });
    // エッジ: ファイル内呼び出し
    var inner='<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8a7f60"/></marker>'+
      '<marker id="arrow-x" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#d96c47"/></marker></defs>';
    calls.forEach(function(c){
      var a=posF[c.from],b=posF[c.to];if(!a||!b)return;
      var x1=a.x+72,x2=b.x-76,y1=a.y,y2=b.y,mx=(x1+x2)/2;
      inner+='<path class="fedge" d="M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+y2+' '+x2+','+y2+'"/>';
    });
    // 外部呼び出し: 右側に小さいターゲットノード
    var extNodes={},extList=n.ext||[],exX=PAD+(Math.max(...Object.keys(byL).map(Number))+1)*COLW-40;
    extList.slice(0,24).forEach(function(e,i){
      var key=e.file+'#'+e.name;
      if(!extNodes[key]){
        var fromPos=posF[e.from];
        extNodes[key]={x:exX, y:Object.keys(extNodes).length*46 - (Math.min(extList.length,24)-1)*23, file:e.file, name:e.name};
      }
      var a=posF[e.from],b=extNodes[key];if(!a)return;
      inner+='<path class="fedge ext" d="M'+(a.x+72)+','+a.y+' C'+((a.x+b.x)/2)+','+a.y+' '+((a.x+b.x)/2)+','+b.y+' '+(b.x-66)+','+b.y+'" marker-end="url(#arrow-x)" data-file="'+esc(e.file)+'" data-name="'+esc(e.name)+'"/>';
    });
    Object.values(extNodes).forEach(function(p,i){
      var fname=p.file.split('/').pop().replace(/\.\w+$/,'');
      inner+='<g class="fx" data-file="'+esc(p.file)+'" data-name="'+esc(p.name)+'">'+
        '<rect x="'+(p.x-64)+'" y="'+(p.y-13)+'" width="128" height="26" rx="13" fill="#faf6ea" stroke="#d96c47" stroke-width="1.4" stroke-dasharray="4 3"/>'+
        '<text x="'+p.x+'" y="'+(p.y+4)+'" text-anchor="middle" font-size="10.5" fill="#a05a35">'+esc(fname+'·'+(p.name==='default'?'default':p.name))+'</text></g>';
    });
    // 関数ノード（注釈は右上の説明欄に出す。ノードはコンパクト維持）
    syms.forEach(function(s){
      var p=posF[s.n];
      var u=(s.d?(usersOf['default']||[]):(usersOf[s.n]||[])||[]).length;
      var color=SYMC[s.k]||'#b0a486';
      var note=(NOTES[n.id]||{})[s.n]||(s.d?(NOTES[n.id]||{})['default']:null)||'';
      inner+='<g class="fb'+(note?' has-note':'')+'" data-sym="'+esc(s.n)+'" data-line="'+s.l+'" data-note="'+esc(note)+'">'+
        '<rect class="fbrect" x="'+(p.x-70)+'" y="'+(p.y-16)+'" width="140" height="32" rx="7" fill="'+color+'" stroke="#14120b" stroke-width="1.1"/>'+
        (note?'<circle class="notedot" cx="'+(p.x+60)+'" cy="'+(p.y-6)+'" r="4"></circle>':'')+
        '<text class="flabel2" x="'+p.x+'" y="'+(p.y-2)+'">'+esc(s.n)+'</text>'+
        '<text class="fsub" x="'+p.x+'" y="'+(p.y+11)+'">:'+s.l+(u?' · '+u+' users':'')+'</text>'+
        '</g>';
    });
    var maxLayer=Math.max(...Object.keys(byL).map(Number));
    var vbW=(maxLayer+2.6)*COLW, vbH=Math.max(syms.length*ROWH*1.4,(extList.length?Math.min(extList.length,24):1)*46+120,320);
    sub.innerHTML='<div class="subhead"><b>'+esc(n.id.split('/').pop())+'</b> 関数マップ — 左から右へ呼び出しが流れる · 破線＝他ファイルの関数 <button id="flow-close" style="float:right">× 閉じる (ESC)</button></div>'+
      '<svg id="subsvg" viewBox="'+(-vbW/2)+' '+(-vbH/2)+' '+vbW+' '+vbH+'" preserveAspectRatio="xMidYMid meet">'+
      '<g id="subscene">'+inner+'</g></svg>'+
      '<div id="notebox"><div class="nb-title">説明</div><div class="nb-body" id="notebody">関数にカーソルを合わせると役割の説明が出ます</div></div>';
    sub.style.display='flex';
    attachPanZoom(document.getElementById('subsvg'));
    document.getElementById('flow-close').onclick=function(){sub.style.display='none';};
    // ホバー/クリックで右上説明欄を更新
    var notebody=document.getElementById('notebody');
    sub.querySelectorAll('.fb').forEach(function(el){
      el.addEventListener('mouseenter',function(){
        var note=el.getAttribute('data-note')||'（注釈なし）';
        notebody.textContent=el.getAttribute('data-sym')+' — '+note;
      });
      el.onclick=function(){highlightUsers(n,el.getAttribute('data-sym'));};
    });
    sub.querySelectorAll('.fx,.fedge.ext').forEach(function(el){
      el.style.cursor='pointer';
      el.onclick=function(){
        var f=el.getAttribute('data-file');
        sub.style.display='none';document.getElementById('subinfo').style.display='none';
        focusBlock(f,false);
      };
    });
  }
  // サブシーン用パン/ズーム
  function attachPanZoom(svg){
    svg.classList.add('panzoom');
    var vb=svg.viewBox.baseVal;
    var HOME={w:vb.width,h:vb.height};
    svg.addEventListener('wheel',function(e){
      e.preventDefault();
      var f=Math.exp(e.deltaY*0.0012);
      var r=svg.getBoundingClientRect();
      var mx=vb.x+(e.clientX-r.left)/r.width*vb.width,my=vb.y+(e.clientY-r.top)/r.height*vb.height;
      var nw=Math.min(HOME.w*1.5,Math.max(200,vb.width*f));var k=nw/vb.width;
      vb.x=mx-(mx-vb.x)*k;vb.y=my-(my-vb.y)*k;vb.width=nw;vb.height*=k;
    },{passive:false});
    var drag=null;
    svg.addEventListener('pointerdown',function(e){
      drag={x:e.clientX,y:e.clientY,vx:vb.x,vy:vb.y};
      try{svg.setPointerCapture(e.pointerId);}catch(_){}
      svg.classList.add('grabbing');
    });
    svg.addEventListener('pointermove',function(e){
      if(!drag)return;
      var r=svg.getBoundingClientRect();
      vb.x=drag.vx-(e.clientX-drag.x)*vb.width/r.width;
      vb.y=drag.vy-(e.clientY-drag.y)*vb.height/r.height;
    });
    function end(){drag=null;svg.classList.remove('grabbing');}
    svg.addEventListener('pointerup',end);
    svg.addEventListener('pointercancel',end);
  }
  function shade2(hex,amt){
    var nn=parseInt(hex.slice(1),16);
    var r=Math.min(255,Math.max(0,(nn>>16)+amt)),g=Math.min(255,Math.max(0,((nn>>8)&255)+amt)),b=Math.min(255,Math.max(0,(nn&255)+amt));
    return '#'+((r<<16)|(g<<8)|b).toString(16).padStart(6,'0');
  }
  var SYMC={route:'#e07a3f',api:'#e07a3f',fn:'#5aa9d6',class:'#9b7fd4',type:'#8a8a8a',const:'#7fb069'};
  var KINDC={page:'#e0b34c',component:'#7fb069',api:'#d96c47',hook:'#5aa9d6',lib:'#9b7fd4',type:'#8a8a8a',test:'#5f7d5f',module:'#b0a486'};
  function highlightUsers(n,name){
    // 対象シンボルを使ってるファイルのビルを光らせる
    document.querySelectorAll('.b.lit').forEach(function(x){x.classList.remove('lit')});
    var lit=[];
    NODES.forEach(function(other){
      (other.uses||[]).forEach(function(u){
        if(u.to===n.id&&(u.name===name||(name==='default'&&u.name==='default')))lit.push(other.id);
      });
    });
    lit.forEach(function(id){
      var g=document.querySelector('.b[data-id="'+CSS.escape(id)+'"]');
      if(g)g.classList.add('lit');
    });
    // サブパネルに使用者一覧を出す
    var box=document.getElementById('subinfo');
    box.innerHTML=name==='default'?'<b>default export</b> の使用者':
      '<b>'+esc(name)+'</b> の使用者: '+(lit.map(function(id){return '<a class="jump" data-target="'+id.replace(/"/g,'&quot;')+'">'+id.split('/').pop()+'</a>'}).join(' · ')||'なし');
    box.style.display='block';
  }
  // pointerCapture中はclickのtargetがsvgに化けるため、elementFromPointで実体を解決する
  svg.addEventListener('click',function(e){
    if(moved)return;
    var el=document.elementFromPoint(e.clientX,e.clientY);
    var g=el&&el.closest?el.closest('.b'):null;
    if(!g){panel.style.display='none';return;}
    selectBlock(g);
  });
  panel.addEventListener('click',function(e){
    var t=e.target.closest('a[data-target]');if(!t)return;
    var g=document.querySelector('.b[data-id="'+CSS.escape(t.getAttribute('data-target'))+'"]');
    if(g){selectBlock(g);}
  });
  // ESCでサブシーンを閉じる / ハイライト解除
  window.addEventListener('keydown',function(e){
    if(e.key!=='Escape')return;
    if(sub.style.display==='flex'){sub.style.display='none';document.getElementById('subinfo').style.display='none';setFlowButton(false);}
    else{document.querySelectorAll('.b.lit').forEach(function(x){x.classList.remove('lit')});}
  });
  // subinfo内の「使用者」リンクでメイン地図のそのビルへ戻る
  document.getElementById('subinfo').addEventListener('click',function(e){
    var t=e.target.closest('a.jump');if(!t)return;
    sub.style.display='none';this.style.display='none';
    document.querySelectorAll('.b.lit').forEach(function(x){x.classList.remove('lit')});
    var g=document.querySelector('.b[data-id="'+CSS.escape(t.getAttribute('data-target'))+'"]');
    if(g){selectBlock(g);}
  });
  // ---- ライブ検索: ファイル名で絞り込み→ジャンプ＋関係ハイライト（emerge方式） ----
  var qInput=document.getElementById('q'),results=document.getElementById('results');
  function focusBlock(id,alsoNeighbors){
    var g=document.querySelector('.b[data-id="'+CSS.escape(id)+'"]');
    if(!g)return;
    // カメラをそのビルに寄せる
    var bb=g.querySelector('polygon').getBBox();
    vb.width=Math.min(HOME.w,vb.width<HOME.w?vb.width:600);vb.height=vb.width*(HOME.h/HOME.w);
    vb.x=bb.x+bb.width/2-vb.width/2;vb.y=bb.y+bb.height/2-vb.height/2;
    apply();
    selectBlock(g);
    if(alsoNeighbors){highlightRelations(id);}
  }
  function highlightRelations(id){
    document.querySelectorAll('.b.lit,.b.dim').forEach(function(x){x.classList.remove('lit','dim')});
    var n=NODES.find(function(x){return x.id===id});
    var rel={};
    (n.deps||[]).forEach(function(d){rel[d]=1});
    NODES.forEach(function(other){(other.deps||[]).forEach(function(d){if(d===id)rel[other.id]=1})});
    NODES.forEach(function(other){
      if(other.id!==id&&!rel[other.id]){
        var g=document.querySelector('.b[data-id="'+CSS.escape(other.id)+'"]');
        if(g)g.classList.add('dim');
      }
    });
    document.querySelectorAll('#scene .edge').forEach(function(p){p.remove()});
  }
  function clearDim(){document.querySelectorAll('.b.dim').forEach(function(x){x.classList.remove('dim')});}
  var selIdx=-1;
  function renderResults(list){
    if(!list.length){results.style.display='none';return;}
    results.innerHTML=list.slice(0,12).map(function(n,i){
      return '<div class="r'+(i===selIdx?' on':'')+'" data-id="'+n.id.replace(/"/g,'&quot;')+'"><span>'+esc(n.id.split('/').pop())+'</span><small>'+esc(n.district)+'</small></div>';
    }).join('');
    results.style.display='block';
  }
  qInput.addEventListener('input',function(){selIdx=-1;
    var v=qInput.value.toLowerCase();
    renderResults(v?NODES.filter(function(n){return n.id.toLowerCase().indexOf(v)>=0}):[]);
  });
  qInput.addEventListener('keydown',function(e){
    var list=NODES.filter(function(n){return n.id.toLowerCase().indexOf(qInput.value.toLowerCase())>=0}).slice(0,12);
    if(e.key==='ArrowDown'){selIdx=Math.min(selIdx+1,list.length-1);renderResults(list);e.preventDefault();}
    else if(e.key==='ArrowUp'){selIdx=Math.max(selIdx-1,0);renderResults(list);e.preventDefault();}
    else if(e.key==='Enter'){var pick=list[Math.max(selIdx,0)];if(pick){qInput.value='';results.style.display='none';focusBlock(pick.id,true);} }
    else if(e.key==='Escape'){qInput.value='';results.style.display='none';clearDim();}
  });
  results.addEventListener('click',function(e){
    var r=e.target.closest('.r');if(!r)return;
    qInput.value='';results.style.display='none';
    focusBlock(r.getAttribute('data-id'),true);
  });
  window.addEventListener('keydown',function(e){
    if(e.key==='/'&&document.activeElement!==qInput&&sub.style.display!=='flex'){e.preventDefault();qInput.focus();}
  });
  // ---- フロービュー: 呼び出し関係を左→右の有向フロー（サブシーン上に描く） ----
  document.getElementById('mode-flow').addEventListener('click',function(){
    if(sub.style.display==='flex'){sub.style.display='none';setFlowButton(false);document.getElementById('subinfo').style.display='none';}
    else{openFlow();}
  });
  function setFlowButton(open){
    var b=document.getElementById('mode-flow');
    b.textContent=open?'⬡ マップに戻る':'⇢ フローで見る';
    b.setAttribute('aria-pressed',open?'true':'false');
  }
  function entryPoints(){
    // エントリ: page/route/api種別。無ければfan-in最大
    var eps=NODES.filter(function(n){return n.kind==='page'||n.kind==='api'});
    if(!eps.length){
      var best=NODES.slice().sort(function(a,b){return b.fanIn-a.fanIn})[0];
      eps=best?[best]:[];
    }
    return eps;
  }
  function flowLayers(){
    // BFSでエントリから層（depth）を割る
    var depth={},queue=[];
    entryPoints().forEach(function(n){depth[n.id]=0;queue.push(n.id);});
    while(queue.length){
      var cur=queue.shift(),d=depth[cur];
      var node=NODES.find(function(x){return x.id===cur});
      (node?node.deps:[]).forEach(function(t){
        if(depth[t]===undefined||depth[t]<d+1){depth[t]=Math.max(depth[t]??0,d+1);queue.push(t);}
      });
    }
    return depth;
  }
  function openFlow(){
    var depth=flowLayers();
    var shown=NODES.filter(function(n){return depth[n.id]!==undefined});
    if(!shown.length)return;
    var maxLayer=Math.max.apply(null,shown.map(function(n){return depth[n.id]}));
    // レイヤー内は縦に並べる
    var byLayer={};
    shown.forEach(function(n){(byLayer[depth[n.id]]=byLayer[depth[n.id]]||[]).push(n)});
    var COLW=170,ROWH=46,PAD=40;
    var posF={};
    Object.keys(byLayer).forEach(function(L){
      var arr=byLayer[L].slice().sort(function(a,b){return b.fanIn-a.fanIn});
      var totalH=(arr.length-1)*ROWH;
      arr.forEach(function(n,i){
        posF[n.id]={x:PAD+(+L)*COLW, y:PAD+i*ROWH-totalH/2};
      });
    });
    // SVG組み立て
    var inner='';
    // エッジ（呼び出し方向: from→to）
    NODES.forEach(function(n){
      (n.deps||[]).forEach(function(t){
        var a=posF[n.id],b=posF[t];if(!a||!b)return;
        var x1=a.x+62,x2=b.x-8,y1=a.y,y2=b.y;
        var mx=(x1+x2)/2;
        inner+='<path class="fedge" d="M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+y2+' '+x2+','+y2+'"/>';
      });
    });
    // ノード（丸角矩形）
    shown.forEach(function(n){
      var p=posF[n.id];
      var color=KINDC[n.kind]||'#b0a486';
      var label=n.id.split('/').pop();
      inner+='<g class="fnode" data-id="'+esc(n.id)+'">'+
        '<rect x="'+(p.x-70)+'" y="'+(p.y-14)+'" width="140" height="28" rx="6" fill="'+color+'" stroke="#14120b" stroke-width="1"/>'+
        '<text x="'+p.x+'" y="'+(p.y+4)+'" text-anchor="middle" font-size="11" fill="#14120b" font-weight="600">'+esc(label)+'</text>'+
        '</g>';
    });
    // コンテンツの実bboxからviewBoxを組む（センタリングを正確に）
    var xs=Object.values(posF).map(function(p){return p.x});
    var ys=Object.values(posF).map(function(p){return p.y});
    var cx=(Math.min(...xs)+Math.max(...xs))/2;
    var cy=(Math.min(...ys)+Math.max(...ys))/2;
    var vbW=Math.max(...xs)-Math.min(...xs)+70*2+PAD*2;
    var vbH=Math.max(Math.max(...ys)-Math.min(...ys)+28*2+80,320);
    sub.innerHTML='<div class="subhead">⇢ フロー — 呼び出しの流れ（左＝入口 → 右＝末端）· ドラッグで移動 <button id="flow-close" style="float:right">× 閉じる (ESC)</button></div>'+
      '<svg id="subsvg" viewBox="'+(cx-vbW/2).toFixed(0)+' '+(cy-vbH/2).toFixed(0)+' '+vbW.toFixed(0)+' '+vbH.toFixed(0)+'">'+
      '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7a7052"/></marker></defs>'+
      inner+'</svg>';
    sub.style.display='flex';
    attachPanZoom(document.getElementById('subsvg'));
    setFlowButton(true);
    document.getElementById('flow-close').onclick=function(){sub.style.display='none';setFlowButton(false);};
    // ノードクリック→そのファイルの詳細へ
    sub.querySelectorAll('.fnode').forEach(function(el){
      el.onclick=function(){
        sub.style.display='none';
        setFlowButton(false);
        focusBlock(el.getAttribute('data-id'),false);
      };
    });
  }
})();
 </script></body></html>`;

  fs.writeFileSync(opts.out ?? 'dist/index.html', html);
  return { ms: Math.round(performance.now() - t0), bytes: html.length };
}

// CLI: node render.mjs city.json [out.html]
if (process.argv[1] && process.argv[1].endsWith('render.mjs')) {
  const city = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const out = process.argv[3] ?? 'dist/index.html';
  fs.mkdirSync(out.includes('/') ? out.slice(0, out.lastIndexOf('/')) : '.', { recursive: true });
  const r = render(city, { out });
  console.log(`rendered ${out} (${(r.bytes / 1024).toFixed(0)}KB) in ${r.ms}ms`);
}
