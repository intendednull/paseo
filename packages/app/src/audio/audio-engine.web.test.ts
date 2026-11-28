import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createAudioEngine } from "./audio-engine.web";

interface FakeSource {
  buffer: { duration: number } | null;
  startedAt: number | null;
  stopped: boolean;
  listeners: Map<string, () => void>;
}

let sources: FakeSource[] = [];
let now = 0;

class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() {
    return now;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { duration: length / sampleRate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const source: FakeSource = {
      buffer: null,
      startedAt: null,
      stopped: false,
      listeners: new Map(),
    };
    sources.push(source);
    return Object.assign(source, {
      connect() {},
      disconnect() {},
      addEventListener(type: string, listener: () => void) {
        source.listeners.set(type, listener);
      },
      start(when = 0) {
        source.startedAt = when;
      },
      stop() {
        source.stopped = true;
      },
    });
  }
  async resume() {}
  async close() {}
}

const pcm = (seconds: number) => {
  const bytes = new Uint8Array(Math.round(seconds * 24000) * 2);
  return {
    size: bytes.byteLength,
    type: "audio/pcm;rate=24000;bits=16",
    arrayBuffer: async () => bytes.buffer,
  };
};

const engine = () => createAudioEngine({ onCaptureData() {}, onVolumeLevel() {} });

beforeEach(() => {
  sources = [];
  now = 0;
  vi.useFakeTimers();
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("schedules consecutive pcm chunks back to back, without a gap", async () => {
  const audio = engine();
  const first = audio.play(pcm(0.5));
  await vi.advanceTimersByTimeAsync(0);
  expect(sources[0].startedAt).toBe(0);

  // play() resolves just before the chunk ends, so the next one can be queued in time.
  await vi.advanceTimersByTimeAsync(379);
  let firstDone = false;
  void first.then(() => {
    firstDone = true;
    return undefined;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(firstDone).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  expect(firstDone).toBe(true);

  now = 0.39;
  const second = audio.play(pcm(0.25));
  await vi.advanceTimersByTimeAsync(0);
  expect(sources[1].startedAt).toBeCloseTo(0.5, 6);
  await vi.advanceTimersByTimeAsync(1000);
  await second;
});

test("starts immediately when nothing is still sounding", async () => {
  const audio = engine();
  const first = audio.play(pcm(0.2));
  await vi.advanceTimersByTimeAsync(1000);
  await first;
  now = 5;
  void audio.play(pcm(0.2));
  await vi.advanceTimersByTimeAsync(0);
  expect(sources[1].startedAt).toBe(5);
});

test("stop silences a handed-off chunk that is still sounding", async () => {
  const audio = engine();
  const first = audio.play(pcm(1));
  await vi.advanceTimersByTimeAsync(1000);
  await first;
  expect(sources[0].stopped).toBe(false);

  const second = audio.play(pcm(1)).catch((error: Error) => error.message);
  await vi.advanceTimersByTimeAsync(0);
  audio.stop();
  expect(sources[0].stopped).toBe(true);
  expect(sources[1].stopped).toBe(true);
  expect(await second).toBe("Playback stopped");

  // After a stop, the next chunk starts now rather than after the cancelled one.
  now = 0.2;
  void audio.play(pcm(0.2));
  await vi.advanceTimersByTimeAsync(0);
  expect(sources[2].startedAt).toBe(0.2);
});
