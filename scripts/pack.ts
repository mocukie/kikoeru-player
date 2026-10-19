// node scripts/pack.ts <目錄> [--tag <v版本>]：以 pnpm pack（prepack 會先 pnpm build）產生套件 tgz 到 <目錄>，
// 並檢查內容只有 dist/、LICENSE、NOTICE、LICENSES/（docs/architecture.md「套件形狀」）。
// 給了 --tag 時先確認 tag 與 package.json 的版本一致（CI 的 release job）。印出 tgz 的路徑。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkPackFiles, checkReleaseTag } from './package.ts';
import { repoRoot } from './wasm.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { tag: { type: 'string' } },
});
const [destination] = positionals;
if (destination === undefined || positionals.length !== 1) {
  console.error('用法：node scripts/pack.ts <目錄> [--tag <v版本>]');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};
if (values.tag !== undefined) {
  const problem = checkReleaseTag(values.tag, pkg.version);
  if (problem !== undefined) {
    console.error(problem);
    process.exit(1);
  }
}

const dir = isAbsolute(destination) ? destination : resolve(destination);
mkdirSync(dir, { recursive: true });
// lifecycle（prepack 的 build）的輸出與 JSON 都在 stdout；JSON 是最後一段。
const pack = spawnSync('pnpm', ['pack', '--json', '--pack-destination', dir], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (pack.status !== 0) {
  process.stdout.write(pack.stdout);
  process.exit(pack.status ?? 1);
}
const json = pack.stdout.slice(pack.stdout.lastIndexOf('\n{') + 1);
const result = JSON.parse(json) as { filename: string; files: { path: string }[] };
process.stderr.write(pack.stdout.slice(0, pack.stdout.length - json.length));

const problems = checkPackFiles(result.files.map((f) => f.path));
if (problems.length > 0) {
  console.error(`套件內容不符：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(isAbsolute(result.filename) ? result.filename : join(dir, result.filename));
