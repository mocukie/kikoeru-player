# Repository instructions

給在本 repo 工作的 coding agent 的開發規則。

## 文件

- 專案簡介、使用方式、文件索引與開發環境見 [README](README.md)；每個主題以索引中的權威文件為準。
- 名詞以 [`CONTEXT.md`](CONTEXT.md) 為準；決定的理由見 [`docs/adr/`](docs/adr/)。
- 修改 `src/` 前必讀[架構規則](docs/architecture.md)與[測試規範](docs/testing.md)；執行緒分工、目錄與依賴規則、訊息協定與不變式以架構規則為準。
- 本文件只放開發規則。

## 常用指令

開發、build、測試與 wasm 指令只維護於 [README「常用指令」](README.md#常用指令)。

## 硬性約束

違反以下任一條的 PR 不會被接受。細節與理由見[架構規則「不變式」](docs/architecture.md#不變式)與對應的 ADR。

1. 不得要求 COOP/COEP，也不得使用 `SharedArrayBuffer`（[ADR-0001](docs/adr/0001-libavjs-asyncify.md)）。
2. 每張 `VideoFrame` 都要 `close()`，包括錯誤路徑與被取代（epoch 過期）的輸出。
3. 對外的時間一律在媒體時間軸上，單位是秒。
4. 不得依賴 `AudioContext.state` 判斷流程；`suspend()`、`resume()`、`close()` 一律經 Engine 自己的佇列（[ADR-0004](docs/adr/0004-audio-output.md)）。
5. 每個讀取都要能用 `AbortSignal` 中止。
6. Worker 只能以字面寫法 `new Worker(new URL('./….js', import.meta.url), { type: 'module' })` 建立（[ADR-0005](docs/adr/0005-wasm-release-and-engine-package.md)）。
7. AudioWorklet 是單一檔案，只能 `import type`，不 import 任何 runtime 程式碼。
8. wasm 只能透過 `wasm/` 修改並重新 build，不手改 `wasm/dist/`，也不手改 libav.js 的產物；對 libav.js 的修改一律是 `wasm/` 內的 patch。
9. 不得啟用 FFmpeg 的 GPL 元件。
10. commit 任何二進位檔（測試媒體、圖片等）之前，先問過 user。
11. 公開 API 的變更要同步更新型別上的 TSDoc，並在 PR description 說明。

## 專案規則

### Commit message

- 第一行使用簡短英文，並以分類前綴開頭：`feat:`、`fix:`、`chore:`、`docs:`。
- 若需要詳細說明，第一行之後空一行，使用中文撰寫。

範例：

```
feat: add http source with range requests

以 Range 分段讀取，401／404／5xx 與網路中斷各自對應錯誤碼，每個讀取都能以 AbortSignal 中止。
```

### Branch

- 格式為 `<前綴>/<issue number>-<描述>`，例如 `feat/31-http-source`。沒有對應 issue 時省略 number：`docs/readme-typo`。
- 前綴與 commit message 的分類相同：`feat/`、`fix/`、`chore/`、`docs/`。依 issue 的主要性質選一個，branch 內各 commit 仍各自用適合的前綴。
- issue number 是 PR body `Closes #<n>` 的那個 `<n>`，處理子 issue 時就用子 issue 的 number。只寫數字，不加 `#`。
- 描述用簡短的英文 kebab-case，主 issue 的短代號可加可不加。
- 只有小型的 chore、docs 工作可以不開 issue。

### Agent 實作流程

所有 agent 實作任務都依本節準備 branch 與交付 PR；skill 的 commit 步驟在 branch 準備完成後執行。

1. 修改檔案前先確認目標 repository、目前 branch、working tree 狀態與是否位於 linked worktree。若目前目錄不屬於 Git repository，先從任務與環境定位目標 repository；無法定位時回報缺少的資訊，不自行 `git init`。保留既有未提交變更，不把無關變更納入本次 commit。
2. 一般 clone 在 `main` 時，先 fetch `origin`，再從最新 `origin/main` 建立符合上方命名規範的新 branch。既有 branch 屬於同一任務且命名合規時沿用；不同任務則另外建立 branch，不混用。實作與 commit 都在任務 branch 上進行。
3. linked worktree 的自動產生 branch（例如 `worktree-agent-*`）在修改檔案前依本次任務重新命名，保留目前 commit 與未提交變更；同任務且命名合規的 branch 直接沿用。若 worktree 是 detached HEAD，先在目前 HEAD 建立合規的任務 branch。既有 branch 屬於其他任務時，另建本次任務 branch，不改名冒充同一任務。
4. 建立或重新命名 branch 前，核對目標名稱是否已存在及是否被其他 worktree 使用；先確認用途，不強制覆蓋 branch、不重設其他 worktree，也不為改名刪除既有 remote branch 或改寫已發布的歷史。有衝突且無法安全處理時，回報衝突並取得處理決定。
5. 完成修改後先 review，完成變更所需的驗證，並確認 `pnpm verify` 通過；再 commit、push 任務 branch，建立以 `main` 為 base、可供 review 的 PR。同任務 branch 已有 open PR 時更新該 PR，不重複建立；小型 chore、docs 即使不開 issue，仍須交付 PR。
6. 回報實際驗證結果與 PR URL，由 user review 後合併，agent 不自行 merge。PR 合併使用 merge commit（`gh pr merge --merge`），不使用 squash merge。驗證、push 或建立 PR 失敗時，回報具體阻塞，不宣稱任務完成。

`pnpm verify` 只跑 Chromium；CI 另外要求 Firefox 通過。CI 的 Firefox 失敗時，用 `pnpm verify:docker` 在本機重現（見[測試規範「本機與 CI」](docs/testing.md#本機與-ci)）。

### 語言

- 文件、issue 與 code comment 使用中文（繁體）。
- 專有名詞或領域名詞維持英文，例如 demux、codec、AudioWorklet、epoch。程式命名一律用英文，對應的中文名詞見 `CONTEXT.md`。

### 第三方函式庫

- 不自己造輪子，有現成的函式庫就用。
- 所有新增的依賴都要列在 PR description 的「新增依賴」段落，寫明套件、版本與理由。
- `pnpm-workspace.yaml` 的 `allowBuilds` 只列實際需要執行 install script 的套件；新增時在 PR 說明理由。
- 改變 wasm 內容的依賴（libav.js 版本、FFmpeg 元件、emsdk）屬於 `wasm/` 的修改，見硬性約束第 8、9 條與 [ADR-0005](docs/adr/0005-wasm-release-and-engine-package.md)。

### 測試

- 每張實作 issue 的測試要求見[測試規範「每張實作 issue 的最低要求」](docs/testing.md#每張實作-issue-的最低要求)。

### 實作 issue 的交接

- 主 issue 與它的子 issue，title 都以同一個短代號開頭，例如 `[engine-v1] HTTP 來源與 Range 快取`。代號用簡短的英文 kebab-case，每個主 issue 一個，新 feature 開主 issue 時一併決定。
- 一張 issue 對應一個 branch 和一個 PR，PR body 寫 `Closes #<n>`。branch 命名見上方「Branch」。
- issue 與文件不一致時以 [README 文件索引](README.md#文件索引)中的權威文件為準；發現文件有錯時，在同一個 PR 修改文件並在 PR description 說明。
- 實作 issue 不在 README 加入功能敘述；公開 API 的行為寫在型別的 TSDoc。

## Agent skills

### Issue tracker

Issue 追蹤於 GitHub Issues（`mocukie/kikoeru-player`），透過 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

使用預設的五個 triage label：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：repo 根目錄一份 `CONTEXT.md` 加上 `docs/adr/`。See `docs/agents/domain.md`.
