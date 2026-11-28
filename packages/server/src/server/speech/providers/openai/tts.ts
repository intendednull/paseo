import type pino from "pino";
import { OpenAI } from "openai";
import { PassThrough, Readable } from "node:stream";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";

export type { SpeechStreamResult };

export interface TTSConfig {
  apiKey: string;
  baseUrl?: string;
  model?: "tts-1" | "tts-1-hd" | (string & {});
  voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" | (string & {});
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export class OpenAITTS implements TextToSpeechProvider {
  private readonly openaiClient: OpenAI;
  private readonly config: TTSConfig;
  private readonly logger: pino.Logger;

  constructor(ttsConfig: TTSConfig, parentLogger: pino.Logger) {
    this.config = {
      model: "tts-1",
      voice: "alloy",
      responseFormat: "pcm",
      ...ttsConfig,
    };
    this.logger = parentLogger.child({
      module: "agent",
      provider: "openai",
      component: "tts",
    });
    this.openaiClient = new OpenAI({
      apiKey: ttsConfig.apiKey,
      ...(ttsConfig.baseUrl ? { baseURL: ttsConfig.baseUrl } : {}),
    });

    this.logger.info(
      {
        voice: this.config.voice,
        model: this.config.model,
        format: this.config.responseFormat,
      },
      "TTS (OpenAI) initialized",
    );
  }

  public getConfig(): TTSConfig {
    return this.config;
  }

  public async synthesizeSpeech(text: string): Promise<SpeechStreamResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("Cannot synthesize empty text");
    }

    const startTime = Date.now();

    try {
      this.logger.debug(
        { textLength: text.length, preview: text.substring(0, 50) },
        "Synthesizing speech",
      );

      const response = await this.openaiClient.audio.speech.create({
        model: this.config.model!,
        voice: this.config.voice!,
        input: text,
        response_format: this.config.responseFormat as
          | "mp3"
          | "opus"
          | "aac"
          | "flac"
          | "wav"
          | "pcm",
      });

      // Stream the body as the provider generates it. Read it eagerly into a PassThrough so a
      // prefetched response that waits behind an earlier one is buffered here, not left
      // unread (fetch could collect and cancel an unread body).
      const audioStream = new PassThrough({ highWaterMark: 64 * 1024 * 1024 });
      const body = response.body;
      if (!body) {
        audioStream.end(Buffer.from(await response.arrayBuffer()));
      } else {
        void (async () => {
          try {
            for await (const chunk of Readable.fromWeb(body as never)) {
              audioStream.write(chunk);
            }
            audioStream.end();
          } catch (error) {
            audioStream.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      }

      const duration = Date.now() - startTime;
      this.logger.debug({ duration }, "Speech synthesis stream ready");

      return {
        stream: audioStream,
        format: this.config.responseFormat || "mp3",
      };
    } catch (error) {
      this.logger.error({ err: error }, "Speech synthesis error");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`TTS synthesis failed: ${message}`, { cause: error });
    }
  }
}
