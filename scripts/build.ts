// pnpm build：tsc 輸出到 dist/，再產生 dist/wasm/、wasm.json、NOTICE、LICENSES/ 與 thirdPartyNotices（ADR-0005）。
// `pnpm build --watch`：完成一次 build 後以 tsc 的 watch 模式持續輸出；tsc 重新輸出 thirdPartyNotices 的佔位模組時再寫回。
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, watch } from 'node:fs';
import { join } from 'node:path';
import { writePackageAssets } from './package.ts';
import { checkWasmDist, repoRoot, wasmReleaseTag } from './wasm.ts';

const watchMode = process.argv.includes('--watch');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--watch');
if (unknown.length > 0) {
  console.error(`不認得的參數：${unknown.join(' ')}（只支援 --watch）`);
  process.exit(2);
}

const problem = checkWasmDist(repoRoot);
if (problem !== undefined) {
  console.error(problem);
  process.exit(1);
}

const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
const project = join(repoRoot, 'tsconfig.build.json');
rmSync(join(repoRoot, 'dist'), { recursive: true, force: true });
const build = spawnSync(tsc, ['-b', project, '--force'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const tag = wasmReleaseTag(repoRoot);
writePackageAssets(repoRoot, tag);
console.log(`dist/ 已產生（wasm ${tag}）。`);

if (watchMode) {
  const noticesModule = join(repoRoot, 'dist', 'main', 'third-party-notices.js');
  const generated = readFileSync(noticesModule, 'utf8');
  watch(join(repoRoot, 'dist', 'main'), (_event, file) => {
    if (file !== 'third-party-notices.js') return;
    try {
      if (readFileSync(noticesModule, 'utf8') !== generated) writePackageAssets(repoRoot, tag);
    } catch {
      // tsc 寫到一半時檔案可能暫時不存在，下一個事件再處理。
    }
  });
  const child = spawn(tsc, ['-b', project, '--watch', '--preserveWatchOutput'], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}
