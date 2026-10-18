// media Worker 的 host 物件型別：以 webworker lib 實例化協定的 HostTypes。

import type { HostTypes } from '../protocol/index.js';

export interface WorkerHost extends HostTypes {
  wasmModule: WebAssembly.Module;
  messagePort: MessagePort;
  blob: Blob;
}
