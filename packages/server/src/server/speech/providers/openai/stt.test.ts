import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const { openAiConstructorOptionsMock, transcriptionsCreateMock } = vi.hoisted(() => ({
  openAiConstructorOptionsMock: vi.fn(),
  transcriptionsCreateMock: vi.fn(),
}));

vi.mock("openai", () => ({
  OpenAI: vi.fn(function OpenAI(options: unknown) {
    openAiConstructorOptionsMock(options);
    return {
      audio: {
        transcriptions: {
          create: transcriptionsCreateMock,
        },
      },
    };
  }),
}));

import { OpenAISTT } from "./stt.js";

async function streamByteLength(stream: NodeJS.ReadableStream): Promise<number> {
  let size = 0;
  for await (const chunk of stream) size += (chunk as Buffer).length;
  return size;
}

describe("OpenAISTT", () => {
  afterEach(() => {
    openAiConstructorOptionsMock.mockReset();
    transcriptionsCreateMock.mockReset();
  });

  test("passes configured baseUrl to the OpenAI client", () => {
    const provider = new OpenAISTT(
      { apiKey: "sk-test", baseUrl: "https://speech.example.com/v1" },
      pino({ level: "silent" }),
    );

    expect(provider.id).toBe("openai");
    expect(openAiConstructorOptionsMock).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://speech.example.com/v1",
    });
  });

  test("passes transcription prompt to OpenAI REST STT", async () => {
    transcriptionsCreateMock.mockImplementation(
      async (request: { file: NodeJS.ReadableStream }) => {
        await new Promise<void>((resolve, reject) => {
          request.file.once("error", reject);
          request.file.once("end", resolve);
          request.file.resume();
        });
        return { text: "hello" };
      },
    );

    const provider = new OpenAISTT(
      { apiKey: "sk-test", model: "gpt-4o-transcribe" },
      pino({ level: "silent" }),
    );
    const session = provider.createSession({
      logger: pino({ level: "silent" }),
      language: "en",
      prompt: "Only transcribe the speaker.",
    });

    const transcript = new Promise<string>((resolve, reject) => {
      session.on("transcript", (event) => {
        if (event.isFinal) {
          resolve(event.transcript);
        }
      });
      session.on("error", (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    await session.connect();
    session.appendPcm16(Buffer.from([0, 0, 0, 0]));
    session.commit();

    await expect(transcript).resolves.toBe("hello");
    expect(transcriptionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "en",
        model: "gpt-4o-transcribe",
        prompt: "Only transcribe the speaker.",
        response_format: "json",
      }),
    );
  });

  test("keeps audio appended while a commit's request is in flight", async () => {
    const uploadedBytes: number[] = [];
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    transcriptionsCreateMock.mockImplementation(
      async (request: { file: NodeJS.ReadableStream }) => {
        uploadedBytes.push(await streamByteLength(request.file));
        if (uploadedBytes.length === 1) {
          await firstHeld;
        }
        return { text: `segment ${uploadedBytes.length}` };
      },
    );

    const provider = new OpenAISTT({ apiKey: "sk-test" }, pino({ level: "silent" }));
    const session = provider.createSession({ logger: pino({ level: "silent" }), language: "en" });
    const transcripts: string[] = [];
    session.on("transcript", (event) => {
      if (event.isFinal) {
        transcripts.push(event.transcript);
      }
    });

    await session.connect();
    session.appendPcm16(Buffer.alloc(320));
    session.commit();
    await vi.waitFor(() => expect(uploadedBytes).toHaveLength(1));

    session.appendPcm16(Buffer.alloc(640));
    releaseFirst();
    await vi.waitFor(() => expect(transcripts).toEqual(["segment 1"]));
    session.commit();
    await vi.waitFor(() => expect(transcripts).toEqual(["segment 1", "segment 2"]));

    expect(uploadedBytes[1]! - uploadedBytes[0]!).toBe(320);
  });
});
