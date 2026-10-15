// pnpm wasm:fetch：下載與目前 wasm/ 的 tree hash 相符的 wasm Release 到 wasm/dist/，以 SHA256SUMS 驗證（ADR-0005）。
// 不下載只用於 LGPL 原始碼提供的 sources.tar。
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  installWasmDist,
  parseSha256Sums,
  repoRoot,
  SOURCES_ASSET,
  wasmAssetUrl,
  wasmReleaseTag,
  wasmWorkDir,
} from './wasm.ts';

const tag = wasmReleaseTag(repoRoot);

async function download(file: string): Promise<Uint8Array> {
  const response = await fetch(wasmAssetUrl(repoRoot, tag, file));
  if (response.status === 404 && file === 'SHA256SUMS') {
    console.error(
      `找不到 wasm Release ${tag}。` +
        'Release 由 CI 的 ensure-wasm 在 push 後發布；wasm/ 有尚未發布的修改時，改用 pnpm wasm:build 在本機 build。',
    );
    process.exit(1);
  }
  if (!response.ok) throw new Error(`下載 ${file} 失敗：HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

console.log(`下載 ${tag}`);
const sums = await download('SHA256SUMS');
const work = wasmWorkDir(repoRoot);
mkdirSync(work, { recursive: true });
const tmp = mkdtempSync(join(work, 'fetch-'));
try {
  writeFileSync(join(tmp, 'SHA256SUMS'), sums);
  for (const { file, sha256 } of parseSha256Sums(new TextDecoder().decode(sums))) {
    if (file === SOURCES_ASSET) continue;
    const data = await download(file);
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== sha256)
      throw new Error(`${file} 的 sha256 不符：${actual}，SHA256SUMS 是 ${sha256}`);
    writeFileSync(join(tmp, file), data);
  }
  installWasmDist(repoRoot, tmp, tag);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`wasm/dist/ 已更新為 ${tag}`);
