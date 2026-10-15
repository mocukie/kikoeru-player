// pnpm wasm:build：在 Docker 內 build wasm（wasm/build.sh），做 LGPL 檢查，通過後放進 wasm/dist/（ADR-0005）。
// CI 的 ensure-wasm 也用它 build，之後把 wasm/.work/release/ 的全部檔案發布成 Release。
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { checkLgpl, installWasmDist, repoRoot, wasmReleaseTag, wasmReleaseUrl } from './wasm.ts';

const tag = wasmReleaseTag(repoRoot);
const work = join(repoRoot, 'wasm', '.work');
console.log(`build ${tag}`);

const build = spawnSync(join(repoRoot, 'wasm', 'build.sh'), [tag, wasmReleaseUrl(repoRoot, tag)], {
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const problems = checkLgpl(readFileSync(join(work, 'config.h'), 'utf8'));
if (problems.length > 0) {
  console.error(`LGPL 檢查失敗（硬性約束第 9 條）：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}

const release = join(work, 'release');
installWasmDist(repoRoot, release, tag);

// 原始大小與 brotli（quality 11）後的大小，PR description 與 CI log 用。
const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log('\n| 檔案 | raw | brotli |\n|---|---|---|');
for (const file of readdirSync(release)
  .filter((f) => f.startsWith('libav-'))
  .sort()) {
  const data = readFileSync(join(release, file));
  const brotli = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  console.log(`| \`${file}\` | ${kib(data.length)} | ${kib(brotli.length)} |`);
}
console.log(`\nwasm/dist/ 已更新為 ${tag}；Release 的全部檔案在 wasm/.work/release/。`);
