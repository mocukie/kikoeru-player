# wasm 軟體解碼（dav1d）的效能與打包

> Research ticket：[#20](https://github.com/mocukie/kikoeru-player/issues/20)（map：[#1](https://github.com/mocukie/kikoeru-player/issues/1)），為決策 ticket [#21](https://github.com/mocukie/kikoeru-player/issues/21) 準備資料。
> 實測日期：2026-10-13。對象：libav.js master `c05a676`（= `v6.10.9.0` 加上 dav1d 的兩個 commit）內建的 dav1d 1.5.4，經 FFmpeg 9.0 的 `libdav1d` wrapper 呼叫。
> 標記：**[實測]** 本次在瀏覽器或本機量到；**[原始碼]** 對照 libav.js／dav1d／FFmpeg／WebKit 原始碼；**[已查證]** 對照其他一手來源；**[推論]** 由實測與來源推得；**[未測]** 本次無法測。
> 原始數據在 branch 的 `research/wasm-video-decode-spike/data/`，表格可用 `node summarize.mjs data` 重新產生。

## 0. 環境與方法

- **機器**：AMD EPYC 7K62（Zen 2，VM 32 vCPU，Linux）。所有瀏覽器數字都在官方 Docker image `mcr.microsoft.com/playwright:v1.63.0-noble` 內量：Chromium 153.0.8010.12、WebKit 26.6（WPE，Linux）、Firefox 155.0；**headless、沒有 GPU**。
  - **Linux 上的 Playwright WebKit 不等於 Safari**：JavaScriptCore 的 wasm 編譯器相同，但 VideoFrame 的後端是 GStreamer，Apple 平台走 CoreVideo（§6）；CPU 也是 x86。
  - 單執行緒的數字代表「一顆 Zen 2 伺服器核心」，不是手機。手機的推算見 §8，實機項目見 §10。
- **build**：在釘 digest 的 `emscripten/emsdk:6.0.5` 內，以 libav.js commit `c05a676`、FFmpeg 9.0、dav1d 1.5.4 build（`build.sh`）。套上 #10／#17／#18 的三個 0BSD wrapper patch，與正式 variant 一致。
  - `kikoeru-af`：ADR-0003 的主 variant（#10 的清單加 avi、aiff、ac3、eac3）。
  - `kikoeru-afv`：`kikoeru-af` 加 `decoder-libdav1d`（選項 A：dav1d 放進主 variant）。
  - `kikoeru-dav1d`：只有 `avcodec` 加 `decoder-libdav1d`（選項 B：需要時才載入的獨立 wasm）。
  - 編譯選項（flavor）：`oz`＝libav.js 預設的 `OPTFLAGS=-Oz`；`o3`＝`-O3`；`o3s`＝`-O3 -msimd128`（全部，含 FFmpeg 與 link）；`mix`＝FFmpeg 與 link 維持 `-Oz`，只有 dav1d 用 `-O3 -msimd128`（改 `mk/libdav1d.mk` 的 `c_args`）。
  - 每個組合另外 link 一份**不開 Asyncify**（`noasy`）的版本，以及 `thr`（`-pthread`）版本。
- **量法**（`t-decode.mjs`）：比照 Engine，在 module Worker 內以 `noworker`（direct 模式）載入 libav.js。先用 `kikoeru-af` 把整個 MP4 demux 成封包（不計時），再交給指定的 dav1d wasm，用 `_sync` 函式逐封包 `avcodec_send_packet`／`avcodec_receive_frame` 並計時。
  - **decode-only fps**：frame 數 ÷ 解碼呼叫的總時間（不含取出與 VideoFrame）。
  - **即時倍數**：decode-only fps ÷ 內容 fps。
  - **預先解碼量（preroll）**：使「第 k 個 frame 解完的時間 ≤ D ＋ k／fps」對所有 k 成立的最小 D。平均跟得上、但個別封包很慢時，D 就是播放前要先解好的量；平均跟不上時，D 會隨片長一直增加。
  - 多執行緒（`thr`）的 dav1d 是非同步輸出，改用 wall-clock fps。
  - 完整路徑（`m-pipeline.mjs`）：Worker 解碼 → 從 wasm heap 取出成緊密的 I420（10-bit 在 JS 右移 2 位轉 8-bit）→ `new VideoFrame` → transfer 給主執行緒 → `drawImage` 到 1280×720 的 2D canvas。不限速，在途 frame ≤ 4，每 10 張做一次 1px `getImageData`，沿用 #17 的量法。
  - 原生對照（`native-bench.sh`）：同一台機器、同一批檔案，dav1d 1.5.4 CLI，`asm`（AVX2 等手寫組語）與 `--cpumask 0`（只用 C）。
- **媒體**（`gen-media.sh`，不進 git）：Blender 開放影片 Big Buck Bunny 1080p30（動畫）與 Tears of Steel（實拍加 CG，2.4:1，24 fps）各取 20 秒，用 FFmpeg 7.1（Lavc 61.19）的 libaom-av1 編碼：`-usage good -cpu-used 6 -row-mt 1`、GOP 4 秒、1-pass 目標 bitrate、MP4。實際 bitrate 與目標相符（例如 `bbb-1080-8-2M` 是 2.09 Mbps，`tos-800-8-3M` 是 3.0 Mbps）。

| 檔名 | 內容 | 解析度 | fps | bit depth | bitrate |
|---|---|---|---|---|---|
| `bbb-1080-{8,10}-{2M,6M}` | BBB 動畫 | 1920×1080 | 30 | 8／10 | 2／6 Mbps |
| `bbb-720-{8,10}-{1M,3M}` | BBB 動畫 | 1280×720 | 30 | 8／10 | 1／3 Mbps |
| `tos-800-{8,10}-3M` | ToS 實拍 | 1920×800 | 24 | 8／10 | 3 Mbps |
| `tos-534-8-1.5M` | ToS 實拍 | 1280×534 | 24 | 8 | 1.5 Mbps |
| `bbb-1080-8-2M-tiles` | 同上，2×2 tiles | 1920×1080 | 30 | 8 | 2 Mbps |
| `tos-800-8-3M-grain` | 同上，film grain synthesis（`-denoise-noise-level 10`） | 1920×800 | 24 | 8 | 3 Mbps |

- 每個量測只跑一次（每次 480–600 個 frame）。三個瀏覽器的同組數字差距多在 ±10% 內，可以當作重複性的參考。

## 1. libav.js 的 dav1d（「2026-08 加入的 dav1d variant」）

**存在，但只在 master，沒有任何 release 含它** [已查證]。

- PR [#108「Add dav1d AV1 decoder variant」](https://github.com/Yahweasel/libav.js/pull/108)（外部貢獻者，2026-08-20 開，**2026-08-30 merge**），兩個 commit：`f8f1e84`（新增）、`430ae83`（整理：改名為 `decoder-dav1d`、對齊其他 library 的 build 規則）。之後 `c05a676`（2026-08-31）在 CI 加了 `apt install meson`，該 commit 的 CI「Build and test」通過。
- 最新的 tag 是 `v6.10.9.0`（2026-08-18，早於 PR），npm 的 `libav.js` 最新版也是 6.10.9，`@libav.js/variant-decoder-dav1d` 不存在（npm 404）。所以「可以直接用」的意思只能是：**釘 master 的 commit 自己 build**。我們本來就自己 build（ADR-0001），差別只在釘 commit 而不是 tag。`v6.10.9.0..c05a676` 只有 dav1d 與 CI 的改動，產物版本字串仍是 `6.10.9.0`。
- 維護者在 PR 裡表示 dav1d「應該是預設的 AV1 decoder，而不是 AOM」。README 對既有的 `av1-opus`（libaom）variant 仍寫著「AV1 在 WebAssembly 即使開 threads 也慢到實際上無法使用」，這句話指的是 libaom。

**內容** [原始碼，`c05a676`]：

| 項目 | 內容 |
|---|---|
| 預建 config | `configs/configs/decoder-dav1d`：`["avcodec","parser-av1","decoder-libdav1d"]`，`noAll`（不進 release 的 variant 清單） |
| fragment | `configs/fragments/decoder-libdav1d`：`--enable-libdav1d --enable-decoder=libdav1d`，**另外固定開 `av1_metadata` 與 `extract_extradata` 兩個 bsf**；`license.js` 帶 dav1d 的 BSD-2 條文 |
| dav1d 版本 | `mk/libdav1d.mk`：`DAV1D_VERSION=1.5.4`，從 code.videolan.org 下載 tarball（**不驗證 hash**，跟其他依賴一樣，要自己先放好並核對 sha256） |
| dav1d 的 build | meson（`mk/emscripten.meson.cross`），`--buildtype=release -Dc_args="$(OPTFLAGS) …" -Denable_asm=false`，tools／tests 關閉；`base` 與 `thr` 兩個 target 各 build 一次 |
| patch | `patches/dav1d.diff`：emscripten 時不加 `threads` 依賴、不對 wasm 強加 atomics flag（避免非 threaded build 帶進 pthread flag） |

- **對我們的意義**：可以直接把 `"decoder-libdav1d"` 加進自訂 variant 的 fragment 清單（本次的 `kikoeru-afv`、`kikoeru-dav1d` 就是這樣 build），不需要 fork 或另寫 build 規則。#10 的 build 環境只要多裝 `meson`、`ninja-build`。
- **兩個要自己處理的地方**：
  1. dav1d 的編譯選項跟著全域的 `OPTFLAGS`（預設 `-Oz`），而且 `-Denable_asm=false`。速度差很多（§3），要用 `-O3 -msimd128` 就得改 `mk/libdav1d.mk` 一行（或整個 variant 改 `OPTFLAGS`）。這屬於 build 設定，不必改 libav.js 的程式。
  2. libav.js 的 `base` target 一律連結 emfiberthreads（用 fiber 模擬 pthread），dav1d 在非 threaded build 也能呼叫 `pthread_create`。FFmpeg 的 `libdav1d` wrapper 以 `AVCodecContext.thread_count`（預設 1）決定 `n_threads`，所以預設就是單執行緒；**不可以把 `threads` 設成 0（auto）或大於 1**，否則在 fiber 上跑多個「執行緒」只會更慢 [原始碼：`libavcodec/libdav1d.c` L206–229；libav.js `docs/API.md` 對 emfiberthreads 的說明]。
- **dav1d 沒有 wasm 的手寫 SIMD**：dav1d 1.5.4 與 master 的 `src/` 只有 `arm`、`x86`、`ppc`、`loongarch`、`riscv` 的組語，沒有 wasm；VideoLAN GitLab 上與 wasm 有關的 MR 只有 CI 與 build 修正（!1239、!1491、!1492），2019 年的 emscripten 最佳化 MR !606 已關閉 [已查證]。所以 wasm 的 SIMD 只能靠編譯器 auto-vectorization（`-msimd128`）。ogv.js 的 dav1d build 正是用 `-O3 -msimd128`、`-Denable_asm=false`，另外只開 8-bit（`-Dbitdepths=['8']`）[已查證：ogv.js `buildscripts/compileDav1dWasm.sh`、`dav1d-wasm-cross.txt`]。本次確認 `o3s` 的 wasm 裡有約 1.29 萬個 SIMD 指令，`oz`／`o3` 是 0 [實測：`wasm-dis` 計數]。
