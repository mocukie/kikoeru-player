// 印出目前 wasm/ 對應的 wasm Release tag，供 CI 的 ensure-wasm 使用。
import { repoRoot, wasmReleaseTag } from './wasm.ts';

console.log(wasmReleaseTag(repoRoot));
