// 證明 browser mode 的音訊環境可用（CI 的 Chromium 與 Firefox）：沒有 gesture 也能讓 AudioContext 跑起來，
// oscillator 的聲音經錄音 worklet 送到 destination。
import { expect, test } from 'vitest';

/** recorder.worklet.ts 經 `port` 送出的回報。 */
interface RecorderReport {
  frames: number;
  peak: number;
}

function waitForFrames(port: MessagePort, frames: number): Promise<RecorderReport> {
  return new Promise((resolve) => {
    port.onmessage = ({ data }: MessageEvent<RecorderReport>) => {
      if (data.frames >= frames) resolve(data);
    };
  });
}

test('oscillator 的聲音經錄音 worklet 送到 destination', async () => {
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(new URL('./recorder.worklet.ts', import.meta.url));
    const recorder = new AudioWorkletNode(context, 'recorder');
    const oscillator = new OscillatorNode(context, { frequency: 440 });
    oscillator.connect(recorder).connect(context.destination);
    const halfSecond = waitForFrames(recorder.port, context.sampleRate / 2);
    oscillator.start();
    // Firefox 沒有 sound server、或沒有 autoplay 授權時，resume() 不會完成，測試會逾時。
    await context.resume();

    const report = await halfSecond;
    expect(report.peak).toBeGreaterThan(0.9);
    expect(context.currentTime).toBeGreaterThan(0.4);
  } finally {
    await context.close();
  }
});
