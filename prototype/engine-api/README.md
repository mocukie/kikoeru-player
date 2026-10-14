# PROTOTYPE：Engine 公開 API（用完即丟）

[engine-v1] Prototype: Engine 公開 API（#2）的草稿。定案後只把結論帶進 spec，這個資料夾留在 `prototype/2-engine-api` branch。

- `engine.d.ts`：App 看得到的全部型別。
- `usage.ts`：App 端的使用範例（開檔、播放、seek、切軌、外掛音軌與 offset、內嵌字幕 cue、session 失效、診斷、destroy、測試）。
- 型別檢查：`npx -y -p typescript@5.9.3 tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --lib es2022,dom,dom.iterable engine.d.ts usage.ts`

## 狀態轉移

`paused`（使用者意圖）與 `state`（實際狀況）分開；loading／seeking／buffering 結束時依 `paused` 決定回到 playing 或 paused／ready。

| 從 | 觸發 | 到 |
| --- | --- | --- |
| 任何（destroy 前） | `load()` | loading |
| ready 以後、error | `reload()` | loading → 依保留的 `paused` 回 ready／paused／playing |
| loading | probe 完成、起點的資料備妥 | ready（`paused`）／playing |
| loading | 失敗 | error |
| ready、paused | `play()` | playing（資料不夠時 buffering） |
| playing、buffering | `pause()` | paused |
| playing | 緩衝用完 | buffering |
| buffering | 資料補上 | playing |
| buffering | 超過 `stallTimeout` | 仍是 buffering，發 `stall`，恢復後 `stallrecovered` |
| ready、paused、playing、buffering、ended | `seek()`、改目前音軌的 offset | seeking → 依 `paused` 回 playing／paused |
| playing | 播到結尾 | ended |
| playing、buffering | 系統中斷（reason `interrupted`）或外部 suspend AudioContext（reason `external`） | paused（`paused` 變 true，不自動恢復） |
| paused | 外部 resume AudioContext（reason `external`） | playing |
| ended | `play()` | seeking(0) → playing |
| 任何載入中或已載入 | 致命錯誤 | error |
| 任何 | `unload()` | idle |
| 任何 | `destroy()` | （不再有狀態；之後指令 reject `DESTROYED`） |

`selectTracks()` 不改變 state（短暫補資料時不進 buffering，只延後新軌出聲）。

## 指令佇列

- 指令：`load`、`reload`、`play`、`pause`、`seek`、`selectTracks`、`addExternalAudio`、`removeExternalAudio`、`setAudioOffset`、`unload`、`destroy`。一律回傳 Promise，依呼叫順序執行。
- 取代規則：
  - `load()`／`reload()`／`unload()`／`destroy()` 取代所有尚未完成的指令。
  - `seek()` 取代尚未完成的 `seek()`（包括執行中的，讀取會被中止）。
  - `selectTracks()` 同一 kind 只保留最後一個。
  - `play()` 與 `pause()` 互相取代。
- 被取代的指令 reject `DOMException('AbortError')`；App 用 `isAbortError()` 忽略。
- `volume`、`muted`、`playbackRate` 是同步屬性，不進佇列。

## 同步 getter 的規則

- 主執行緒保留鏡像，Worker 在值改變時推送；持續變動、只存在於 Worker 的數字放 `getStats()`。
- 順序保證：指令 resolve 時 getter 已是新值、事件已發出。
- getter 顯示已生效的值（`paused` 例外，它是意圖）。
- tracks 在 load 後只因指令或降級（播放中影片解碼失敗、退回只播音訊）改變；播放中才出現的 stream 只記 log。

## 已定案

- Q1 來源：可序列化描述 `http`／`bytes`／`blob`，不提供 `custom`（之後可加新 kind）。
- Q2 保留 `ready`。
- Q3 `paused`（意圖）與 `state`（實際狀況）分開。
- Q4 `volume`、`muted`、`playbackRate` 為同步屬性；seek、切軌、offset 為 async 指令。
- Q5 `reload()`：同一份媒體重新開檔，保留位置、paused、選軌、外掛音軌、offset；track id 不變；stream 結構不同時 `SOURCE_CHANGED`。
- Q6 預設選軌：音軌依偏好語言 → default 旗標 → 第一條；字幕只在 forced 或命中偏好語言時開啟。偏好語言可在 `createEngine()` 設預設值、`load()` 覆蓋。
- Q7 `language` 正規化為 BCP 47，另附 `rawLanguage`。
- Q8 ~~先保留 `extractSubtitles()` 的形狀~~：已由「內嵌字幕整軌取出的歸屬」（#14）移除，Engine 不提供整軌取出，內嵌字幕只隨 demux 串流送出 cue。
- Q11 Engine 設定 `canvas.width/height` 為影片顯示尺寸，縮放交給 App 的 CSS。
- Q12 外掛音軌屬於當前媒體（`load()`／`unload()` 移除、`reload()` 保留），加入後不自動選用，載入失敗為非致命錯誤。
- Q13 重試可設定：5xx／網路錯誤預設指數退避 3 次（base 500ms）；401／403／404 不重試；卡住 8 秒後中止讀取並重新 seek，最多 2 次。
- Q14 loading 期間的 `seek()` 改寫該次 load 的起點，與 load 一起 resolve。
- Q9 行動裝置不放 core；A（Engine 選項）／B（hook）／C（選配模組，傾向）留給「行動裝置支援的歸屬」。core 必須提供：`statechange` 帶 `reason`；偵測外部對 AudioContext 的 suspend／resume 並反映到 `paused`；建立或 resume AudioContext 前同步發出 `beforeaudiostart`。
- Q10 `Engine extends EventTarget`，每種事件一個帶型別欄位的 Event 子類別，`addEventListener` 有型別 overload，支援 `{ once, signal }`。

## 之後的 ticket 帶來的修改

- 「音訊解碼路線」（#12，ADR-0003）：
  - 只要還有一條可播的音軌或影片軌，`load()` 就成功，不支援的影片軌只播音訊；完全沒有可播的軌才 `CODEC_UNSUPPORTED`。預設選軌只從 `supported` 的軌中選。
  - `unsupportedReason`：`'codec'` 是 Engine 不支援，`'platform'` 是這個瀏覽器不支援。
  - `isEngineSupported()` 不要求 WebCodecs。
  - 播放中影片解碼失敗時退回只播音訊，發出 `fatal: false` 的 `error` 事件與 `trackschange`；音訊連續失敗超過 1 媒體秒才是致命的 `DECODE_FAILED`。
