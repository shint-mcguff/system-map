// gen-fixture.mjs — スケール検証用の合成リポジトリを生成する
// 使い方: node gen-fixture.mjs <出力先> [ファイル数]
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'fixtures/synth';
const target = parseInt(process.argv[3] ?? '2000', 10);

const DISTRICTS = ['core', 'api', 'web', 'workers', 'shared', 'admin', 'billing', 'auth', 'search', 'notify'];
const KINDS = ['service', 'handler', 'component', 'util', 'model', 'client'];

fs.rmSync(out, { recursive: true, force: true });

let made = 0, i = 0;
const allFiles = [];
while (made < target) {
  const dist = DISTRICTS[i % DISTRICTS.length];
  const kind = KINDS[(i >> 2) % KINDS.length];
  const sub = `mod${(i >> 4) % 12}`;
  const dir = path.join(out, 'src', dist, sub);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${kind}-${i}.ts`;
  const file = path.join(dir, name);

  // import先: 実在する既存ファイルから選ぶ（相対パス + エイリアス混在）
  const imports = [];
  if (allFiles.length > 10) {
    const pick = (n) => allFiles[(i * 31 + n * 17) % allFiles.length];
    const relFrom = (targetFile, prefix) => {
      const rel = path.relative(dir, targetFile).replace(/\.ts$/, '');
      return prefix === '@' ? '@/src/' + path.relative(out, targetFile).replace(/^src\//, '').replace(/\.ts$/, '') : './' + rel;
    };
    imports.push(relFrom(pick(1)));
    if (i % 3 === 0) imports.push(relFrom(pick(2), '@'));
    if (i % 7 === 0 && allFiles.length > 40) imports.push(relFrom(pick(3)));
  }
  if (i % 5 === 0) imports.push('zod');

  const body = `// ${kind} #${i}
import { z } from 'zod';
${imports.map((s, j) => `import { fn${j} } from '${s}';`).join('\n')}

export interface Payload${i} { id: string; value: number; tags?: string[] }

export class ${Kind(kind)}${i} {
  private cache = new Map<string, number>();
  async run(input: Payload${i}): Promise<number> {
${imports.map((_, j) => `    const v${j} = await fn${j}(input.value);`).join('\n')}
    const total = [${imports.map((_, j) => `v${j}`).join(', ') || '0'}].reduce((a, b) => a + b, input.value);
    this.cache.set(input.id, total);
    return total;
  }
}

export default ${Kind(kind)}${i};
`;
  fs.writeFileSync(file, body.replace(/^import \{ z \}.*\n/m, i % 5 === 0 ? "import { z } from 'zod';\n" : ''));
  allFiles.push(file);
  made++; i++;
}

// tsconfig paths（@/ -> src/）を置く
fs.writeFileSync(path.join(out, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
}, null, 2));

function Kind(k) { return k[0].toUpperCase() + k.slice(1); }
console.log(`generated ${made} files under ${out}/src`);
