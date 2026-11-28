import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { Readable } from "node:stream";

import { TTSManager } from "./tts-manager.js";
import type { TextToSpeechProvider } from "../speech/speech-provider.js";
import type { SessionOutboundMessage } from "../messages.js";

type AudioOutputMessage = Extract<
  SessionOutboundMessage,
  { type: "audio_output" }
>;

function isAudioOutputMessage(
  message: SessionOutboundMessage
): message is AudioOutputMessage {
  return message.type === "audio_output";
}

class FakeTts implements TextToSpeechProvider {
  async synthesizeSpeech(): Promise<{ stream: Readable; format: string }> {
    return {
      stream: Readable.from([Buffer.from("a"), Buffer.from("b")]),
      format: "pcm;rate=24000",
    };
  }
}

// Sentences long enough that no two fit in one synthesis request (4000 chars).
const longSentence = (label: string) =>
  `${label} ${"detail ".repeat(320).trim()}.`;

describe("TTSManager", () => {
  it("emits chunks and resolves once confirmed", async () => {
    const manager = new TTSManager(
      "s1",
      pino({ level: "silent" }),
      new FakeTts()
    );
    const abort = new AbortController();
    const emitted: SessionOutboundMessage[] = [];

    const task = manager.generateAndWaitForPlayback(
      "hello",
      (msg) => {
        emitted.push(msg);
        if (msg.type === "audio_output") {
          manager.confirmAudioPlayed(msg.payload.id);
        }
      },
      abort.signal,
      true
    );

    await task;

    const audioMsgs = emitted.filter((m) => m.type === "audio_output");
    expect(audioMsgs).toHaveLength(1);
    const audioMessage = emitted.find(isAudioOutputMessage);
    expect(audioMessage).toBeDefined();
    expect(audioMessage?.payload.groupId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(audioMessage?.payload.chunkIndex).toBe(0);
    expect(audioMessage?.payload.isLastChunk).toBe(true);
  });

  it("splits long text into safe synthesis segments", async () => {
    const calls: string[] = [];
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech(
        text: string
      ): Promise<{ stream: Readable; format: string }> {
        calls.push(text);
        return {
          stream: Readable.from([Buffer.from("x")]),
          format: "pcm;rate=24000",
        };
      },
    };

    const manager = new TTSManager("s1", pino({ level: "silent" }), tts);
    const abort = new AbortController();
    const longText = Array.from({ length: 180 })
      .map((_, i) => `Sentence ${i + 1}.`)
      .join(" ");

    await manager.generateAndWaitForPlayback(
      longText,
      (msg) => {
        if (msg.type === "audio_output") {
          manager.confirmAudioPlayed(msg.payload.id);
        }
      },
      abort.signal,
      true
    );

    // A whole reply goes to the provider in one request, so prosody runs across sentences.
    expect(calls).toEqual([longText]);

    calls.length = 0;
    const veryLongText = Array.from({ length: 600 })
      .map((_, i) => `Sentence ${i + 1}.`)
      .join(" ");
    await manager.generateAndWaitForPlayback(
      veryLongText,
      (msg) => {
        if (msg.type === "audio_output") {
          manager.confirmAudioPlayed(msg.payload.id);
        }
      },
      abort.signal,
      true
    );

    // Only very long replies split, on sentence boundaries, without losing text.
    expect(calls.length).toBeGreaterThan(1);
    expect(
      calls.every((text) => text.length <= 4000 && text.endsWith("."))
    ).toBe(true);
    expect(calls.join(" ")).toBe(veryLongText);
  });

  it("streams pcm in growing chunks and marks only the last one", async () => {
    const second = 24000 * 2;
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech(): Promise<{ stream: Readable; format: string }> {
        // 5 s of audio arriving in 0.1 s pieces.
        return {
          stream: Readable.from(
            Array.from({ length: 50 }, () => Buffer.alloc(second / 10, 1))
          ),
          format: "pcm",
        };
      },
    };

    const manager = new TTSManager("s1", pino({ level: "silent" }), tts);
    const chunks: { index: number; bytes: number; last: boolean }[] = [];
    await manager.generateAndWaitForPlayback(
      "Hello there.",
      (msg) => {
        if (msg.type === "audio_output") {
          chunks.push({
            index: msg.payload.chunkIndex,
            bytes: Buffer.from(msg.payload.audio, "base64").length,
            last: msg.payload.isLastChunk,
          });
          manager.confirmAudioPlayed(msg.payload.id);
        }
      },
      new AbortController().signal,
      true
    );

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks.filter((c) => c.last)).toEqual([chunks[chunks.length - 1]]);
    expect(chunks[0].bytes).toBe(Math.round(0.8 * second));
    expect(chunks.every((c) => c.bytes % 2 === 0 && c.bytes > 0)).toBe(true);
    for (let i = 1; i < chunks.length - 1; i += 1) {
      expect(chunks[i].bytes).toBeLessThanOrEqual(
        Math.ceil(chunks[i - 1].bytes * 1.1) + 2
      );
    }
    expect(chunks.reduce((n, c) => n + c.bytes, 0)).toBe(5 * second);
  });

  it("prefetches the next segment before current playback completes", async () => {
    const started: string[] = [];
    const gateResolvers = new Map<string, () => void>();
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech(
        text: string
      ): Promise<{ stream: Readable; format: string }> {
        started.push(text);
        await new Promise<void>((resolve) => {
          gateResolvers.set(text, resolve);
        });
        return {
          stream: Readable.from([Buffer.from(text)]),
          format: "pcm;rate=24000",
        };
      },
    };

    const manager = new TTSManager("s1", pino({ level: "silent" }), tts);
    const abort = new AbortController();
    const segments = [
      longSentence("One"),
      longSentence("Two"),
      longSentence("Three"),
    ];
    const text = segments.join(" ");
    const emittedGroups: string[] = [];
    let firstChunkId: string | null = null;
    let releaseSecondAck: (() => void) | null = null;

    const task = manager.generateAndWaitForPlayback(
      text,
      (msg) => {
        if (msg.type !== "audio_output") {
          return;
        }

        if (!emittedGroups.includes(msg.payload.groupId!)) {
          emittedGroups.push(msg.payload.groupId!);
        }

        if (emittedGroups.length === 1) {
          firstChunkId = msg.payload.id;
          return;
        }

        releaseSecondAck?.();
        manager.confirmAudioPlayed(msg.payload.id);
      },
      abort.signal,
      true
    );

    expect(started).toEqual([segments[0], segments[1]]);

    gateResolvers.get(segments[0])?.();
    await vi.waitFor(() => {
      expect(firstChunkId).not.toBeNull();
    });

    expect(started).toEqual(segments);
    expect(emittedGroups).toHaveLength(1);

    const secondGroupPlayed = new Promise<void>((resolve) => {
      releaseSecondAck = resolve;
    });

    manager.confirmAudioPlayed(firstChunkId!);
    gateResolvers.get(segments[1])?.();

    await vi.waitFor(() => {
      expect(started).toEqual(segments);
      expect(emittedGroups).toHaveLength(2);
    });

    gateResolvers.get(segments[2])?.();
    await secondGroupPlayed;
    await task;
  });

  it("destroys prefetched streams after abort", async () => {
    const destroyed: string[] = [];
    const tts: TextToSpeechProvider = {
      async synthesizeSpeech(
        text: string
      ): Promise<{ stream: Readable; format: string }> {
        const stream = new Readable({
          read() {
            this.push(Buffer.from(text));
            this.push(null);
          },
        });
        const destroySpy = vi
          .spyOn(stream, "destroy")
          .mockImplementation(function (this: Readable, error?: Error) {
            destroyed.push(text);
            return Readable.prototype.destroy.call(this, error);
          });
        void destroySpy;
        return {
          stream,
          format: "pcm;rate=24000",
        };
      },
    };

    const manager = new TTSManager("s1", pino({ level: "silent" }), tts);
    const abort = new AbortController();
    let firstChunkId: string | null = null;

    const task = manager.generateAndWaitForPlayback(
      [
        longSentence("First"),
        longSentence("Second"),
        longSentence("Third"),
      ].join(" "),
      (msg) => {
        if (msg.type === "audio_output" && firstChunkId === null) {
          firstChunkId = msg.payload.id;
        }
      },
      abort.signal,
      true
    );

    await vi.waitFor(() => {
      expect(firstChunkId).not.toBeNull();
    });

    abort.abort();

    await task;
    await vi.waitFor(() => {
      expect(destroyed.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("does not emit unhandled rejections when stream iteration fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const tts: TextToSpeechProvider = {
        async synthesizeSpeech(): Promise<{
          stream: Readable;
          format: string;
        }> {
          const stream = Readable.from(
            (async function* () {
              yield Buffer.from("a");
              throw new Error("stream exploded");
            })()
          );
          return {
            stream,
            format: "pcm;rate=24000",
          };
        },
      };

      const manager = new TTSManager("s1", pino({ level: "silent" }), tts);
      const abort = new AbortController();

      await expect(
        manager.generateAndWaitForPlayback(
          "hello",
          (msg) => {
            if (msg.type === "audio_output") {
              manager.confirmAudioPlayed(msg.payload.id);
            }
          },
          abort.signal,
          true
        )
      ).rejects.toThrow("stream exploded");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("ignores late confirmations for recently closed audio IDs", async () => {
    const logger = pino({ level: "silent" });
    const warnSpy = vi.spyOn(logger, "warn");
    const manager = new TTSManager("s1", logger, new FakeTts());
    const abort = new AbortController();
    const emitted: SessionOutboundMessage[] = [];

    await manager.generateAndWaitForPlayback(
      "hello",
      (msg) => {
        emitted.push(msg);
        if (msg.type === "audio_output") {
          manager.confirmAudioPlayed(msg.payload.id);
        }
      },
      abort.signal,
      true
    );

    const firstAudio = emitted.find((msg) => msg.type === "audio_output");
    expect(firstAudio?.type).toBe("audio_output");

    manager.confirmAudioPlayed(
      (firstAudio as Extract<SessionOutboundMessage, { type: "audio_output" }>)
        .payload.id
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
