# 實機清單

自動化涵蓋不到、要在實機上確認的項目。規則（執行時機、桌面只留哪些項目、結果貼在哪裡）見[測試規範「實機清單」](testing.md#實機清單)。

## 執行方式

1. 開發機執行 `pnpm dev`。dev server 開 HTTPS（自簽憑證）並聽所有介面，終端機會列出 LAN 的網址（`https://<LAN IP>:5173/`）。
2. 實機與開發機在同一個網路，以瀏覽器開啟該網址，接受自簽憑證的警告，進入 Demo 頁（`/demo/`）。Demo 頁預設勾選「背景播放模組」（App 的典型用法）；項目要求不勾選時取消勾選，或開 `/demo/?background=0`。
3. 依下方對應平台的項目操作。每一項記下結果（通過／失敗／不適用）與觀察；失敗時按事件 log 的「複製」，連同裝置、OS 與瀏覽器版本一起貼上。
4. 結果整理成一則 issue 留言，標明 Engine 的 commit。

Demo 頁的「測試媒體」來自 `test/media/out/`：`pnpm media:gen` 產生 CI 組，`pnpm media:gen:manual` 產生長檔後會出現 `manual` 分組，可直接選取，不必貼 URL。測試媒體每整秒開始有 0.1 秒的 beep（每 10 秒的那一聲頻率加倍），可以用耳朵對照 `currentTime`，特徵見 [`test/media/README.md`](../test/media/README.md)。

## 共同項目

每個平台都要做；平台各節只列額外的項目。

- [ ] **解鎖**：重新整理頁面後，第一次按 play 就能出聲（`play()` 在 user gesture 內同步解鎖 `AudioContext`）。
- [ ] **沒有 gesture**：重新整理後不點擊頁面，在 console（手機用遠端偵錯）執行 `await engine.load({ kind: 'http', url: '/media/audio/flac.flac' })`，resolve 且 state 為 `ready`（`AudioContext` 還沒開始時 worklet 仍處理 port 的訊息）；接著 `await engine.play()` 以非致命的 `AUDIO_LOCKED` reject，`paused` 回到 true；之後按 play 能正常播放。
- [ ] **unlockAudio**：重新整理後按 unlockAudio，事件 log 出現 `beforeaudiostart cause=unlock`，`audioUnlocked` 變為 true；之後在 console 執行 `await engine.load({ kind: 'http', url: '/media/audio/flac.flac' }, { paused: false })` 直接進入 `playing`。
- [ ] **沒有 gesture 的 load（paused: false）**：重新整理後不點擊頁面，在 console 執行上一項的 load，resolve 時 state 為 `ready`、`paused` 為 true、`audioUnlocked` 為 false，事件 log 沒有出現 `playing`。
- [ ] **長時間暫停**：播放中按 pause，等 40 秒以上（Engine 在 30 秒時 suspend `AudioContext`），再按 play：事件 log 出現 `beforeaudiostart cause=resume`，能正常恢復播放。另外在 console 以 `setTimeout(() => engine.play(), 0)` 從 gesture 之外恢復，記下是否需要 gesture（ADR-0004 待確認：iOS 上被 suspend 之後 `resume()` 不需要 gesture）。
- [ ] **CI 組的純音訊檔**：`audio/` 每一個檔案都能 load、play、pause、播到結尾（`ended`），聲音沒有破音、斷續或忽快忽慢。
- [ ] **取樣率**：`audio/flac-44100.flac`、`flac-96000.flac`、`flac-192000.flac` 的音高與 `audio/flac.flac` 相同（重採樣到 `AudioContext.sampleRate`）。
- [ ] **多聲道**：`audio/flac-5.1.flac` 以 stereo 播出，各聲道的 beep 都聽得到。
- [ ] **ring buffer 的預設水位**：播放時事件 log 沒有出現 `buffering`（`audioBuffer` 的平台預設值不會 starved）；有的話記下媒體與頻率。
- [ ] **currentTime 與聽到的聲音**：beep 響起時，畫面上的 `currentTime` 剛好跨過整秒；明顯提早或延後時記下差距與輸出裝置（喇叭、有線耳機、藍牙）。這同時驗證該瀏覽器的 `getOutputTimestamp().contextTime` 是否已扣掉裝置延遲（[ADR-0004](adr/0004-audio-output.md)）。
- [ ] **連續換檔**：播放中選另一個檔案按 load，舊的聲音立即停止，新的檔案停在 `ready`。
- [ ] **淡入淡出（`audioFadeMs`）的聽感**：以喇叭與耳機各聽一次，播放中按 pause、play、拖曳 seek，切換點沒有爆音（click／pop），也不會聽得出拖泥帶水。再於 console 以 `createEngine({ audioFadeMs: 0 })` 比較硬切（應該聽得到 click），以及 `audioFadeMs: 30`、`100` 的差別，記下覺得合適的值。
- [ ] **變速的聽感**：以喇叭與耳機各聽一次語音與音樂（手動組或自己的檔案），拖曳 Demo 頁的 playbackRate 到 0.5、0.75、1.25、1.5、2：音高不變，沒有明顯的金屬聲、回音或忽快忽慢；記下哪個速度開始覺得不自然。播放中改速度約 0.2 秒後生效，切換點（含按「1.0x」回到原速、繞過 `atempo`）沒有 click／pop 或斷續；beep 響起時 `currentTime` 仍剛好跨過整秒。手機上另外記下 1.5x 連續播放 10 分鐘的 CPU 與耗電（實機驗證的 issue）。
- [ ] **音量與靜音**：拖曳 Demo 頁的 volume 時音量平滑變化、沒有拉鍊聲；勾選 muted 時立即無聲，`currentTime` 照常前進，取消後回到原本的音量。
- [ ] **藍牙延遲**：接上藍牙耳機播放，記下 Demo 頁「audio」一列的 `outputLatency`；beep 響起時 `currentTime` 是否仍剛好跨過整秒（藍牙的延遲常有 100–300 ms）。暫停時 `currentTime` 停在最後聽到的位置附近，不比聽到的超前。
- [ ] **讀取錯誤與 reload**：選 `audio/pcm-s16.wav` 與故障注入「401@4」，load 後播放：約 2–3 秒時（預讀遇到 401，播放用完已讀到的資料時）事件 log 出現 `error SOURCE_UNAUTHORIZED（fatal） position=…`；按 reload 從該位置接續播放。故障注入改選「drop@500KB」：斷線與重試發生在預讀中，播放不出現 `buffering` 與 error。
- [ ] **預讀與快取**：播放 `audio/pcm-s16.wav`，Demo 頁「cache」一列的預讀很快抓到檔尾、不再「抓取中」；之後往前 seek，「network」的已讀 bytes 不增加，hits 增加。
- [ ] **網路不足與 buffering**：開 `/demo/?readahead=0.5`，`audio/pcm-s16.wav` 加自訂故障 `delay=4000` 播放：事件 log 出現 `buffering`（reason media），之後回到 `playing`；不會在一兩百 ms 內反覆切換。手機的行動網路下以一般設定播放手動組的長檔，記下有沒有 `buffering`。
- [ ] **卡住後自動恢復**：`audio/pcm-s16.wav` 加故障注入「stall@1MB」：約 5–6 秒處 `buffering`，約 8 秒後事件 log 出現 `stall`，接著 `stallrecovered` 並繼續播放；改選「stall@1MB+」：`stall` 兩次之後以 `error SOURCE_NETWORK（fatal）` 結束（`/demo/?stallTimeout=2000` 可以縮短等待）。

## 桌面

### Firefox

- [ ] 真實喇叭與藍牙耳機之間切換輸出裝置時，播放繼續、`currentTime` 不跳。
- [ ] **背景播放模組與 AudioContext 同時輸出**：勾選「背景播放模組」（預設），反覆 play、pause、seek：beep 仍對準 `currentTime`、沒有斷續（靜音 anchor 與 `AudioContext` 同時播放）。
- [ ] 連續播放 30 分鐘以上（手動組 `pnpm media:gen:manual` 的長檔）不中斷、不漂移。

### Safari

Safari 不跑 E2E，共同項目都要做。

- [ ] AudioWorklet 能接收 transfer 過來的 `MessagePort`：load 之後能出聲（media Worker 經 `MessageChannel` 直接供料給 worklet）。
- [ ] 真實喇叭與藍牙耳機之間切換輸出裝置時，播放繼續、`currentTime` 不跳。
- [ ] 連續播放 30 分鐘以上不中斷、不漂移。

## 手機

### iOS Safari

- [ ] AudioWorklet 能接收 transfer 過來的 `MessagePort`：load 之後能出聲。
- [ ] 靜音鍵開啟時的行為：不勾選 Demo 頁的「背景播放模組」時記下有沒有聲音；勾選時應該要有聲音（`audioSession.type = "playback"`）。
- [ ] 有線耳機、藍牙耳機的拔除與連接：播放不中斷，或依系統行為暫停後能再按 play 恢復。
- [ ] **系統中斷**：播放中以來電、Siri 或計時器響鈴中斷，事件 log 出現 `paused=true reason=interrupted`；中斷結束後**不會**自動恢復出聲（WebKit 自己 resume `AudioContext` 時 worklet 仍輸出靜音），按 play 出現 `beforeaudiostart cause=resume` 並恢復播放。若中斷尚未結束就按 play，記下是否得到 `AUDIO_OUTPUT`（`play()` 的非致命 reject，`paused` 回到 true）。
- [ ] **鎖屏控制**：不勾選 Demo 頁的「背景播放模組」（沒有 anchor）時，鎖屏的 Now Playing 是 `AudioContext`；以鎖屏的暫停、播放鍵操作，事件 log 出現 `reason=external`，`paused` 跟著改變。
- [ ] **長時間暫停後的 resume**：暫停 40 秒以上（Engine 已 suspend `AudioContext`）後，分別以頁面的 play、鎖屏的播放鍵恢復，記下哪一種需要 gesture、有沒有聲音。
- [ ] **記憶體壓力**：以手動組的 `long-40min-s24.wav`（約 660 MB）與 `long-30min-720p.mkv` 播放、往前往後 seek，Demo 頁「cache」一列不超過 64 MiB，分頁不被系統重新載入（`cacheBytes`／`readaheadSeconds` 預設值的實機驗證，「記憶體上限的數值」#23）。

### Android Chrome

- [ ] load 之後能出聲，`audioBuffer` 的 Android 預設值不會 starved。
- [ ] 有線耳機、藍牙耳機的拔除與連接：播放不中斷，或依系統行為暫停後能再按 play 恢復。

## 背景與鎖屏

使用背景播放模組（`kikoeru-player/background`）：Demo 頁預設勾選「背景播放模組」（`/demo/?background=0` 時不勾選）。底稿來自 kikoeru 的行動瀏覽器背景播放 research；Android 只在使用靜音 anchor 時才有背景播放（[ADR-0006](adr/0006-background-playback-module.md)）。Demo 頁沒有設定 Media Session 的 handler 與 metadata（App 負責），以下項目記下的是沒有 handler 時的行為；Media Session 的上一首、下一首、seek、metadata、artwork 與進度條在 kikoeru 驗證。模組的 log 以 `[background]` 開頭出現在事件 log，等級與 Engine 共用頁面的 log 選單（外部暫停、播放的鏡像是 `info`）。

### 共同（iOS Safari、Android Chrome）

- [ ] **鎖屏**：播放中鎖屏，連續播放 30 分鐘以上不中斷，並記錄耗電。
- [ ] **背景接下一首**：勾選「播完接同組下一首」，播放一個短檔後鎖屏或切到其他 App；播完時自動 load 同組下一個檔案並出聲（最後一個接回同組第一個，不跨組；背景中的 fetch、demux 與 decoder 初始化，不需要 gesture），anchor 在換曲之間不中斷。
- [ ] **buffering 時不被凍結**：故障注入選「delay=200」或「stall@1MB」，在背景中播放到 buffering；恢復後繼續出聲（anchor 在 buffering 時繼續播放，process 沒有被凍結）。
- [ ] **暫停後從鎖屏恢復**：播放中從頁面按 pause，鎖屏的播放器仍在；從鎖屏按播放能恢復，事件 log 出現 `paused=false reason=command`（anchor 的外部播放鏡像為 `engine.play()`）。另外暫停 40 秒以上（Engine 已 suspend `AudioContext`）再從鎖屏按播放，記下是否出聲、是否得到 `AUDIO_LOCKED`。
- [ ] **中斷與恢復**：來電、鬧鐘或計時器、拔除耳機；事件 log 的 reason（`interrupted`、`external` 或 anchor 鏡像的 `command`），以及之後按 play 能恢復。
- [ ] **detach**：播放中取消勾選「背景播放模組」，鎖屏的播放器消失或不再控制 Engine；再勾選時立即回來。

### iOS Safari

- [ ] **Now Playing**：播放中鎖屏，Now Playing 顯示的是 anchor（media element），而不是 `AudioContext`；鎖屏的暫停、播放鍵讓 Engine 跟著停止與播放（事件 log 的 `reason=command`），不是 WebKit 直接 suspend `AudioContext`（`reason=external`）。
- [ ] **暫停後的 Now Playing**：播放中按 pause，30 秒內（`AudioContext` 仍在執行）鎖屏，Now Playing 是否仍是 anchor、從鎖屏按播放是否正常（ADR-0006 留給實機驗證）。
- [ ] **靜音鍵**：靜音鍵開啟時仍有聲音。
- [ ] **鎖屏暫停 10 秒以上再播放**：process 可能已經被 suspend，按播放後能恢復出聲。
- [ ] **背景接下一首時 anchor 持續播放**：上方「背景接下一首」時 Now Playing 不被搶走、不消失。
- [ ] 鎖屏上沒有沒作用的按鈕（Now Playing 是 `AudioContext` 時的上一首、下一首）。

### Android Chrome

- [ ] **通知**：播放時出現媒體通知；通知的暫停、播放讓 Engine 跟著停止與播放（`reason=command`）。換曲（「播完接同組下一首」）時通知不閃爍、不消失。
- [ ] **audio focus**：播放中開啟其他 App 播放音樂，Engine 跟著暫停（anchor 被搶走 focus 的 pause 鏡像為 `engine.pause()`）；回來按 play 能恢復。
- [ ] **來電**：來電時 Engine 暫停，掛斷後依系統行為恢復或停在 paused，記下結果。
