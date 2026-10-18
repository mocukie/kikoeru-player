# 實機清單

自動化涵蓋不到、要在實機上確認的項目。規則（執行時機、桌面只留哪些項目、結果貼在哪裡）見[測試規範「實機清單」](testing.md#實機清單)。

## 執行方式

1. 開發機執行 `pnpm dev`。dev server 開 HTTPS（自簽憑證）並聽所有介面，終端機會列出 LAN 的網址（`https://<LAN IP>:5173/`）。
2. 實機與開發機在同一個網路，以瀏覽器開啟該網址，接受自簽憑證的警告，進入 Demo 頁（`/demo/`）。
3. 依下方對應平台的項目操作。每一項記下結果（通過／失敗／不適用）與觀察；失敗時按事件 log 的「複製」，連同裝置、OS 與瀏覽器版本一起貼上。
4. 結果整理成一則 issue 留言，標明 Engine 的 commit。

Demo 頁的「CI 組媒體」來自 `pnpm media:gen` 產生的 `test/media/out/`。測試媒體每整秒開始有 0.1 秒的 beep（每 10 秒的那一聲頻率加倍），可以用耳朵對照 `currentTime`，特徵見 [`test/media/README.md`](../test/media/README.md)。

## 共同項目

每個平台都要做；平台各節只列額外的項目。

- [ ] **解鎖**：重新整理頁面後，第一次按 play 就能出聲（`play()` 在 user gesture 內同步解鎖 `AudioContext`）。
- [ ] **沒有 gesture**：重新整理後不點擊頁面，在 console（手機用遠端偵錯）執行 `await engine.load({ kind: 'http', url: '/media/audio/flac.flac' })`，resolve 且 state 為 `ready`（`AudioContext` 還沒開始時 worklet 仍處理 port 的訊息）；接著 `await engine.play()` 以非致命的 `AUDIO_LOCKED` reject，`paused` 回到 true；之後按 play 能正常播放。
- [ ] **CI 組的純音訊檔**：`audio/` 每一個檔案都能 load、play、pause、播到結尾（`ended`），聲音沒有破音、斷續或忽快忽慢。
- [ ] **取樣率**：`audio/flac-44100.flac`、`flac-96000.flac`、`flac-192000.flac` 的音高與 `audio/flac.flac` 相同（重採樣到 `AudioContext.sampleRate`）。
- [ ] **多聲道**：`audio/flac-5.1.flac` 以 stereo 播出，各聲道的 beep 都聽得到。
- [ ] **ring buffer 的預設水位**：播放時事件 log 沒有出現 `buffering`（`audioBuffer` 的平台預設值不會 starved）；有的話記下媒體與頻率。
- [ ] **currentTime 與聽到的聲音**：beep 響起時，畫面上的 `currentTime` 剛好跨過整秒；明顯提早或延後時記下差距與輸出裝置（喇叭、有線耳機、藍牙）。這同時驗證該瀏覽器的 `getOutputTimestamp().contextTime` 是否已扣掉裝置延遲（[ADR-0004](adr/0004-audio-output.md)）。
- [ ] **連續換檔**：播放中選另一個檔案按 load，舊的聲音立即停止，新的檔案停在 `ready`。

## 桌面

### Firefox

- [ ] 真實喇叭與藍牙耳機之間切換輸出裝置時，播放繼續、`currentTime` 不跳。
- [ ] 連續播放 30 分鐘以上（手動組 `pnpm media:gen:manual` 的長檔）不中斷、不漂移。

### Safari

Safari 不跑 E2E，共同項目都要做。

- [ ] AudioWorklet 能接收 transfer 過來的 `MessagePort`：load 之後能出聲（media Worker 經 `MessageChannel` 直接供料給 worklet）。
- [ ] 真實喇叭與藍牙耳機之間切換輸出裝置時，播放繼續、`currentTime` 不跳。
- [ ] 連續播放 30 分鐘以上不中斷、不漂移。

## 手機

### iOS Safari

- [ ] AudioWorklet 能接收 transfer 過來的 `MessagePort`：load 之後能出聲。
- [ ] 靜音鍵開啟時的行為（記下有沒有聲音；背景播放模組完成後應該要有聲音）。
- [ ] 有線耳機、藍牙耳機的拔除與連接：播放不中斷，或依系統行為暫停後能再按 play 恢復。

### Android Chrome

- [ ] load 之後能出聲，`audioBuffer` 的 Android 預設值不會 starved。
- [ ] 有線耳機、藍牙耳機的拔除與連接：播放不中斷，或依系統行為暫停後能再按 play 恢復。

## 背景與鎖屏

背景播放模組（`kikoeru-player/background`）完成後才執行。底稿來自 kikoeru 的行動瀏覽器背景播放 research；Android 只在使用靜音 anchor 時才有背景播放（[ADR-0006](adr/0006-background-playback-module.md)）。

- [ ] 鎖屏後連續播放 30 分鐘以上不中斷，並記錄耗電。
- [ ] 背景中能自動播下一個檔案，包括背景中的 fetch、demux 與 decoder 初始化。
- [ ] 鎖屏控制：play、pause、上一首、下一首、seek；metadata 與 artwork 正確，進度條同步。
- [ ] 中斷與恢復：來電、Siri、鬧鐘或計時器、拔除耳機；iOS 的 `interrupted` 狀態與恢復路徑。
- [ ] 在鎖屏暫停 10 秒以上再按播放（iOS 的 process 可能已經被 suspend）。
- [ ] iPhone 靜音鍵開啟時仍有聲音。
- [ ] 鎖屏上沒有沒作用的按鈕（Now Playing 是 `AudioContext` 時的上一首、下一首）。
