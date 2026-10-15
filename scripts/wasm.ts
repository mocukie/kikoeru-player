// wasm 的 Release tag、wasm/dist/ 的檢查與 LGPL 檢查（ADR-0005）。
// scripts/wasm-*.ts 與 scripts/check-wasm.ts 共用；函式都以套件根目錄為參數，方便以暫時的 git repo 測試。
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本 repo 的根目錄。 */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Release 中只用於 LGPL 原始碼提供、不放進 wasm/dist/ 的檔案。 */
export const SOURCES_ASSET = 'sources.tar';

/** 標示 wasm/dist/ 對應哪一個 Release tag 的檔案；wasm:fetch 與 wasm:build 最後才寫入。 */
const STAMP = '.stamp';

/** wasm/build.sh 的工作目錄（gitignored）：release/ 是 Release 的全部檔案，config.h 供 LGPL 檢查。 */
export function wasmWorkDir(root: string): string {
  return join(root, 'wasm', '.work');
}

export function wasmDistDir(root: string): string {
  return join(root, 'wasm', 'dist');
}

/** 讀取 wasm/versions.env：每行一個 KEY=VALUE，# 開頭為註解。 */
export function parseVersions(text: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [, key, value] = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed) ?? [];
    if (key === undefined || value === undefined) {
      throw new Error(`wasm/versions.env 有無法解析的行：${trimmed}`);
    }
    versions[key] = value;
  }
  return versions;
}

/**
 * `wasm/` 的 git tree hash。包含尚未 commit 的修改與未被 ignore 的新檔案；
 * working tree 乾淨時等於 `git rev-parse HEAD:wasm`。用暫時的 index 計算，不改動 repo 的 index。
 */
export function wasmTreeHash(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kikoeru-wasm-index-'));
  try {
    const options = {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_INDEX_FILE: join(dir, 'index') },
    } as const;
    execFileSync('git', ['add', '--all', '--', 'wasm'], options);
    return execFileSync('git', ['write-tree', '--prefix=wasm/'], options).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** wasm Release 的 tag：`ffmpeg-wasm-<libav.js 版本>-<wasm/ 的 tree hash 前 8 碼>`。 */
export function wasmReleaseTag(root: string): string {
  const versions = parseVersions(readFileSync(join(root, 'wasm', 'versions.env'), 'utf8'));
  const version = versions.LIBAVJS_VERSION;
  if (!version) throw new Error('wasm/versions.env 沒有 LIBAVJS_VERSION。');
  return `ffmpeg-wasm-${version}-${wasmTreeHash(root).slice(0, 8)}`;
}

/** GitHub repo 的網址，取自 package.json 的 `repository.url`。 */
export function githubRepoUrl(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    repository: { url: string };
  };
  return pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
}

/** Release 頁面的網址，寫進 NOTICE 作為原始碼的提供處。 */
export function wasmReleaseUrl(root: string, tag: string): string {
  return `${githubRepoUrl(root)}/releases/tag/${tag}`;
}

/** Release 檔案的下載網址。 */
export function wasmAssetUrl(root: string, tag: string, file: string): string {
  return `${githubRepoUrl(root)}/releases/download/${tag}/${encodeURIComponent(file)}`;
}

/**
 * 檢查 wasm/dist/ 是否符合目前的 `wasm/`；符合時回傳 undefined，否則回傳提示要執行哪個指令的訊息。
 * 只比對 stamp，不重新驗證檔案內容（內容在 wasm:fetch 與 wasm:build 時已驗證）。
 */
export function checkWasmDist(root: string): string | undefined {
  let stamp: string;
  try {
    stamp = readFileSync(join(wasmDistDir(root), STAMP), 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '找不到 wasm（wasm/dist/），請先執行 pnpm wasm:fetch。';
  }
  const tag = wasmReleaseTag(root);
  if (stamp === tag) return undefined;
  return (
    `wasm/dist/ 是 ${stamp}，與目前的 wasm/ 不符（${tag}）。` +
    '請執行 pnpm wasm:fetch；修改了 wasm/ 時改用 pnpm wasm:build。'
  );
}

/**
 * 以 `from` 目錄內的檔案（除了 sources.tar）取代 wasm/dist/，最後才寫入 stamp。
 * 呼叫前檔案必須已經驗證過（LGPL 檢查或 sha256）。
 */
export function installWasmDist(root: string, from: string, tag: string): void {
  const dist = wasmDistDir(root);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const file of readdirSync(from)) {
    if (file !== SOURCES_ASSET) copyFileSync(join(from, file), join(dist, file));
  }
  writeFileSync(join(dist, STAMP), `${tag}\n`);
}

/** 讀取 `sha256sum` 輸出的 SHA256SUMS；檔名不得含路徑。 */
export function parseSha256Sums(text: string): { file: string; sha256: string }[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [, sha256, file] = /^([0-9a-f]{64}) [ *]([^/\\]+)$/.exec(line) ?? [];
      if (sha256 === undefined || file === undefined || file === '.' || file === '..') {
        throw new Error(`SHA256SUMS 有無法解析的行：${line}`);
      }
      return { file, sha256 };
    });
}

/**
 * LGPL 檢查：讀 FFmpeg configure 產生的 config.h，啟用了 GPL、nonfree 或 version3 元件，
 * 或授權不是 LGPL-2.1-or-later 時回傳問題清單（硬性約束第 9 條）。找不到 define 也算問題。
 */
export function checkLgpl(configH: string): string[] {
  const define = (name: string) => new RegExp(`^#define ${name} (.*)$`, 'm').exec(configH)?.[1];
  const problems: string[] = [];
  for (const name of ['CONFIG_GPL', 'CONFIG_NONFREE', 'CONFIG_VERSION3']) {
    const value = define(name);
    if (value !== '0') problems.push(`${name} 為 ${value ?? '未定義'}`);
  }
  const license = define('FFMPEG_LICENSE');
  if (license !== '"LGPL version 2.1 or later"') {
    problems.push(`FFMPEG_LICENSE 為 ${license ?? '未定義'}，不是 "LGPL version 2.1 or later"`);
  }
  return problems;
}
