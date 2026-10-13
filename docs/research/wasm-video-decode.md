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
