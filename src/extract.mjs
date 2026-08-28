// extract.mjs — コードベースを歩いて import グラフ + 統計を city.json に落とす
// ゼロ依存。node builtins のみ。
import fs from 'node:fs';
import path from 'node:path';

function loadPathAliases(root) {
  // tsconfig.json / jsconfig.json の paths を読む（"@/*" -> "<root>/src/*" 等）
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = fs.readFileSync(path.join(root, name), 'utf8')
        .replace(/^\s*\/\/.*$/gm, ''); // 行コメント除去
      const cfg = JSON.parse(raw);
      const base = cfg.compilerOptions?.baseUrl ?? '.';
      const paths = cfg.compilerOptions?.paths ?? {};
      const map = Object.entries(paths).map(([key, [target]]) => ({
        re: new RegExp('^' + key.replace(/[*]/g, '(.+)') + '$'),
        to: path.resolve(root, base, target),
      }));
      if (map.length) return map;
    } catch { /* next config */ }
  }
  return [];
}

const EXT_ORDER = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PY_EXT = '.py';
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'venv', '.venv', '__pycache__', '.hermes', 'coverage', 'cdk.out']);
const EXTS = new Set(EXT_ORDER);

// --- import 抽出：文全体を捉えて名前つきバインディングまで取る ---
const IMPORT_STMT_RE = /\bimport\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]|\bexport\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;

function parseBindings(clause) {
  // "def, { a, b as c }" 等を {default:'def', names:[{n:'a',as:'a'},{n:'b',as:'c'}]} へ
  const out = { def: null, names: [] };
  const brace = clause.match(/\{([^}]*)\}/);
  if (brace) {
    for (let part of brace[1].split(',')) {
      part = part.trim(); if (!part) continue;
      const m = part.split(/\s+as\s+/);
      out.names.push({ n: m[0].trim(), as: (m[1] ?? m[0]).trim() });
    }
  }
  const defPart = clause.replace(/\{[^}]*\}/g, '').replace(/,/g, ' ').trim();
  if (defPart && /^\w+$/.test(defPart)) out.def = defPart;
  return out;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (EXTS.has(path.extname(entry.name)) || entry.name.endsWith(PY_EXT)) {
      yield path.join(dir, entry.name);
    }
  }
}

function resolveImport(fromFile, spec, aliases) {
  // エイリアス（@/foo -> <root>/src/foo）
  for (const a of aliases) {
    const m = a.re.exec(spec);
    if (m) {
      const base = a.to.replace(/\$(\d)/g, (_, d) => m[+d] ?? '').replace(/\*/g, m[1] ?? '');
      const candidates = [];
      if (path.extname(base)) candidates.push(base);
      else {
        for (const ext of EXT_ORDER) candidates.push(base + ext);
        for (const ext of EXT_ORDER) candidates.push(path.join(base, 'index' + ext));
      }
      for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
    }
  }
  if (!spec.startsWith('.')) return null; // 外部パッケージ
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [];
  if (path.extname(base)) candidates.push(base);
  else {
    for (const ext of EXT_ORDER) candidates.push(base + ext);
    for (const ext of EXT_ORDER) candidates.push(path.join(base, 'index' + ext));
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* try next */ }
  }
  return null;
}

function classifyKind(rel, syms = []) {
  const p = rel.split('/');
  const base = path.basename(rel).replace(/\.\w+$/, '');
  // 1) ディレクトリ規約（Next.js等のフレームワーク規約）
  if (p.includes('pages') || /route\.(ts|js)$/.test(rel)) return 'api';
  if (/(^|\/)page\.(tsx|jsx)$/.test(rel) || /(^|\/)layout\.(tsx|jsx)$/.test(rel)) return 'page';
  if (p.some(s => s === 'components' || s === 'ui')) return 'component';
  if (/^use[A-Z]/.test(base)) return 'hook';
  if (p.some(s => s === 'lib' || s === 'utils' || s === 'helpers')) return 'lib';
  if (p.some(s => s === 'types')) return 'type';
  if (p.some(s => s === 'hooks')) return 'hook';
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(rel) || p.some(s => s === 'tests' || s === '__tests__' || s === 'e2e')) return 'test';
  // 2) ファイル名規約（ディレクトリで分けないフラットなリポジトリ向け）
  if (/^(test|spec)-/.test(base)) return 'test';
  if (/^types?$/.test(base) || /[.-]types?$/.test(base) || /^(schema|models?|dto)$/.test(base)) return 'type';
  if (/(^|[.-])(server|handler|handlers|controller|controllers|router|routes|api|endpoints?)$/.test(base)) return 'api';
  if (/(^|[.-])(utils?|helpers?|shared|common|constants?)$/.test(base)) return 'lib';
  // 3) シンボルからの推定（規約が一切無い場合の最後の手がかり）
  if (syms.some(s => s.k === 'route' || s.k === 'api')) return 'api';
  if (syms.length && syms.every(s => s.k === 'type')) return 'type';
  return 'module';
}

// OS共通のID: Windowsでも区切りは '/'（timeline/git側と一致させる）
const relId = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

function districtOf(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'src') parts.shift();
  if (parts.length <= 1) return '(root)';
  const dirs = parts.slice(0, -1); // ファイル名を除くディレクトリ部分
  return dirs.slice(0, 2).join('/');
}

// シンボル抽出（正規表現ベース・ゼロ依存）。関数/クラス/定数/型/ルート
const SYM_PATTERNS = [
  { k: 'route', re: /@\w+\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/ },
  { k: 'api',   re: /^export\s+(?:default\s+)?(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/ },
  { k: 'fn',    re: /^export\s+default\s+(?:async\s+)?function\s*\*?\s*(\w+)/, def: true },
  { k: 'fn',    re: /^export\s+(?:async\s+)?function\s*\*?\s+(\w+)/ },
  { k: 'fn',    re: /^export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/ },
  { k: 'class', re: /^export\s+default\s+(?:abstract\s+)?class\s+(\w+)/, def: true },
  { k: 'class', re: /^export\s+(?:abstract\s+)?class\s+(\w+)/ },
  { k: 'type',  re: /^export\s+(?:type|interface)\s+(\w+)/ },
  { k: 'const', re: /^export\s+(?:const|let|var)\s+(\w+)/ },
];

function extractSymbols(src) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length && out.length < 80; i++) {
    const line = lines[i];
    for (const p of SYM_PATTERNS) {
      const m = p.re.exec(line);
      if (m) {
        const name = p.k === 'route' ? `${m[1].toUpperCase()} ${m[2]}` : m[1];
        out.push({ k: p.k, n: name, l: i + 1, ...(p.def ? { d: 1 } : {}) });
        break;
      }
    }
  }
  // 本体終端の推定: ブレース/括弧の深さが定義行から0に戻る行。開きがなければ単一行
  assignJsEnds(out, lines);
  return out;
}

function assignJsEnds(syms, lines) {
  const sorted = [...syms].sort((a, b) => a.l - b.l);
  for (let si = 0; si < sorted.length; si++) {
    const s = sorted[si];
    const hardEnd = si + 1 < sorted.length ? sorted[si + 1].l : lines.length + 1;
    let depth = 0, opened = false, e = Math.min(s.l, lines.length);
    for (let i = s.l - 1; i < lines.length && i < hardEnd - 1; i++) {
      for (const ch of lines[i]) {
        if (ch === '{' || ch === '(' || ch === '[') { depth++; opened = true; }
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
      }
      if (opened && depth <= 0) { e = i + 1; break; }
      if (!opened) e = i + 1; // 単一行宣言（type alias等）
    }
    s.e = e;
  }
}

// --- Python対応: import/シンボル/呼び出し ---
const PY_IMPORT_RE = /^\s*from\s+([\w.]+)\s+import\s+(.+)|^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const PY_DEF_RE = /^(?:async\s+)?def\s+(\w+)\s*\(|^class\s+(\w+)/;

function resolvePyModule(fromFile, module, absRoot) {
  // "server" / "pkg.mod" -> 相対解決（同一root内の.py）
  const base = module.split('.').join('/');
  for (const c of [path.join(absRoot, base + '.py'), path.join(absRoot, base, '__init__.py')]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

function extractPySymbols(src) {
  const out = [];
  const lines = src.split('\n');
  let inCls = null;
  for (let i = 0; i < lines.length && out.length < 120; i++) {
    const line = lines[i];
    if (line.startsWith('class ')) {
      const m = /^class\s+(\w+)/.exec(line);
      if (m) { out.push({ k: 'class', n: m[1], l: i + 1 }); inCls = m[1]; continue; }
    }
    if (/^\S/.test(line)) inCls = null; // クラスを抜けた
    const dm = PY_DEF_RE.exec(line);
    if (dm) {
      const name = dm[1] ?? dm[2];
      if (inCls) {
        // クラスメソッド: Handler.do_GET 形式で登録
        if (!out.some(s => s.n === name && s.k === 'fn')) out.push({ k: 'fn', n: `${inCls}.${name}`, l: i + 1 });
      } else {
        out.push({ k: 'fn', n: name, l: i + 1 });
      }
    }
    // ルート定義（HTTPハンドラ内のパス分岐も拾う）
    const rm = /u\.path\s*(?:==|\.startswith\()\s*["'](\/api\/[\w\-/.]*)["']/.exec(line);
    if (rm) out.push({ k: 'route', n: rm[1], l: i + 1 });
  }
  // 終端推定: def行のインデントより深い連続ブロックの最終行
  assignPyEnds(out, lines);
  return out;
}

function assignPyEnds(syms, lines) {
  for (const s of syms) {
    const base = lines[s.l - 1].search(/\S/);
    if (base < 0) continue;
    let e = s.l;
    for (let i = s.l; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const ind = line.search(/\S/);
      if (ind <= base) break;
      e = i + 1;
    }
    s.e = e;
  }
}

const reWord = s => new RegExp('\\b' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');

function dedupeCalls(arr) {
  const seen = new Set(), out = [];
  for (const c of arr) {
    const k = c.from + '→' + c.to;
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}
function dedupeExt(arr) {
  const seen = new Set(), out = [];
  for (const c of arr) {
    const k = c.from + '→' + c.file + '#' + c.name;
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}

// ファイル内の呼び出し解析: シンボル定義行から次の定義行までをそのシンボルの本体とみなし、
// 本体内に出現する他シンボル＝呼び出し、import束縛の使用＝外部呼び出しとする
function analyzeCalls(src, syms, binds) {
  const defs = syms.filter(s => s.k !== 'route').sort((a, b) => a.l - b.l);
  const lines = src.split('\n');
  const calls = []; // {from,to} ファイル内
  const ext = [];   // {from,file,name} 外部ファイルの関数
  defs.forEach((s, i) => {
    const start = s.l - 1;
    const end = i + 1 < defs.length ? defs[i + 1].l - 1 : lines.length;
    const body = lines.slice(start, end).join('\n');
    for (const o of defs) {
      if (o === s) continue;
      if (reWord(o.n).test(body)) calls.push({ from: s.n, to: o.n });
    }
    for (const b of binds) {
      if (reWord(b.as).test(body)) ext.push({ from: s.n, file: b.file, name: b.name });
    }
  });
  return { calls, ext };
}

// --- 1ファイル分の解析。他ファイルに依存しないので単体で再実行でき、そのままキャッシュ単位になる ---
function parseFile(absRoot, file, aliases) {
  const rel = relId(absRoot, file);
  const src = fs.readFileSync(file, 'utf8');
  const imports = [];   // relId配列（解決できた intra-repo import のみ）
  const symEdges = [];  // {from, name, to} — 関数レベルの使用関係
  const binds = [];     // {as, file, name} — このファイル内のimport束縛（呼び出し解析用）
  const external = [];  // 外部パッケージ名
  let m;
  let syms;

  if (file.endsWith(PY_EXT)) {
    // ---- Python: import解析 + def/class抽出 ----
    syms = extractPySymbols(src);
    PY_IMPORT_RE.lastIndex = 0;
    while ((m = PY_IMPORT_RE.exec(src))) {
      if (m[1]) {
        // from X import a, b
        const resolved = resolvePyModule(file, m[1], absRoot);
        if (resolved) {
          imports.push(relId(absRoot, resolved));
          for (const rawName of m[2].split(',')) {
            const name = rawName.split(' as ')[0].trim();
            if (!name || name === '*') continue;
            const local = rawName.includes(' as ') ? rawName.split(' as ')[1].trim() : name;
            if (reWord(local).test(src)) {
              symEdges.push({ from: rel, name, to: relId(absRoot, resolved) });
              binds.push({ as: local, file: relId(absRoot, resolved), name });
            }
          }
        } else {
          external.push(m[1].split('.')[0]);
        }
      } else if (m[3]) {
        // import x, y
        for (const mod of m[3].split(',')) {
          const modName = mod.trim().split(' as ')[0];
          const resolved = resolvePyModule(file, modName, absRoot);
          const rootName = modName.split('.')[0];
          if (resolved && reWord(rootName).test(src)) {
            imports.push(relId(absRoot, resolved));
            symEdges.push({ from: rel, name: rootName, to: relId(absRoot, resolved) });
            binds.push({ as: rootName, file: relId(absRoot, resolved), name: rootName });
          } else if (!resolved) {
            external.push(rootName);
          }
        }
      }
    }
  } else {
    // ---- JS/TS ---
    IMPORT_STMT_RE.lastIndex = 0;
    while ((m = IMPORT_STMT_RE.exec(src))) {
      const clause = m[1] ?? m[5] ?? ''; // import句 / export-from句
      const spec = m[2] ?? m[3] ?? m[4] ?? m[6] ?? m[7];
      if (!spec) continue;
      const resolved = resolveImport(file, spec, aliases);
      if (resolved) {
        imports.push(relId(absRoot, resolved));
        // 名前つきバインディングからシンボルエッジを組む
        const b = parseBindings(clause);
        const usedNames = new Set();
        for (const nm of b.names) {
          // その名前が本文中で本当に使われているか（import行以降で1回以上）
          const re = new RegExp('\\b' + nm.as.replace(/\$/g, '\\$') + '\\b');
          const after = src.slice(m.index + m[0].length);
          if (re.test(after)) usedNames.add(nm.n);
        }
        for (const n of usedNames) {
          symEdges.push({ from: rel, name: n, to: relId(absRoot, resolved) });
          binds.push({ as: n, file: relId(absRoot, resolved), name: n });
        }
        // default importはターゲット側のdefault exportへ（解決は描画側でゆるく）
        if (b.def && src.slice(m.index + m[0].length).match(new RegExp('\\b' + b.def + '\\b'))) {
          symEdges.push({ from: rel, name: 'default', to: relId(absRoot, resolved), as: b.def });
          binds.push({ as: b.def, file: relId(absRoot, resolved), name: 'default' });
        }
      } else {
        external.push(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
      }
    }
    syms = extractSymbols(src);
  }

  const r = analyzeCalls(src, syms ?? [], binds);
  return {
    id: rel,
    kind: classifyKind(rel, syms),
    district: districtOf(rel),
    loc: src.split('\n').length,
    bytes: src.length,
    exports: (src.match(/^export (?:default |const |function |class |async )/gm) || []).length,
    syms,
    imports,
    symEdges,
    external,
    calls: dedupeCalls(r.calls),
    ext: dedupeExt(r.ext),
  };
}

// --- 解析済みレコードの集約。ファイル間の関係（edges/fanIn/呼び出しグラフ）はここで組む ---
function assemble(absRoot, recs, t0) {
  const nodes = new Map(); // relId -> node
  for (const [rel, r] of recs) nodes.set(rel, { ...r, deps: [], fanIn: 0 });

  // imports のうち街に存在するファイルだけをエッジ化
  const edges = [];
  for (const node of nodes.values()) {
    for (const target of node.imports) {
      const t = nodes.get(target);
      if (t) { node.deps.push(t.id); edges.push({ from: node.id, to: t.id }); }
    }
  }
  for (const e of edges) nodes.get(e.to).fanIn++;

  const list = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));

  // 呼び出しグラフ v2: ファイル内calls + import束縛の外部呼出しを「関数→関数」に解決して統合。
  // 規律: ターゲットシンボルが抽出済み表に存在する組だけ採用（偽陽性抑制）
  const symIndex = new Set(); // `${file}::${name}`
  for (const n of list) for (const s of (n.syms ?? [])) symIndex.add(n.id + '::' + s.n);
  const callsV2 = [];
  for (const n of list) {
    // 同一ファイル内: from/toとも同ファイルの実在シンボル
    for (const c of (n.calls ?? [])) {
      if (symIndex.has(n.id + '::' + c.to)) callsV2.push({ f: n.id, fs: c.from, t: n.id, ts: c.to });
    }
    // 横断: その関数本体(x.from)内でimport束縛を使用し、ターゲットファイルのexportシンボルとして存在する
    for (const x of (n.ext ?? [])) {
      if (symIndex.has(x.file + '::' + x.name)) callsV2.push({ f: n.id, fs: x.from || '(module)', t: x.file, ts: x.name });
    }
  }
  // 重複除去（同一組が複数bindから流れることがある）
  const seenCall = new Set();
  const callsDedup = callsV2.filter(c => {
    const k = c.f + '::' + c.fs + '→' + c.t + '::' + c.ts;
    if (seenCall.has(k)) return false;
    seenCall.add(k); return true;
  });
  // 上限1000件（超過は切り捨て。呼び出しは既にfan-in上位ビルに偏る）
  const callsFinal = callsDedup.length > 1000 ? callsDedup.slice(0, 1000) : callsDedup;

  const external = new Set();
  for (const r of recs.values()) for (const p of (r.external ?? [])) external.add(p);

  return {
    root: path.basename(absRoot),
    generatedAt: new Date().toISOString(),
    stats: {
      files: list.length,
      loc: list.reduce((s, n) => s + n.loc, 0),
      edges: edges.length,
      districts: new Set(list.map(n => n.district)).size,
      externalPkgs: external.size,
      calls: callsFinal.length,
      extractMs: Math.round(performance.now() - t0),
    },
    nodes: list.map(({ id, kind, district, loc, bytes, deps, exports: exp, fanIn, syms }) =>
      ({ id, kind, district, loc, bytes, deps, exports: exp, fanIn, syms })),
    edges,
    calls: callsFinal,
  };
}

// --- 解析キャッシュ: mtime+sizeが一致するファイルは前回のレコードを使い回す ---
const CACHE_V = 1;

function loadCache(cachePath, absRoot) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c.v === CACHE_V && c.root === absRoot) return c;
  } catch { /* 壊れていたら無視して全量解析 */ }
  return null;
}

// opts.cache: true でリポジトリ直下の .system-map-cache.json、文字列でそのパスを使う
export function extract(root, opts = {}) {
  const t0 = performance.now();
  const absRoot = path.resolve(root);
  const aliases = loadPathAliases(absRoot);
  const cachePath = opts.cache === true ? path.join(absRoot, '.system-map-cache.json')
    : (typeof opts.cache === 'string' ? opts.cache : null);
  const prev = cachePath ? loadCache(cachePath, absRoot) : null;
  const next = cachePath ? { v: CACHE_V, root: absRoot, files: {} } : null;

  const recs = new Map();
  let hits = 0, parsed = 0;
  for (const file of walk(absRoot)) {
    const rel = relId(absRoot, file);
    let rec = null, st = null;
    if (cachePath) {
      st = fs.statSync(file);
      const hit = prev?.files[rel];
      if (hit && hit.m === st.mtimeMs && hit.s === st.size) { rec = hit.r; hits++; }
    }
    if (!rec) { rec = parseFile(absRoot, file, aliases); parsed++; }
    recs.set(rel, rec);
    if (next) next.files[rel] = { m: st.mtimeMs, s: st.size, r: rec };
  }
  if (next) fs.writeFileSync(cachePath, JSON.stringify(next));

  const city = assemble(absRoot, recs, t0);
  if (cachePath) { city.stats.cacheHits = hits; city.stats.parsed = parsed; }
  return city;
}

// --- 差分抽出セッション: 常駐して1ファイル単位で解析を更新する（serve / VS Code拡張用） ---
export function createSession(root) {
  const absRoot = path.resolve(root);
  let aliases = loadPathAliases(absRoot);
  const recs = new Map();
  const t0 = performance.now();
  for (const file of walk(absRoot)) recs.set(relId(absRoot, file), parseFile(absRoot, file, aliases));
  const initMs = Math.round(performance.now() - t0);
  const targeted = (abs) => EXTS.has(path.extname(abs)) || abs.endsWith(PY_EXT);

  return {
    root: absRoot,
    initMs,
    size: () => recs.size,
    has: (rel) => recs.has(rel),
    // 現時点のレコードから city.json を組み立てる
    city: () => assemble(absRoot, recs, performance.now()),
    // 1ファイルだけ再解析する。対象外の拡張子は null、消えていれば removed:true
    update(file) {
      const abs = path.resolve(absRoot, file);
      if (!targeted(abs)) return null;
      const t = performance.now();
      const rel = relId(absRoot, abs);
      if (!fs.existsSync(abs)) {
        const removed = recs.delete(rel);
        return { id: rel, removed, parseMs: +(performance.now() - t).toFixed(1) };
      }
      recs.set(rel, parseFile(absRoot, abs, aliases));
      return { id: rel, removed: false, parseMs: +(performance.now() - t).toFixed(1) };
    },
    // tsconfig の paths が変わったときに呼ぶ
    reloadAliases() { aliases = loadPathAliases(absRoot); },
  };
}

// CLI直接実行: node extract.mjs <repo> [out.json]
if (process.argv[1] && process.argv[1].endsWith('extract.mjs')) {
  const root = process.argv[2];
  if (!root) { console.error('usage: node extract.mjs <repo> [out.json]'); process.exit(1); }
  const city = extract(root);
  const out = process.argv[3] ?? 'city.json';
  fs.writeFileSync(out, JSON.stringify(city));
  console.log(`${city.stats.files} files, ${city.stats.edges} edges, ${city.stats.districts} districts in ${city.stats.extractMs}ms -> ${out}`);
}
