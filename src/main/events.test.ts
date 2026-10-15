import { describe, expect, it } from 'vitest';
import { EngineError } from './errors.js';
import {
  BeforeAudioStartEvent,
  BufferedChangeEvent,
  CuesEvent,
  DurationChangeEvent,
  EngineErrorEvent,
  SeekedEvent,
  StallEvent,
  StallRecoveredEvent,
  StateChangeEvent,
  TimeUpdateEvent,
  TracksChangeEvent,
  VideoResizeEvent,
} from './events.js';
import type { EngineEventMap, SubtitleCue, Track } from './types.js';

const track: Track = {
  kind: 'audio',
  id: 'a:1',
  origin: 'container',
  streamIndex: 0,
  codec: 'flac',
  supported: true,
  default: true,
  forced: false,
  sampleRate: 44100,
  channels: 2,
  offset: 0,
};

const cue: SubtitleCue = {
  format: 'subrip',
  trackId: 's:2',
  id: '1000:0',
  start: 1,
  end: 2,
  text: 'こんにちは',
};

// 每個事件類別各一個實例，事件名稱對照 EngineEventMap 的 key。
const cases: { [K in keyof EngineEventMap]?: [EngineEventMap[K], Record<string, unknown>] } = {
  statechange: [
    new StateChangeEvent({ state: 'playing', previous: 'ready', paused: false, reason: 'command' }),
    { state: 'playing', previous: 'ready', paused: false, reason: 'command' },
  ],
  timeupdate: [new TimeUpdateEvent({ currentTime: 1.5 }), { currentTime: 1.5 }],
  durationchange: [new DurationChangeEvent({ duration: 20 }), { duration: 20 }],
  seeked: [new SeekedEvent({ currentTime: 7 }), { currentTime: 7 }],
  trackschange: [
    new TracksChangeEvent({
      tracks: [track],
      selected: { audio: 'a:1', video: null, subtitle: null },
    }),
    { tracks: [track], selected: { audio: 'a:1', video: null, subtitle: null } },
  ],
  bufferedchange: [
    new BufferedChangeEvent({ buffered: [{ start: 0, end: 30 }] }),
    { buffered: [{ start: 0, end: 30 }] },
  ],
  videoresize: [
    new VideoResizeEvent({ size: { width: 1920, height: 1080, rotation: 0 } }),
    { size: { width: 1920, height: 1080, rotation: 0 } },
  ],
  cues: [new CuesEvent({ trackId: 's:2', cues: [cue] }), { trackId: 's:2', cues: [cue] }],
  stall: [new StallEvent({ since: 1234, position: 5 }), { since: 1234, position: 5 }],
  stallrecovered: [
    new StallRecoveredEvent({ stalledMs: 9000, attempts: 1 }),
    { stalledMs: 9000, attempts: 1 },
  ],
  beforeaudiostart: [new BeforeAudioStartEvent({ cause: 'unlock' }), { cause: 'unlock' }],
};

describe('事件類別', () => {
  it.each(Object.entries(cases))('%s：事件名稱與欄位', (type, entry) => {
    const [event, fields] = entry;

    expect(event).toBeInstanceOf(Event);
    expect(event.type).toBe(type);
    expect(event).toMatchObject(fields);
    expect(event.bubbles).toBe(false);
    expect(event.cancelable).toBe(false);
  });

  it('error：帶著 EngineError', () => {
    const error = new EngineError('DECODE_FAILED', { fatal: false, position: 3 });
    const event = new EngineErrorEvent({ error });

    expect(event.type).toBe('error');
    expect(event.error).toBe(error);
  });

  it('經 EventTarget dispatch 時，listener 收到同一個實例與欄位', () => {
    const target = new EventTarget();
    const received: StallEvent[] = [];
    target.addEventListener('stall', (event) => received.push(event as StallEvent));

    const event = new StallEvent({ since: 10, position: 2 });
    target.dispatchEvent(event);

    expect(received).toEqual([event]);
    expect(received[0]?.position).toBe(2);
  });
});
