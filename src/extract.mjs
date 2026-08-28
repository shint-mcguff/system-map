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
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'venv', '.venv', '__pycache__', '.hermes', 'coverage']);
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

function classifyKind(rel) {
  const p = rel.split('/');
  if (p.includes('pages') || /route\.(ts|js)$/.test(rel)) return 'api';
  if (/(^|\/)page\.(tsx|jsx)$/.test(rel) || /(^|\/)layout\.(tsx|jsx)$/.test(rel)) return 'page';
  if (p.some(s => s === 'components' || s === 'ui')) return 'component';
  if (/(^|\/)use[A-Z]/.test(path.basename(rel))) return 'hook';
  if (p.some(s => s === 'lib' || s === 'utils' || s === 'helpers')) return 'lib';
  if (p.some(s => s === 'types')) return 'type';
  if (p.some(s => s === 'hooks')) return 'hook';
  if (/\.test\.(ts|tsx|js|jsx)$/.test(rel) || p.includes('tests') || p.includes('__tests__')) return 'test';
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

export function extract(root) {
  const t0 = performance.now();
  const absRoot = path.resolve(root);
  const aliases = loadPathAliases(absRoot);
  const nodes = new Map(); // absPath -> node
  const external = new Map(); // pkg -> count

  for (const file of walk(absRoot)) {
    const rel = relId(absRoot, file);
    const src = fs.readFileSync(file, 'utf8');
    const imports = [];
    const symEdges = []; // {local, targetId, targetName} — 関数レベルの使用関係
    const binds = []; // {as, file, name} — このファイル内のimport束縛（呼び出し解析用）
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
            imports.push(resolved);
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
            external.set(m[1].split('.')[0], (external.get(m[1].split('.')[0]) ?? 0) + 1);
          }
        } else if (m[3]) {
          // import x, y
          for (const mod of m[3].split(',')) {
            const modName = mod.trim().split(' as ')[0];
            const resolved = resolvePyModule(file, modName, absRoot);
            const root = modName.split('.')[0];
            if (resolved && reWord(root).test(src)) {
              imports.push(resolved);
              symEdges.push({ from: rel, name: modName.split('.')[0], to: relId(absRoot, resolved) });
              binds.push({ as: root, file: relId(absRoot, resolved), name: root });
            } else if (!resolved) {
              external.set(root, (external.get(root) ?? 0) + 1);
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
          imports.push(resolved);
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
          const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          external.set(pkg, (external.get(pkg) ?? 0) + 1);
        }
      }
      syms = extractSymbols(src);
    }
    nodes.set(file, {
      id: rel,
      kind: classifyKind(rel),
      district: districtOf(rel),
      loc: src.split('\n').length,
      bytes: src.length,
      imports, // absPath配列（後でidに正規化）
      exports: (src.match(/^export (?:default |const |function |class |async )/gm) || []).length,
      syms,
      symEdges,
      _binds: binds,
    });
  }

  // imports を id に正規化 + 存在するノードのみエッジ化
  const edges = [];
  for (const node of nodes.values()) {
    node.deps = [];
    for (const target of node.imports) {
      const t = nodes.get(target);
      if (t) { node.deps.push(t.id); edges.push({ from: node.id, to: t.id }); }
    }
    delete node.imports;
    node.fanIn = 0;
  }
  const idOf = new Map([...nodes.values()].map(n => [n.id, n]));
  for (const e of edges) idOf.get(e.to).fanIn++;

  // ファイル内呼び出し解析（シンボル定義済みのノードのみ）
  for (const node of nodes.values()) {
    const r = analyzeCalls(fs.readFileSync(path.join(absRoot, node.id), 'utf8'), node.syms ?? [], node._binds ?? []);
    node.calls = dedupeCalls(r.calls);
    node.ext = dedupeExt(r.ext);
    delete node._binds;
  }

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

// CLI直接実行: node extract.mjs <repo> [out.json]
if (process.argv[1] && process.argv[1].endsWith('extract.mjs')) {
  const root = process.argv[2];
  if (!root) { console.error('usage: node extract.mjs <repo> [out.json]'); process.exit(1); }
  const city = extract(root);
  const out = process.argv[3] ?? 'city.json';
  fs.writeFileSync(out, JSON.stringify(city));
  console.log(`${city.stats.files} files, ${city.stats.edges} edges, ${city.stats.districts} districts in ${city.stats.extractMs}ms -> ${out}`);
}
