// browser mode 測試用：錄下送到 `AudioContext.destination` 的聲音，不改變被測的程式碼。
// 包住 `AudioWorklet.prototype.addModule`（先載入錄音 worklet）與 `AudioNode.prototype.connect`
// （接到 destination 的地方改成經過錄音 node）。

const captureUrl = new URL('./capture.worklet.ts', import.meta.url);

interface CaptureBatch {
  left: Float32Array;
  right: Float32Array;
}

export interface DestinationCapture {
  /** 到目前為止錄到的 frame 數（只算第一個接到 destination 的 node）。 */
  readonly frames: number;
  /** 錄到的左、右聲道。 */
  channels(): [Float32Array, Float32Array];
  /** 還原被包住的方法。 */
  restore(): void;
}

export function captureDestination(): DestinationCapture {
  const batches: CaptureBatch[] = [];
  let frames = 0;
  let captured = false;
  const loaded = new WeakSet<AudioWorklet>();

  // 原本的方法之後以 call() 帶入正確的 this。
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const addModule = AudioWorklet.prototype.addModule;
  AudioWorklet.prototype.addModule = async function (
    this: AudioWorklet,
    url: string | URL,
    options?: WorkletOptions,
  ) {
    if (!loaded.has(this)) {
      loaded.add(this);
      await addModule.call(this, captureUrl);
    }
    return addModule.call(this, url, options);
  };

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const connect = AudioNode.prototype.connect as (
    this: AudioNode,
    destination: AudioNode | AudioParam,
    output?: number,
    input?: number,
  ) => AudioNode;
  AudioNode.prototype.connect = function (
    this: AudioNode,
    destination: AudioNode | AudioParam,
    output?: number,
    input?: number,
  ) {
    if (!(destination instanceof AudioDestinationNode) || captured) {
      return connect.call(this, destination, output, input);
    }
    captured = true;
    const capture = new AudioWorkletNode(this.context, 'capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    capture.port.onmessage = ({ data }: MessageEvent<CaptureBatch>) => {
      batches.push(data);
      frames += data.left.length;
    };
    connect.call(this, capture, output, input);
    connect.call(capture, destination);
    return destination;
  };

  return {
    get frames() {
      return frames;
    },
    channels() {
      const join = (pick: (b: CaptureBatch) => Float32Array) => {
        const result = new Float32Array(frames);
        let offset = 0;
        for (const batch of batches) {
          result.set(pick(batch), offset);
          offset += batch.left.length;
        }
        return result;
      };
      return [join((b) => b.left), join((b) => b.right)];
    },
    restore() {
      AudioWorklet.prototype.addModule = addModule;
      AudioNode.prototype.connect = connect;
    },
  };
}
