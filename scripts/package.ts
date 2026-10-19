// Engine 套件的產物與發版檢查（ADR-0005、docs/architecture.md「Build 產物」「套件形狀」）。
// scripts/build.ts、scripts/pack.ts 與 CI 的 release job 共用；函式都以套件根目錄為參數，方便以暫時目錄測試。
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSha256Sums, wasmDistDir, wasmReleaseUrl } from './wasm.ts';

/** 複製到 `dist/wasm/` 的 wasm Release 檔案：wasm、glue 與 libav.js frontend（不含型別）。 */
const WASM_ASSET = /^libav-.*\.(wasm|mjs)$/;

/** tsc 輸出的 `thirdPartyNotices` 模組（佔位值），build 時以 wasm Release 的內容取代。 */
const NOTICES_MODULE = join('dist', 'main', 'third-party-notices.js');

/** `dist/wasm/wasm.json` 的內容：套件內附的 wasm 對應哪一個 wasm Release。 */
export interface WasmManifest {
  tag: string;
  releaseUrl: string;
  /** `dist/wasm/` 內每個複本的 sha256，與 wasm Release 的 SHA256SUMS 相同。 */
  files: Record<string, string>;
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/**
 * 在 tsc 輸出之後產生套件的其他產物：
 * - `dist/wasm/`：wasm、glue、frontend 的原封不動複本，以及 `wasm.json`。
 * - 根目錄的 `NOTICE` 與 `LICENSES/LGPL-2.1.txt`（`files` 列出的授權檔案，gitignored）。
 * - `dist/main/third-party-notices.js`：寫入 wasm Release 原始碼網址的 `thirdPartyNotices`。
 *
 * 先以 SHA256SUMS 驗證 `wasm/dist/` 的檔案，不符時不寫出任何東西。
 */
export function writePackageAssets(root: string, tag: string): WasmManifest {
  const from = wasmDistDir(root);
  const files: Record<string, string> = {};
  for (const { file, sha256: expected } of parseSha256Sums(
    readFileSync(join(from, 'SHA256SUMS'), 'utf8'),
  )) {
    if (!WASM_ASSET.test(file)) continue;
    const actual = sha256(readFileSync(join(from, file)));
    if (actual !== expected) {
      throw new Error(`wasm/dist/${file} 的 sha256 不符：${actual}，SHA256SUMS 是 ${expected}`);
    }
    files[file] = actual;
  }
  if (Object.keys(files).length === 0) throw new Error('wasm/dist/SHA256SUMS 沒有 wasm 檔案。');
  const noticesModule = join(root, NOTICES_MODULE);
  if (!existsSync(noticesModule)) {
    throw new Error(`找不到 ${NOTICES_MODULE}：要在 tsc 輸出之後執行。`);
  }

  const releaseUrl = wasmReleaseUrl(root, tag);
  const manifest: WasmManifest = { tag, releaseUrl, files };
  const to = join(root, 'dist', 'wasm');
  mkdirSync(to, { recursive: true });
  for (const file of Object.keys(files)) copyFileSync(join(from, file), join(to, file));
  writeFileSync(join(to, 'wasm.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const notice = noticeText(tag, releaseUrl);
  writeFileSync(join(root, 'NOTICE'), notice);
  mkdirSync(join(root, 'LICENSES'), { recursive: true });
  copyFileSync(join(from, 'LGPL-2.1.txt'), join(root, 'LICENSES', 'LGPL-2.1.txt'));
  writeFileSync(noticesModule, noticesModuleSource(releaseUrl, notice));
  return manifest;
}

/** 套件的 NOTICE：FFmpeg 的 LGPL 聲明、套件內的檔案位置與 wasm Release（原始碼）的連結。 */
function noticeText(tag: string, releaseUrl: string): string {
  return `kikoeru-player

The code of kikoeru-player itself is licensed under the MIT License (LICENSE).

This package includes FFmpeg (https://ffmpeg.org/), licensed under the GNU
Lesser General Public License version 2.1 or later (LGPL-2.1-or-later),
compiled to WebAssembly with libav.js (https://github.com/Yahweasel/libav.js,
0BSD). The full text of the license is in LICENSES/LGPL-2.1.txt.

The FFmpeg build is the files in dist/wasm/, unmodified copies of the wasm
release ${tag}. The license header at the top of the
libav-*.wasm.mjs file lists the licenses of all code compiled into the .wasm
file.

The complete corresponding source code (FFmpeg, libav.js, the patches, the
configuration and the build scripts) is sources.tar in:
${releaseUrl}
`;
}

/** `dist/main/third-party-notices.js` 的內容；型別（`.d.ts`）沿用 tsc 的輸出。 */
function noticesModuleSource(sourceUrl: string, notice: string): string {
  const entry = { name: 'FFmpeg', license: 'LGPL-2.1-or-later', sourceUrl, noticeText: notice };
  return `// 由 scripts/package.ts 在 build 時產生（ADR-0005）。
export const thirdPartyNotices = Object.freeze([Object.freeze(${JSON.stringify(entry, null, 2)})]);
`;
}

/** 發版的 tag 必須是 `v` 加上 package.json 的版本；一致時回傳 undefined，否則回傳說明。 */
export function checkReleaseTag(tag: string, version: string): string | undefined {
  if (tag === `v${version}`) return undefined;
  return `tag ${tag} 與 package.json 的版本 ${version} 不一致（應為 v${version}）。`;
}

/** 套件一定要有的檔案；`*` 比對單一路徑段內的任意字元。 */
const REQUIRED_FILES = [
  'LICENSE',
  'NOTICE',
  'LICENSES/LGPL-2.1.txt',
  'dist/index.js',
  'dist/wasm/wasm.json',
  'dist/wasm/libav-*.wasm',
];

/** pnpm／npm 不論 `files` 都會放進套件的檔案。 */
const ALWAYS_PACKED = ['package.json', 'README.md'];

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);

/**
 * 檢查 `pnpm pack` 的檔案清單：只能有 `dist/`、`LICENSE`、`NOTICE`、`LICENSES/`（加上一定會放的
 * package.json 與 README），不得含 LGPL 原始碼（`sources.tar`、`sources/`），且必要的檔案都在。回傳問題清單。
 */
export function checkPackFiles(paths: readonly string[]): string[] {
  const problems: string[] = [];
  for (const path of paths) {
    const allowed =
      ALWAYS_PACKED.includes(path) ||
      ['LICENSE', 'NOTICE'].includes(path) ||
      path.startsWith('LICENSES/') ||
      path.startsWith('dist/');
    const source = /(^|\/)sources(\.tar|\/)/.test(path);
    if (!allowed || source) problems.push(`不該在套件內：${path}`);
  }
  for (const pattern of REQUIRED_FILES) {
    if (!paths.some((path) => glob(pattern).test(path))) problems.push(`套件缺少：${pattern}`);
  }
  return problems;
}
