// fixture App：像 kikoeru 一樣從套件 import Engine，Worker、AudioWorklet 與 wasm 都交給 Vite 處理。
// 驗收（acceptance.spec.ts）以 `fixture` 操作，以 #play 的點擊提供 user gesture。
import {
  createEngine,
  isAbortError,
  thirdPartyNotices,
  type Engine,
  type ThirdPartyNotice,
} from 'kikoeru-player';

declare global {
  var fixture: {
    engine: Engine;
    load(url: string): Promise<void>;
    errors: string[];
    thirdPartyNotices: readonly ThirdPartyNotice[];
  };
}

const engine = createEngine();
const errors: string[] = [];
const report = (error: unknown) => {
  if (!isAbortError(error)) errors.push(String(error));
};

const state = document.getElementById('state');
engine.addEventListener('statechange', (event) => {
  if (state) state.textContent = event.state;
});
engine.addEventListener('error', (event) => {
  errors.push(`${event.error.code}: ${event.error.message}`);
});

document.getElementById('play')?.addEventListener('click', () => {
  engine.play().catch(report);
});

const about = document.getElementById('about');
if (about) {
  about.textContent = thirdPartyNotices
    .map((notice) => `${notice.name}（${notice.license}）\n${notice.sourceUrl}`)
    .join('\n\n');
}

globalThis.fixture = {
  engine,
  errors,
  thirdPartyNotices,
  async load(url) {
    await engine.load({ kind: 'http', url });
  },
};
