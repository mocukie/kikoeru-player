# wasm

Engine 使用的 FFmpeg wasm：libav.js 的自訂 variant，Asyncify 單一 build。決定與理由見 [ADR-0001](../docs/adr/0001-libavjs-asyncify.md)、[ADR-0003](../docs/adr/0003-decode-paths.md)、[ADR-0005](../docs/adr/0005-wasm-release-and-engine-package.md)。

本目錄的內容決定 wasm Release 的 tag：`ffmpeg-wasm-<libav.js 版本>-<wasm/ 的 git tree hash 前 8 碼>`。改動任何檔案都會產生新的 tag，CI 的 `ensure-wasm` 會 build，`publish-wasm` 發布新的 Release。

| 檔案 | 內容 |
|---|---|
| `versions.env` | libav.js 的 tag 與 commit、上游 tarball 的版本與 sha256、variant 名稱 |
| `fragments.txt` | variant 的 libav.js configuration fragment |
| `fragments/` | 本 repo 的 fragment（`kikoeru-memory`：wasm 記憶體上限 512 MiB） |
| `patches/` | 對 libav.js 0BSD wrapper 的 patch（不改 FFmpeg） |
| `Dockerfile` | build 環境，emsdk image 釘 digest |
| `build.sh` | 下載並核對上游 tarball、clone libav.js 並核對 commit、套 patch、在 Docker 內 build、smoke test、組出 Release 的內容 |
| `smoke.mjs` | 在 Node 載入產物，demux 並解碼 build 時以 FFmpeg image 產生的短音訊，確認 patch 加入的函式可用 |

## 指令

- `pnpm wasm:fetch`：下載與目前 `wasm/` 相符的 Release 到 `wasm/dist/`，以 `SHA256SUMS` 驗證。
- `pnpm wasm:build`：修改 `wasm/` 後在 Docker 內 build，做 LGPL 檢查（`config.h` 不得啟用 GPL、nonfree、version3 元件），通過後放進 `wasm/dist/`。

`wasm/dist/` 與工作目錄 `wasm/.work/` 都不進 git。不要手改 `wasm/dist/`，也不要手改 libav.js 的產物；對 libav.js 的修改一律加在 `patches/`。

## Release 的內容

| 檔案 | 內容 |
|---|---|
| `libav-<版本>-kikoeru.wasm.wasm`、`.wasm.mjs` | wasm 與 glue；glue 開頭的 license header 列出編進 wasm 的全部授權 |
| `libav-<版本>-kikoeru.mjs`、`libav.types.d.ts` | libav.js 的 frontend（0BSD）與型別 |
| `NOTICE`、`LGPL-2.1.txt` | FFmpeg 的 LGPL 聲明與全文 |
| `sources.tar` | LGPL-2.1 §6 的對應原始碼：FFmpeg、libav.js、emfiberthreads 的上游 tarball，本目錄的全部檔案，以及 FFmpeg 的 configure 參數 |
| `SHA256SUMS` | 以上全部檔案的 sha256 |

`wasm/dist/` 是 Release 中 `sources.tar` 以外的檔案。

## 從 `sources.tar` 重新 build

解開後執行 `sources/wasm/build.sh <tag> <URL>`（兩者只寫進 `NOTICE`）；需要 Docker 與網路（clone libav.js、`npm ci`）。上游 tarball 可先放進 `wasm/.work/downloads/`。同一份 `wasm/` 的產物 bit-for-bit 相同。
