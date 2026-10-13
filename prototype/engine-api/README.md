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
| loading | probe 完成、起點的資料備妥 | ready（`paused`）／playing |
| loading | 失敗 | error |
| ready、paused | `play()` | playing（資料不夠時 buffering） |
| playing、buffering | `pause()` | paused |
| playing | 緩衝用完 | buffering |
| buffering | 資料補上 | playing |
| buffering | 超過 `stallTimeout` | 仍是 buffering，發 `stall`，恢復後 `stallrecovered` |
| ready、paused、playing、buffering、ended | `seek()`、改目前音軌的 offset | seeking → 依 `paused` 回 playing／paused |
| playing | 播到結尾 | ended |
| ended | `play()` | seeking(0) → playing |
| 任何載入中或已載入 | 致命錯誤 | error |
| 任何 | `unload()` | idle |
| 任何 | `destroy()` | （不再有狀態；之後指令 reject `DESTROYED`） |

`selectTracks()` 不改變 state（短暫補資料時不進 buffering，只延後新軌出聲）。

## 指令佇列

- 指令：`load`、`play`、`pause`、`seek`、`selectTracks`、`addExternalAudio`、`removeExternalAudio`、`setAudioOffset`、`unload`、`destroy`。一律回傳 Promise，依呼叫順序執行。
- 取代規則：
  - `load()`／`unload()`／`destroy()` 取代所有尚未完成的指令。
  - `seek()` 取代尚未完成的 `seek()`（包括執行中的，讀取會被中止）。
  - `selectTracks()` 同一 kind 只保留最後一個。
  - `play()` 與 `pause()` 互相取代。
- 被取代的指令 reject `DOMException('AbortError')`；App 用 `isAbortError()` 忽略。
- `volume`、`muted`、`playbackRate` 是同步屬性，不進佇列。

## 待定案的問題

我的建議寫在每題後面，等你改或推翻。

1. **Q1 來源的形狀**：可序列化的描述（`http`／`bytes`／`blob`）加一個 `custom` 逃生口，而不是讓 App 傳讀檔物件。理由：讀檔在 Worker 內執行，物件傳不過去。建議：採用；`custom` 要不要留？
2. **Q2 `ready` 要不要獨立**：與 `paused` 的差別只在「還沒播過」。建議：保留，App 可以用它決定要不要顯示大的播放鍵。
3. **Q3 `paused` 與 `state` 分開**：比照 `HTMLMediaElement.paused`。建議：採用，否則 seeking／buffering 結束後要回哪個狀態無從表達。
4. **Q4 同步屬性與非同步指令的分界**：音量、靜音、速度做成同步屬性；offset 因為要重新同步，做成指令。建議：採用。
5. **Q5 session 失效後的接續**：草稿是 App 用 `load(source, { startTime, paused, tracks })` 重新載入，外掛音軌與 offset 要自己重加。替代方案：`engine.reload()` 保留外掛音軌、offset 與位置重新開檔，或在 401 時停在 buffering 等 `retry()`。
6. **Q6 預設選軌**：依 `preferredLanguages`，再依容器 default 旗標；字幕只在 forced 或語言命中時開啟。
7. **Q7 language 正規化**：容器給 ISO 639-2（`jpn`）、MP4 可能是別的。要不要統一成 BCP 47（`ja`）？
8. **Q8 `extractSubtitles()`**：只留形狀，是否提供由「內嵌字幕整軌取出的歸屬」決定。
9. **Q9 行動裝置**：`mobile` 選項只留位置，由「行動裝置支援的歸屬」決定。
10. **Q10 事件 API**：`on()` 回傳 unsubscribe，而不是繼承 `EventTarget`。理由：payload 有型別、不用 `CustomEvent`。
11. **Q11 canvas 尺寸**：Engine 設定 `canvas.width/height` 為影片顯示尺寸，縮放交給 CSS。替代方案：App 決定 canvas 大小，Engine 依其縮放繪製（高 DPI 時畫面較清楚，但 Engine 要監聽 resize）。
12. **Q12 外掛音軌的生命週期**：屬於當前媒體，`load()`／`unload()` 時移除；加入後不自動選用。
