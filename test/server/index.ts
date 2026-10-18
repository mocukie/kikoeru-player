// Vite middleware，供 Demo 頁（vite.config.ts）與 browser mode（vitest.config.ts）共用（docs/testing.md「HTTP 來源與故障注入」）。
//
// - `/media/*`：`test/media/out/` 的檔案，支援 Range（由 `send` 處理 206、416、HEAD 與 ETag）。
// - `/media/index.json`：`test/media/out/` 之下 CI 組媒體的相對路徑清單，Demo 頁以它列出可選的媒體。
// - `/src/wasm/*`：`wasm/dist/` 的檔案原樣提供（`.wasm` 為 `application/wasm`）。套件把 wasm 複製到 `dist/wasm/`，
//   `src/main/wasm.ts` 以 `../wasm/` 參照；這個對應讓 dev 與測試用同一個寫法找到 wasm 與 glue。
//
// 故障注入（`?fault=…`）由 HTTP 錯誤分類的 issue 加入。

import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import send from 'send';
import type { Connect, Plugin } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const mediaRoot = join(repoRoot, 'test/media/out');
const wasmRoot = join(repoRoot, 'wasm/dist');

/** CI 組的目錄；手動組（`manual/`）只在實機或記憶體測試時產生，不列入清單。 */
const CI_MEDIA_DIRS = ['audio', 'video', 'broken'];

export function testServer(): Plugin {
  return {
    name: 'kikoeru-test-server',
    configureServer(server) {
      // 直接 use：排在 Vite 自己的 middleware 之前，檔案不經過 Vite 的轉換。
      server.middlewares.use('/media/index.json', mediaIndex);
      server.middlewares.use('/media', serveDirectory(mediaRoot));
      server.middlewares.use('/src/wasm', serveDirectory(wasmRoot));
    },
  };
}

/** `root` 之下的靜態檔案；找不到時回應對應的狀態碼（404 等），不交給下一個 middleware。 */
function serveDirectory(root: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    send(req, pathname, { root, index: false, dotfiles: 'deny' })
      .on('error', (error: { status?: number }) => {
        res.statusCode = error.status ?? 500;
        res.end();
      })
      .pipe(res);
  };
}

const mediaIndex: Connect.NextHandleFunction = (_req, res) => {
  listMedia().then(
    (paths) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(paths));
    },
    (error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    },
  );
};

async function listMedia(): Promise<string[]> {
  const paths: string[] = [];
  for (const dir of CI_MEDIA_DIRS) {
    const entries = await readdir(join(mediaRoot, dir), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      paths.push(relative(mediaRoot, join(entry.parentPath, entry.name)).split(sep).join('/'));
    }
  }
  return paths.sort();
}
