# #20 進度清單（wasm 軟體解碼的效能與打包）

環境：AMD EPYC 7K62（32 vCPU）、Playwright 1.63.0 Docker（Chromium 153、WebKit 26.6 WPE、Firefox 155），headless、無 GPU。
原始資料都在 `data/`（`summary.md` 是 `node summarize.mjs data` 的輸出）。媒體與 wasm 不進 git。

- [x] 確認 libav.js 的 dav1d：只在 master（PR #108，2026-08-30 merge，commit f8f1e84／430ae83），沒有 tag 或 npm release；dav1d 1.5.4、`-Denable_asm=false`、跟著 OPTFLAGS（預設 -Oz）。釘 `c05a676` build。
- [x] build oz（kikoeru-af／kikoeru-afv／kikoeru-dav1d，wasm＋thr，Asyncify 與 noasy）→ `data/build-oz.log`、`data/sizes.md`
- [x] build o3、o3s（-O3 -msimd128）→ `data/build-o3-o3s.log`；o3s 的 wasm 內有約 1.29 萬個 SIMD 指令，oz／o3 為 0
- [x] build mix（FFmpeg 與 link -Oz，只有 dav1d -O3 -msimd128）→ `data/build-mix.log`
- [x] 產生媒體（BBB／ToS，libaom，20 秒，1080p／720p × 8／10-bit × 兩種 bitrate，加 tiles、grain、tiny）→ `data/gen-media.log`
- [x] 體積 → `data/sizes.md`：主 variant 加 dav1d +164 KiB brotli（oz）／+201 KiB（mix）；獨立 dav1d wasm（noasy、mix）約 368 KiB brotli（wasm＋glue＋frontend）
- [x] 單執行緒矩陣（13 檔 × 3 瀏覽器，oz 與 o3s-noasy）→ `data/single.json`：Engine 條件（oz）1080p BBB 只有 0.62–0.82× 即時；o3s-noasy 1.1–1.5×；720p 2.2–3.3×；ToS 1920×800 最佳也只有 0.86–0.99×
- [x] 編譯選項 × Asyncify → `data/flavors.json`：Asyncify 只慢 2–8%，-O3 +5–10%，-msimd128 再 +55–65%
- [x] mix（主 variant 內的 dav1d）→ `data/mix.json`：afv-mix（Asyncify）約為 o3s-noasy 的 96–97%
- [x] 完整路徑（解碼 → I420 → VideoFrame → transfer → drawImage）→ `data/pipeline.json`：1080p 10-bit 的 JS 10→8 轉換 7–11 ms／frame，把 o3s 從 37 fps 拉到 25–28 fps
- [x] VideoFrame 建立成本與 10-bit 支援 → `data/vfcost.json`：I420 ≤ 1–2 ms；I420P10 在 WebKit（TypeError，pref 預設關）與 Firefox（NotSupportedError）都不能從 buffer 建
- [x] skip_frame=noref／關閉 grain → `data/skip.json`：libaom 的檔案只有 2–3% 是 non-reference，幾乎省不到；關 grain 合成 +24%
- [x] 多執行緒（o3s-noasy thr，1–8 threads）→ `data/threads.json`（第一輪 `threads-run1.json` 有 memory grow 的 RangeError，修正後重跑）：2 threads 約 1.6×、4 threads 約 2.1×（tiles 3.1×）
- [x] 發現：thr build 在 direct 模式下，pthread 讓 shared memory grow 後 JS 的 HEAPU8 不會更新 → RangeError；量測時把初始 memory 開到 512 MiB 繞過
- [x] 原生 dav1d 對照（修正 fps 解析後重跑；asm 與 `--cpumask 0`，1／2／4 threads）→ `data/native.tsv`：1080p BBB 單執行緒 native asm 200 fps、native C 62 fps，wasm o3s 43 fps
- [ ] threaded build 對 CI 的影響：用 JOBS=2 量乾淨 build 時間（kikoeru-af、kikoeru-afv、kikoeru-dav1d wasm、＋thr）
- [ ] 外部資料整理：iOS／iPad dav1d 數據（dav1d 0.2.0：iPhone XS 1080p 80fps，native）、Safari wasm SIMD 16.4／threads 15.2／COEP credentialless 不支援（BCD）、WebKit VideoFrame 格式（原始碼）、WebCodecs AV1 在 Cocoa 預設關
- [ ] 授權／NOTICE：dav1d BSD-2，glue 的 license header 已自動帶入 dav1d 條文（已確認）；寫進報告
- [ ] 報告 `docs/research/wasm-video-decode.md`：逐節寫並 commit
- [ ] resolution 文字、一行 gist、branch／SHA

下一步：量 threaded build 對 CI 的影響（JOBS=2 乾淨 build 時間，四個組合分開量），存成 `data/build-times.tsv`。
