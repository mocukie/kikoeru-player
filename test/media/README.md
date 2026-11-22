# 測試媒體

`gen-media.sh` 在釘 digest 的 FFmpeg image 內產生測試媒體，輸出到 gitignored 的 `out/`；`gen-subs.py` 產生內嵌字幕軌的來源。規範見[測試規範「測試媒體」](../../docs/testing.md#測試媒體)。

| 指令 | 內容 |
|---|---|
| `pnpm media:gen` | CI 組：`out/audio/`、`out/video/`、`out/broken/`，產生完寫入 `out/.stamp` |
| `pnpm media:gen:manual` | 手動組：`out/manual/`，只在實機或記憶體測試時產生 |

需要 Docker 與 python3。`out/.stamp` 是兩個 script 的 sha256；`pnpm test:browser` 與 `pnpm e2e` 開始前以它檢查媒體是否存在、是否與 script 相符，CI 也以同樣的 hash 快取 `out/`。

**測試只依賴下面列出的特徵**（時長、beep 與白框的位置、軌道組成），不依賴 byte 一致：FFmpeg image 相同時輸出大致相同，但 encoder 不保證逐 byte 一致。

## 共同特徵

- **beep**：每整秒（0 s、1 s、2 s…）開始的 0.1 秒是振幅 0.5 的正弦波，其餘為完全靜音。每 10 秒的那一聲（0 s、10 s…）頻率加倍，用來分辨位置。beep 從相位 0 開始，起點是 sample index 為取樣率整數倍的那個 sample。有損 codec 有 encoder delay，容器有沒有記錄、能不能補償依格式而定（例如 ADTS、raw AC-3／E-AC-3 沒有記錄）；需要精確到 sample 的測試用 PCM 或 FLAC，其他格式要先確認。
- **基準頻率**：beep 平時的頻率，加倍的那一聲是它的兩倍。未特別註明時為 880 Hz，兩個聲道相同。
- **白框**：影片為 30 fps 的 `testsrc`，左上 64×64 平時是黑色，每整秒開始的 3 個 frame（frame index 是 30 的倍數起算，即 0.1 秒）變白，與 beep 同時出現。
- **keyframe**：影片每 30 個 frame（1 秒）一個 keyframe。
- 音訊未特別註明時為 48 kHz stereo。

## CI 組

### `out/audio/`：音訊，10 秒

| 檔案 | codec | 容器 | 備註 |
|---|---|---|---|
| `mp3.mp3` | MP3 192 kbps | MP3 | |
| `aac.m4a` | AAC-LC 192 kbps | MP4（faststart） | |
| `aac-adts.aac` | AAC-LC 192 kbps | ADTS | 沒有索引，時長只能估計 |
| `alac.m4a` | ALAC | MP4 | |
| `opus.opus` | Opus 128 kbps | Ogg | |
| `vorbis.ogg` | Vorbis q4 | Ogg | |
| `flac.flac` | FLAC | FLAC | |
| `wavpack.wv` | WavPack | WavPack | |
| `pcm-s16.wav`、`pcm-s24.wav`、`pcm-s32.wav` | PCM signed 16／24／32-bit LE | WAV | |
| `pcm-f32.wav`、`pcm-f64.wav` | PCM float 32／64-bit LE | WAV | |
| `pcm-u8.wav` | PCM unsigned 8-bit | WAV | |
| `pcm-s16be.aiff` | PCM signed 16-bit BE | AIFF | |
| `ac3.ac3` | AC-3 192 kbps | raw | |
| `eac3.eac3` | E-AC-3 192 kbps | raw | |
| `flac-44100.flac`、`flac-96000.flac`、`flac-192000.flac` | FLAC | FLAC | 取樣率 44.1k／96k／192k |
| `flac-5.1.flac` | FLAC | FLAC | 5.1，基準頻率依聲道：FL 440、FR 550、FC 660、LFE 110、BL 770、BR 880 Hz |

### `out/video/`：影片，320×180

| 檔案 | 時長 | 影片 | 音訊 | 備註 |
|---|---|---|---|---|
| `h264-aac.mp4` | 10 s | H.264 | AAC | MP4（faststart） |
| `vp9-opus.webm` | 10 s | VP9 | Opus | |
| `av1-opus.webm` | 10 s | AV1 | Opus | |
| `hevc-aac.mp4` | 10 s | HEVC（`hvc1`） | AAC | 瀏覽器只測不支援的路徑 |
| `h264-mp3.avi` | 10 s | H.264（無 B-frame） | MP3 | AVI |
| `rotated-90.mp4` | 10 s | H.264 | AAC | 與 `h264-aac.mp4` 相同，只加上 display matrix：逆時針旋轉 90°，顯示為 180×320 |
| `sar-2-1.mkv` | 2 s | H.264，SAR 2:1 | AAC | Matroska 的 DisplayWidth 與 H.264 的 VUI 都記錄 SAR 2:1，顯示為 640×180 |
| `bad-interleave.mp4` | 10 s | H.264 2 Mbps CBR | AAC | 交錯不良：fragmented MP4，每 5 秒一個 fragment，fragment 內影片的 sample 在前、音訊在後；0 秒的音訊在約 1.2 MB 處 |
| `multi-track.mkv` | 20 s | H.264 | 2 軌，見下表 | 另有 2 條內嵌字幕軌 |
| `subtitle-formats.mkv` | 2 s | H.264 | AAC | 字幕 1：WebVTT，0 s 與 1 s 各一個 0.5 秒的 cue，文字為 `[embedded webvtt] <秒數>`；字幕 2：PGS（圖形字幕），同樣的時間顯示一個小方塊 |
| `mov-text.mp4` | 2 s | H.264 | AAC | 字幕：mov_text，0 s 與 1 s 各一個 0.5 秒的 cue，文字為 `[embedded mov_text] <秒數>`；cue 之間有清空畫面的空 sample |
| `video-only.mp4` | 3 s | H.264 | — | 沒有音軌（MP4，faststart） |
| `external-audio-440.flac` | 20 s | — | FLAC，基準頻率 440 Hz | 外掛音軌，與 `multi-track.mkv` 同長 |

`multi-track.mkv` 的軌道（依容器內順序）：

| 軌道 | codec | language | title | 內容 |
|---|---|---|---|---|
| 影片 | H.264 | | | 白框 |
| 音訊 1 | AAC | `jpn` | `beep 880 Hz` | 基準頻率 880 Hz |
| 音訊 2 | Opus | `chi` | `beep 440 Hz` | 基準頻率 440 Hz |
| 字幕 1 | SRT | `jpn` | | 每整秒一個 0.5 秒的 cue，第 n 秒的文字為 `[embedded srt] n秒目、ビープ音が鳴りました。` |
| 字幕 2 | ASS | `chi` | | 同上，Text 為 `{\fad(50,50)}[embedded ass] 第n秒，聽到嗶聲了。`（Layer 0、Style `Default`）；header 是 `gen-subs.py` 寫出的完整 V4+ header |

cue 與 beep 同時開始：第 n 個 cue 是 n 秒到 n + 0.5 秒（n 從 0 起算）。

### `out/broken/`：壞檔

| 檔案 | 來源 | 壞法 |
|---|---|---|
| `truncated.mp3` | `audio/mp3.mp3` | 只留前一半的 bytes（約 5 秒） |
| `truncated.mp4` | `video/h264-aac.mp4` | 只留前一半的 bytes；moov 在前面，完整，但後半的 sample 讀不到 |
| `bad-packets.mp3` | `audio/mp3.mp3` | 4–6 秒的封包約每 16 個 byte 改壞一個（FFmpeg `noise` bsf） |
| `bad-packets.mkv` | `video/h264-aac.mp4` 轉成 MKV | 同上，改壞的是 4–6 秒的影片封包；音訊完好 |
| `fake-ext-flac.mp3` | `audio/flac.flac` | 內容是 FLAC，副檔名是 `.mp3` |
| `fake-ext-webm.mp4` | `video/vp9-opus.webm` | 內容是 WebM，副檔名是 `.mp4` |

## 手動組：`out/manual/`

| 檔案 | 時長 | 內容 | 大小 |
|---|---|---|---|
| `long-45min.mp3` | 45 min | MP3 128 kbps | 約 43 MB |
| `long-40min-s24.wav` | 40 min | PCM s24 | 約 660 MB |
| `long-30min-720p.mkv` | 30 min | H.264 1280×720 CBR 6.5 Mbps（filler 撐出大小）、AAC | 約 1.5 GB |
