// dev、build、test:browser、e2e 開始前檢查 wasm/dist/ 是否符合目前的 wasm/（ADR-0005）。
// 不符合時停下並提示 pnpm wasm:fetch 或 pnpm wasm:build，不自動下載。
import { checkWasmDist, repoRoot } from './wasm.ts';

const message = checkWasmDist(repoRoot);
if (message !== undefined) {
  console.error(message);
  process.exit(1);
}
