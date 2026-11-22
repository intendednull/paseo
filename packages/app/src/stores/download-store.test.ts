import { beforeEach, describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import { i18n } from "@/i18n/i18next";
import {
  createNativeDownloadSink,
  createWebDownloadSink,
  MAX_SESSION_DOWNLOAD_BYTES,
  MAX_STREAM_DOWNLOAD_BYTES,
  openWebDownloadSink,
  pruneStaleNativeDownloads,
  sanitizeDownloadFileName,
  useDownloadStore,
  type Download,
  type DownloadedBytes,
  type DownloadStreamSink,
  type NativeDirectoryLike,
  type NativeDownloadFs,
  type NativeFileLike,
  type OpenDownloadSinkResult,
  type WebFilePickerHandle,
  type WebFileWritableStream,
  type WindowWithSaveFilePicker,
} from "@/stores/download-store";
import type {
  DirectTcpHostConnection,
  HostProfile,
  RelayHostConnection,
} from "@/types/host-connection";

const FILE_BYTES = new TextEncoder().encode("relay download payload");
const FILE_PATH = "reports/données été.bin";
const FILE_NAME = "données été.bin";
const MIME_TYPE = "application/octet-stream";

const relayConnection: RelayHostConnection = {
  id: "relay:relay.paseo.sh:443",
  type: "relay",
  relayEndpoint: "relay.paseo.sh:443",
  daemonPublicKeyB64: "cHVibGljLWtleQ==",
};

// The #3753 shape: the relay hostname stored as a directTcp entry that nothing can reach.
const staleTcpConnection: DirectTcpHostConnection = {
  id: "direct:relay.paseo.sh:443",
  type: "directTcp",
  endpoint: "relay.paseo.sh:443",
};

const localTcpConnection: DirectTcpHostConnection = {
  id: "direct:localhost:6767",
  type: "directTcp",
  endpoint: "localhost:6767",
};

function profileWith(connections: HostProfile["connections"]): HostProfile {
  return {
    serverId: "srv_remote",
    label: "Remote",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createTokenRequest(size: number | null = FILE_BYTES.byteLength) {
  const requested: string[] = [];
  return {
    requested,
    request: async (path: string) => {
      requested.push(path);
      return { token: "tok", fileName: FILE_NAME, mimeType: MIME_TYPE, size, error: null };
    },
  };
}

function createFileReader(read: () => Promise<{ bytes: Uint8Array; size: number }>) {
  const requested: string[] = [];
  return {
    requested,
    read: async (path: string) => {
      requested.push(path);
      return read();
    },
  };
}

function createFileSaver() {
  const savedFiles: DownloadedBytes[] = [];
  return {
    savedFiles,
    save: async (file: DownloadedBytes) => {
      savedFiles.push(file);
      return null;
    },
  };
}

interface StartInput {
  profile: HostProfile;
  activeConnectionId: string | null;
  token?: ReturnType<typeof createTokenRequest>;
  reader?: ReturnType<typeof createFileReader>;
  saver?: ReturnType<typeof createFileSaver>;
  fetchFile?: typeof fetch;
}

async function startDownload(input: StartInput): Promise<Download | undefined> {
  const token = input.token ?? createTokenRequest();
  const reader =
    input.reader ??
    createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }));
  const saver = input.saver ?? createFileSaver();
  await useDownloadStore.getState().startDownload({
    serverId: "srv_remote",
    scopeId: "workspace-1",
    fileName: FILE_NAME,
    path: FILE_PATH,
    daemonProfile: input.profile,
    activeConnectionId: input.activeConnectionId,
    requestFileDownloadToken: token.request,
    readFile: reader.read,
    saveFile: saver.save,
    fetchFile: input.fetchFile ?? (async () => new Response(FILE_BYTES)),
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  return activeDownloadId ? downloads.get(activeDownloadId) : undefined;
}

describe("download store transport selection", () => {
  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
  });

  it("downloads over the session when the active connection is the relay", async () => {
    const token = createTokenRequest();
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      token,
      reader,
      saver,
    });

    expect(download).toMatchObject({ fileName: FILE_NAME, status: "complete" });
    expect(token.requested).toEqual([FILE_PATH]);
    expect(reader.requested).toEqual([FILE_PATH]);
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);
  });

  it("bounds the session read even when the token reports a smaller file", async () => {
    const readRequests: Array<{ path: string; maxBytes: number }> = [];
    const saver = createFileSaver();
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      path: FILE_PATH,
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(1).request,
      readFile: async (path: string, maxBytes: number) => {
        readRequests.push({ path, maxBytes });
        return { bytes: FILE_BYTES, size: FILE_BYTES.byteLength };
      },
      saveFile: saver.save,
    });
    expect(readRequests).toEqual([{ path: FILE_PATH, maxBytes: MAX_SESSION_DOWNLOAD_BYTES }]);
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);
  });

  it("ignores a directTcp entry that is not the active connection", async () => {
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([staleTcpConnection, relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    expect(reader.requested).toEqual([FILE_PATH]);
    expect(saver.savedFiles).toHaveLength(1);
  });

  it("keeps the HTTP token download when the active connection is directTcp", async () => {
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([localTcpConnection, relayConnection]),
      activeConnectionId: localTcpConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "complete" });
    expect(reader.requested).toEqual([]);
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails with the HTTP status when a proxy in front of the host rejects the download", async () => {
    const requests: Array<RequestInit | undefined> = [];
    const download = await startDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async (_url, init) => {
        requests.push(init);
        return new Response("<h1>401 Authorization Required</h1>", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="Paseo"' },
        });
      },
    });

    expect(download).toMatchObject({
      status: "error",
      message: i18n.t("downloads.httpFailed", { status: 401 }),
    });
    expect(requests).toEqual([{ credentials: "include", redirect: "error" }]);
  });

  it("fails with a readable message when the download request cannot reach the host", async () => {
    const download = await startDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    expect(download).toMatchObject({ status: "error", message: i18n.t("downloads.failed") });
  });

  it("fails with a readable message when the connection drops while the file is downloading", async () => {
    const saver = createFileSaver();
    const download = await startDownload({
      profile: profileWith([localTcpConnection]),
      activeConnectionId: localTcpConnection.id,
      fetchFile: async () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.error(new TypeError("network error")),
          }),
        ),
      saver,
    });

    expect(download).toMatchObject({ status: "error", message: i18n.t("downloads.failed") });
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails the download and saves nothing when the session read fails", async () => {
    const reader = createFileReader(async () => {
      throw new Error("Connection lost");
    });
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({ status: "error", message: "Connection lost" });
    expect(saver.savedFiles).toEqual([]);
  });

  it("refuses a file over the session size limit before reading it", async () => {
    const token = createTokenRequest(MAX_SESSION_DOWNLOAD_BYTES + 1);
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      token,
      reader,
      saver,
    });

    expect(download).toMatchObject({
      status: "error",
      message: i18n.t("composer.errors.fileTooLarge", { fileName: FILE_NAME, size: "64 MB" }),
    });
    expect(download?.message).toContain("64 MB");
    expect(reader.requested).toEqual([]);
    expect(saver.savedFiles).toEqual([]);
  });

  it("fails instead of saving an empty file when the daemon returns no content", async () => {
    const reader = createFileReader(async () => ({ bytes: new Uint8Array(), size: 6 }));
    const saver = createFileSaver();

    const download = await startDownload({
      profile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      reader,
      saver,
    });

    expect(download).toMatchObject({
      status: "error",
      message: "File transfer incomplete: expected 6 bytes, received 0.",
    });
    expect(saver.savedFiles).toEqual([]);
  });

  it("streams files larger than 64 MB directly to the sink with progress and bound size", async () => {
    const TWO_GIB = 2 * 1024 * 1024 * 1024;
    const chunks = [new TextEncoder().encode("chunk-one-"), new TextEncoder().encode("chunk-two")];
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const written: Uint8Array[] = [];
    let closed = false;
    let aborted = false;
    const seenOptions: Array<{ maxBytes?: number; expectedSize?: number }> = [];
    const shared: Array<{ uri: string; mimeType: string | null; fileName: string }> = [];
    const sink: DownloadStreamSink = {
      uri: "file:///cache/big.apk",
      write: (chunk) => written.push(chunk),
      close: () => {
        closed = true;
      },
      abort: () => {
        aborted = true;
      },
    };
    const reader = createFileReader(async () => {
      throw new Error("buffered readFile should not be called when streaming");
    });

    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "big.apk",
      path: "artifacts/big.apk",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(total).request,
      readFile: reader.read,
      streamFile: async (_path, streamSink, options) => {
        seenOptions.push({ maxBytes: options?.maxBytes, expectedSize: options?.expectedSize });
        streamSink.onBegin?.({
          mime: MIME_TYPE,
          size: total,
          encoding: "binary",
          modifiedAt: "2026-11-22T00:00:00.000Z",
        });
        for (const chunk of chunks) {
          streamSink.onChunk(chunk);
        }
        return { size: total, bytesWritten: total };
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({ kind: "sink", sink }),
      getAvailableDiskBytes: () => TWO_GIB * 2,
      shareFile: async (uri, mimeType, fileName) => {
        shared.push({ uri, mimeType, fileName });
      },
    });

    const { activeDownloadId, downloads } = useDownloadStore.getState();
    const download = activeDownloadId ? downloads.get(activeDownloadId) : undefined;
    expect(download).toMatchObject({ status: "complete" });
    expect(download?.progress?.percent).toBe(1);
    expect(seenOptions).toEqual([{ maxBytes: total, expectedSize: total }]);
    expect(written).toEqual(chunks);
    expect(closed).toBe(true);
    expect(aborted).toBe(false);
    expect(reader.requested).toEqual([]);
    expect(shared).toEqual([
      { uri: "file:///cache/big.apk", mimeType: MIME_TYPE, fileName: FILE_NAME },
    ]);

    // Verify a multi-GB token (> 64 MiB and <= MAX_STREAM_DOWNLOAD_BYTES) passes the budget gate.
    let bigExpectedSize: number | undefined;
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "multi-gb.img",
      path: "artifacts/multi-gb.img",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(TWO_GIB).request,
      readFile: reader.read,
      streamFile: async (_path, _sink, options) => {
        bigExpectedSize = options?.expectedSize;
        throw new Error("stop after budget check");
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({
        kind: "sink",
        sink: { uri: null, write: () => {}, close: () => {}, abort: () => {} },
      }),
      getAvailableDiskBytes: () => TWO_GIB * 2,
    });
    expect(bigExpectedSize).toBe(TWO_GIB);
  });

  it("aborts and cleans up the stream sink when streaming fails mid-transfer", async () => {
    let closed = false;
    let aborted = false;
    const sink: DownloadStreamSink = {
      uri: "file:///cache/partial.apk",
      write: () => {},
      close: () => {
        closed = true;
      },
      abort: () => {
        aborted = true;
      },
    };

    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "partial.apk",
      path: "artifacts/partial.apk",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(100).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async (_path, streamSink) => {
        streamSink.onBegin?.({
          mime: MIME_TYPE,
          size: 100,
          encoding: "binary",
          modifiedAt: "2026-11-22T00:00:00.000Z",
        });
        streamSink.onChunk(FILE_BYTES);
        throw new Error("Connection lost");
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({ kind: "sink", sink }),
    });

    const { activeDownloadId, downloads } = useDownloadStore.getState();
    const download = activeDownloadId ? downloads.get(activeDownloadId) : undefined;
    expect(download).toMatchObject({ status: "error", message: "Connection lost" });
    expect(closed).toBe(false);
    expect(aborted).toBe(true);
  });

  it("dismisses cleanly when the save-file picker is cancelled without hitting the daemon", async () => {
    let tokenRequested = false;
    let streamCalled = false;
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      path: FILE_PATH,
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: async () => {
        tokenRequested = true;
        return { token: "tok", fileName: FILE_NAME, mimeType: MIME_TYPE, size: 10, error: null };
      },
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async () => {
        streamCalled = true;
        return { size: 0, bytesWritten: 0 };
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({ kind: "cancelled" }),
    });

    expect(tokenRequested).toBe(false);
    expect(streamCalled).toBe(false);
    expect(useDownloadStore.getState().downloads.size).toBe(0);
  });

  it("falls back to buffered readFile when no streaming sink is available", async () => {
    const reader = createFileReader(async () => ({
      bytes: FILE_BYTES,
      size: FILE_BYTES.byteLength,
    }));
    const saver = createFileSaver();

    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      path: FILE_PATH,
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest().request,
      readFile: reader.read,
      streamFile: async () => {
        throw new Error("streamFile should not run when sink is unavailable");
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({ kind: "unavailable" }),
      saveFile: saver.save,
    });

    const { activeDownloadId, downloads } = useDownloadStore.getState();
    const download = activeDownloadId ? downloads.get(activeDownloadId) : undefined;
    expect(download).toMatchObject({ status: "complete" });
    expect(reader.requested).toEqual([FILE_PATH]);
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, fileName: FILE_NAME, mimeType: MIME_TYPE },
    ]);
  });

  it("invokes showSaveFilePicker with window receiver synchronously during user activation before token RPC", async () => {
    const events: string[] = [];
    let userActivationActive = true;
    const written: Uint8Array[] = [];
    let writableClosed = false;

    const fakeWritable: WebFileWritableStream = {
      write: async (chunk) => {
        written.push(new Uint8Array(chunk));
      },
      close: async () => {
        writableClosed = true;
      },
      abort: async () => {},
    };
    const fakeHandle: WebFilePickerHandle = {
      createWritable: async () => {
        events.push("createWritable");
        return fakeWritable;
      },
    };
    const fakeWindow: WindowWithSaveFilePicker = {
      showSaveFilePicker(this: unknown, options?: { suggestedName?: string }) {
        // Must preserve window as receiver (not detached) and run synchronously while activation is fresh.
        expect(this).toBe(fakeWindow);
        expect(userActivationActive).toBe(true);
        expect(options?.suggestedName).toBe("archive.bin");
        events.push("showSaveFilePicker");
        return Promise.resolve(fakeHandle);
      },
    };

    const downloadPromise = useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "../archive.bin",
      path: "artifacts/archive.bin",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: async () => {
        events.push("requestToken");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          token: "tok",
          fileName: "archive.bin",
          mimeType: MIME_TYPE,
          size: FILE_BYTES.byteLength,
          error: null,
        };
      },
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async (_path, sink) => {
        events.push("streamFile");
        sink.onBegin?.({
          mime: MIME_TYPE,
          size: FILE_BYTES.byteLength,
          encoding: "binary",
          modifiedAt: "2026-11-22T00:00:00.000Z",
        });
        sink.onChunk(FILE_BYTES);
        return { size: FILE_BYTES.byteLength, bytesWritten: FILE_BYTES.byteLength };
      },
      openDownloadSink: (name) => openWebDownloadSink(fakeWindow, name),
    });

    // User activation expires immediately after the synchronous click handler returns.
    userActivationActive = false;
    await downloadPromise;

    expect(events).toEqual(["showSaveFilePicker", "requestToken", "createWritable", "streamFile"]);
    expect(writableClosed).toBe(true);
    expect(written).toEqual([FILE_BYTES]);
    const { activeDownloadId, downloads } = useDownloadStore.getState();
    expect(activeDownloadId ? downloads.get(activeDownloadId)?.status : undefined).toBe("complete");
  });

  it("rejects token size mismatches, excessive budgets, and insufficient disk space before writing", async () => {
    // 1. Exceeds MAX_STREAM_DOWNLOAD_BYTES
    let sinkAborted = false;
    let streamCalled = false;
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "huge.bin",
      path: "huge.bin",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(MAX_STREAM_DOWNLOAD_BYTES + 1).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async () => {
        streamCalled = true;
        return { size: 0, bytesWritten: 0 };
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({
        kind: "sink",
        sink: {
          uri: null,
          write: () => {},
          close: () => {},
          abort: () => {
            sinkAborted = true;
          },
        },
      }),
    });
    expect(streamCalled).toBe(false);
    expect(sinkAborted).toBe(true);
    let active = useDownloadStore.getState().activeDownloadId;
    expect(active ? useDownloadStore.getState().downloads.get(active)?.status : null).toBe("error");

    // 2. Insufficient free disk space (after reserve)
    sinkAborted = false;
    streamCalled = false;
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "tight.bin",
      path: "tight.bin",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(100 * 1024 * 1024).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async () => {
        streamCalled = true;
        return { size: 0, bytesWritten: 0 };
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({
        kind: "sink",
        sink: {
          uri: null,
          write: () => {},
          close: () => {},
          abort: () => {
            sinkAborted = true;
          },
        },
      }),
      diskReserveBytes: 256 * 1024 * 1024,
      getAvailableDiskBytes: () => 300 * 1024 * 1024, // Only 44 MiB left after 256 MiB reserve
    });
    expect(streamCalled).toBe(false);
    expect(sinkAborted).toBe(true);
    active = useDownloadStore.getState().activeDownloadId;
    expect(active ? useDownloadStore.getState().downloads.get(active)?.message : "").toContain(
      "Not enough free disk space",
    );

    // 3. FileBegin size mismatch against token metadata rejected before any write
    let wroteAny = false;
    sinkAborted = false;
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "mismatch.bin",
      path: "mismatch.bin",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(50).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async (_path, sink) => {
        sink.onBegin?.({
          mime: MIME_TYPE,
          size: 99,
          encoding: "binary",
          modifiedAt: "2026-11-22T00:00:00.000Z",
        });
        sink.onChunk(FILE_BYTES);
        return { size: 99, bytesWritten: FILE_BYTES.byteLength };
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({
        kind: "sink",
        sink: {
          uri: null,
          write: () => {
            wroteAny = true;
          },
          close: () => {},
          abort: () => {
            sinkAborted = true;
          },
        },
      }),
    });
    expect(wroteAny).toBe(false);
    expect(sinkAborted).toBe(true);
    active = useDownloadStore.getState().activeDownloadId;
    expect(active ? useDownloadStore.getState().downloads.get(active)?.message : "").toContain(
      "File size mismatch",
    );
  });

  it("cancels an in-flight streamed download via cancelDownload and aborts its sink", async () => {
    let sinkAborted = false;
    let streamAborted = false;
    let markStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });

    const downloadPromise = useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "slow.bin",
      path: "slow.bin",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(1000).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: (_path, _sink, options) =>
        new Promise((_resolve, reject) => {
          markStreamStarted();
          options?.signal?.addEventListener("abort", () => {
            streamAborted = true;
            reject(new Error("Download cancelled"));
          });
        }),
      openDownloadSink: (): OpenDownloadSinkResult => ({
        kind: "sink",
        sink: {
          uri: "file:///cache/slow.bin",
          write: () => {},
          close: () => {},
          abort: () => {
            sinkAborted = true;
          },
        },
      }),
    });

    await streamStarted;

    const activeId = useDownloadStore.getState().activeDownloadId;
    expect(activeId).not.toBeNull();
    useDownloadStore.getState().cancelDownload(activeId!);
    await downloadPromise;

    expect(streamAborted).toBe(true);
    expect(sinkAborted).toBe(true);
    expect(useDownloadStore.getState().downloads.size).toBe(0);
  });

  it("cancelling after FileEnd while the web sink is draining aborts without committing", async () => {
    const firstWriteGate: { release: (() => void) | null } = { release: null };
    let markFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve;
    });
    let writableClosed = false;
    let writableAborted = false;
    const writesStarted: number[] = [];

    const writable: WebFileWritableStream = {
      write: (chunk) => {
        writesStarted.push(chunk.byteLength);
        if (writesStarted.length === 1) {
          return new Promise<void>((resolve) => {
            firstWriteGate.release = resolve;
            markFirstWriteStarted();
          });
        }
        return Promise.resolve();
      },
      close: async () => {
        writableClosed = true;
      },
      abort: async () => {
        writableAborted = true;
      },
    };
    const webSink = createWebDownloadSink({ createWritable: async () => writable });

    const downloadPromise = useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "draining.bin",
      path: "draining.bin",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(6).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async (_path, sink) => {
        sink.onBegin?.({
          mime: MIME_TYPE,
          size: 6,
          encoding: "binary",
          modifiedAt: "2026-11-22T00:00:00.000Z",
        });
        sink.onChunk(new Uint8Array([1, 2, 3]));
        sink.onChunk(new Uint8Array([4, 5, 6]));
        // Network FileEnd returns immediately while chunk 1 is still writing and chunk 2 is queued.
        return { size: 6, bytesWritten: 6 };
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({ kind: "sink", sink: webSink }),
    });

    await firstWriteStarted;
    const activeId = useDownloadStore.getState().activeDownloadId;
    expect(activeId).not.toBeNull();
    useDownloadStore.getState().cancelDownload(activeId!);
    firstWriteGate.release?.();
    await downloadPromise;

    expect(writableAborted).toBe(true);
    expect(writableClosed).toBe(false);
    expect(writesStarted).toEqual([3]);
  });

  it("reserves disk space across concurrent downloads sharing the same free-space snapshot", async () => {
    const MIB = 1024 * 1024;
    const firstStreamGate: { release: (() => void) | null } = { release: null };
    let markFirstStreamStarted!: () => void;
    const firstStreamStarted = new Promise<void>((resolve) => {
      markFirstStreamStarted = resolve;
    });
    let secondStreamStarted = false;

    // 400 MiB free - 256 MiB reserve = 144 MiB available. Two 100 MiB downloads must not both admit.
    const freeBytes = () => 400 * MIB;

    const firstPromise = useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "first.bin",
      path: "first.bin",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(100 * MIB).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: (_path, _sink) =>
        new Promise((_resolve, reject) => {
          firstStreamGate.release = () => reject(new Error("done"));
          markFirstStreamStarted();
        }),
      openDownloadSink: (): OpenDownloadSinkResult => ({
        kind: "sink",
        sink: { uri: null, write: () => {}, close: () => {}, abort: () => {} },
      }),
      diskReserveBytes: 256 * MIB,
      getAvailableDiskBytes: freeBytes,
    });

    await firstStreamStarted;

    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "second.bin",
      path: "second.bin",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(100 * MIB).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async () => {
        secondStreamStarted = true;
        return { size: 0, bytesWritten: 0 };
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({
        kind: "sink",
        sink: { uri: null, write: () => {}, close: () => {}, abort: () => {} },
      }),
      diskReserveBytes: 256 * MIB,
      getAvailableDiskBytes: freeBytes,
    });

    expect(secondStreamStarted).toBe(false);
    const secondDownload = Array.from(useDownloadStore.getState().downloads.values()).find(
      (d) => d.fileName === "second.bin",
    );
    expect(secondDownload?.status).toBe("error");
    expect(secondDownload?.message).toContain("Not enough free disk space");

    // Once the first download finishes and releases its reservation, a third 100 MiB download is admitted.
    firstStreamGate.release?.();
    await firstPromise;

    let thirdStreamStarted = false;
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "third.bin",
      path: "third.bin",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(100 * MIB).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async () => {
        thirdStreamStarted = true;
        throw new Error("stop after admit");
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({
        kind: "sink",
        sink: { uri: null, write: () => {}, close: () => {}, abort: () => {} },
      }),
      diskReserveBytes: 256 * MIB,
      getAvailableDiskBytes: freeBytes,
    });
    expect(thirdStreamStarted).toBe(true);
  });
});

describe("web download sink backpressure and cleanup", () => {
  it("caps active chunk count and wraps its ring buffer cleanly across steady-state lag", async () => {
    const written: number[] = [];
    const resolvers: Array<() => void> = [];
    const writable: WebFileWritableStream = {
      write: (chunk) => {
        written.push(chunk[0] ?? -1);
        return new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      },
      close: async () => {},
      abort: async () => {},
    };
    const sink = createWebDownloadSink(
      { createWritable: async () => writable },
      { maxPendingBytes: 1024, maxPendingChunks: 3 },
    );
    await sink.prepare?.();

    // Steady-state 1-chunk lag over 10 writes (> capacity 3) wraps around the ring cleanly.
    sink.write(new Uint8Array([0]));
    for (let i = 1; i < 10; i += 1) {
      sink.write(new Uint8Array([i]));
      resolvers.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    resolvers.shift()?.();
    await sink.close();
    expect(written).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Tiny 1-byte chunks hitting maxPendingChunks (even far under maxPendingBytes) are rejected.
    const capSink = createWebDownloadSink(
      {
        createWritable: async () => ({
          write: () => new Promise<void>(() => {}),
          close: async () => {},
          abort: async () => {},
        }),
      },
      { maxPendingBytes: 1024, maxPendingChunks: 2 },
    );
    await capSink.prepare?.();
    capSink.write(new Uint8Array([1]));
    capSink.write(new Uint8Array([2]));
    expect(() => capSink.write(new Uint8Array([3]))).toThrow(
      "Download write queue exceeded 2 pending chunks",
    );
    await capSink.abort();
  });
  it("bounds pending bytes on slow disk, aborts promptly without running queued writes", async () => {
    const writesStarted: number[] = [];
    const firstWriteGate: { release: (() => void) | null } = { release: null };
    let abortedCount = 0;

    const writable: WebFileWritableStream = {
      write: (chunk) => {
        writesStarted.push(chunk.byteLength);
        if (writesStarted.length === 1) {
          return new Promise<void>((resolve) => {
            firstWriteGate.release = resolve;
          });
        }
        return Promise.resolve();
      },
      close: async () => {},
      abort: async () => {
        abortedCount += 1;
      },
    };
    const sink = createWebDownloadSink(
      { createWritable: async () => writable },
      { maxPendingBytes: 10 },
    );
    const errors: Error[] = [];
    sink.setErrorHandler?.((err) => errors.push(err));
    await sink.prepare?.();

    sink.write(new Uint8Array(6)); // in-flight (6 bytes pending)
    sink.write(new Uint8Array(4)); // queued (10 bytes pending)
    expect(() => sink.write(new Uint8Array(1))).toThrow("Download write buffer exceeded 10 bytes");
    expect(errors).toHaveLength(1);

    // Abort must not wait for the slow first write or start the queued second write.
    await sink.abort();
    expect(abortedCount).toBe(1);
    firstWriteGate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writesStarted).toEqual([6]);
  });

  it("stops queued writes and notifies error handler when writable.write rejects", async () => {
    const writesStarted: number[] = [];
    const firstWriteGate: { reject: ((err: Error) => void) | null } = { reject: null };
    let aborted = false;

    const writable: WebFileWritableStream = {
      write: (chunk) => {
        writesStarted.push(chunk.byteLength);
        if (writesStarted.length === 1) {
          return new Promise<void>((_resolve, reject) => {
            firstWriteGate.reject = reject;
          });
        }
        return Promise.resolve();
      },
      close: async () => {},
      abort: async () => {
        aborted = true;
      },
    };
    const sink = createWebDownloadSink(
      { createWritable: async () => writable },
      { maxPendingBytes: 100 },
    );
    const errors: Error[] = [];
    sink.setErrorHandler?.((err) => errors.push(err));
    await sink.prepare?.();

    sink.write(new Uint8Array(5));
    sink.write(new Uint8Array(6));
    sink.write(new Uint8Array(7));

    firstWriteGate.reject?.(new Error("disk write failed"));
    await expect(sink.close()).rejects.toThrow("disk write failed");
    await sink.abort();

    expect(writesStarted).toEqual([5]);
    expect(errors.map((e) => e.message)).toEqual(["disk write failed"]);
    expect(aborted).toBe(true);
  });

  it("still calls writable.abort when writable.close rejects", async () => {
    let aborted = false;
    const writable: WebFileWritableStream = {
      write: async () => {},
      close: async () => {
        throw new Error("flush failed on close");
      },
      abort: async () => {
        aborted = true;
      },
    };
    const sink = createWebDownloadSink({ createWritable: async () => writable });
    await sink.prepare?.();
    sink.write(new Uint8Array(4));

    await expect(sink.close()).rejects.toThrow("flush failed on close");
    await sink.abort();
    expect(aborted).toBe(true);
  });
});

describe("native download sink safety and cache retention", () => {
  it("sanitizes dot segments, path separators, control characters, and overlong names", () => {
    expect(sanitizeDownloadFileName(".")).toBe("download");
    expect(sanitizeDownloadFileName("..")).toBe("download");
    expect(sanitizeDownloadFileName("...")).toBe("download");
    expect(sanitizeDownloadFileName("  \x00\n\t  ")).toBe("download");
    expect(sanitizeDownloadFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadFileName("a/b/..")).toBe("download");
    expect(sanitizeDownloadFileName("foo\\bar\\baz.txt")).toBe("baz.txt");
    expect(sanitizeDownloadFileName("report\x00\r\n\u202e.pdf")).toBe("report.pdf");
    expect(sanitizeDownloadFileName(".hidden.")).toBe("hidden");
    const longName = `${"a".repeat(250)}.apk`;
    const sanitized = sanitizeDownloadFileName(longName);
    expect(sanitized.length).toBeLessThanOrEqual(180);
    expect(sanitized.endsWith(".apk")).toBe(true);
  });

  it("creates privately scoped files exclusively, cleans up owned files on open failure, and never deletes unowned files", () => {
    const dirs = new Map<string, { exists: boolean; modTime: number }>();
    const files = new Map<string, { exists: boolean; data: Uint8Array[] }>();
    const deletedUris: string[] = [];
    const activeDirs = new Set<string>();
    let failOnOpen = false;
    let failOnCreateFile = false;

    const makeDir = (uri: string): NativeDirectoryLike => ({
      uri,
      get exists() {
        return dirs.get(uri)?.exists ?? false;
      },
      create: (opts) => {
        const existing = dirs.get(uri)?.exists ?? false;
        if (existing && !opts?.idempotent && !opts?.overwrite) {
          throw new Error(`Directory exists: ${uri}`);
        }
        dirs.set(uri, { exists: true, modTime: Date.now() });
      },
      list: () => {
        const prefix = uri.endsWith("/") ? uri : `${uri}/`;
        return Array.from(dirs.entries())
          .filter(
            ([k, v]) => v.exists && k.startsWith(prefix) && !k.slice(prefix.length).includes("/"),
          )
          .map(([k]) => makeDir(k));
      },
      info: () => ({ modificationTime: dirs.get(uri)?.modTime }),
      delete: () => {
        deletedUris.push(uri);
        dirs.delete(uri);
      },
    });

    const makeFile = (uri: string): NativeFileLike => ({
      uri,
      get exists() {
        return files.get(uri)?.exists ?? false;
      },
      create: (opts) => {
        expect(opts?.overwrite).toBe(false);
        if (failOnCreateFile || files.get(uri)?.exists) {
          throw new Error(`File already exists: ${uri}`);
        }
        files.set(uri, { exists: true, data: [] });
      },
      open: () => {
        if (failOnOpen) {
          throw new Error("EMFILE: too many open files");
        }
        return {
          writeBytes: (chunk) => {
            files.get(uri)?.data.push(new Uint8Array(chunk));
          },
          close: () => {},
        };
      },
      delete: () => {
        deletedUris.push(uri);
        files.delete(uri);
      },
    });

    const baseUri = "file:///cache";
    dirs.set(baseUri, { exists: true, modTime: 0 });

    let nextId = 1;
    const fs: NativeDownloadFs = {
      getBaseDirectory: () => makeDir(baseUri),
      createDirectory: (parent, name) => makeDir(`${parent.uri}/${name}`),
      createFile: (parent, name) => makeFile(`${parent.uri}/${name}`),
      isDirectory: (entry): entry is NativeDirectoryLike => "list" in entry,
      generateDirName: () => `dl-test-${nextId++}`,
      activeDirs,
    };

    // 1. Open failure cleans up the newly created file and private directory.
    failOnOpen = true;
    expect(() => createNativeDownloadSink("app.apk", fs)).toThrow("EMFILE");
    expect(deletedUris).toEqual([
      "file:///cache/paseo-downloads/dl-test-1/app.apk",
      "file:///cache/paseo-downloads/dl-test-1",
    ]);
    expect(activeDirs.size).toBe(0);

    // 2. Pre-existing file causing create({ overwrite: false }) failure is NEVER deleted.
    failOnOpen = false;
    failOnCreateFile = true;
    deletedUris.length = 0;
    const preExistingUri = "file:///cache/paseo-downloads/dl-test-2/existing.bin";
    files.set(preExistingUri, { exists: true, data: [] });
    expect(() => createNativeDownloadSink("existing.bin", fs)).toThrow("File already exists");
    expect(deletedUris).toEqual(["file:///cache/paseo-downloads/dl-test-2"]);
    expect(files.has(preExistingUri)).toBe(true);

    // 3. Normal write + close leaves file for share sheet and releases active lock; stale pruning reclaims old dirs.
    failOnCreateFile = false;
    deletedUris.length = 0;
    const sink = createNativeDownloadSink("ok.bin", fs);
    expect(sink.uri).toBe("file:///cache/paseo-downloads/dl-test-3/ok.bin");
    expect(activeDirs.has("dl-test-3")).toBe(true);
    sink.write(new TextEncoder().encode("abc"));
    sink.close();
    // Directory stays protected until post-share release runs.
    expect(activeDirs.has("dl-test-3")).toBe(true);
    sink.release?.();
    expect(activeDirs.has("dl-test-3")).toBe(false);

    // Add an active dir and verify stale pruning removes only expired inactive dirs.
    const activeSink = createNativeDownloadSink("active.bin", fs);
    dirs.set("file:///cache/paseo-downloads/dl-test-3", { exists: true, modTime: 1000 });
    dirs.set("file:///cache/paseo-downloads/dl-test-4", { exists: true, modTime: 1000 });
    pruneStaleNativeDownloads(fs, { now: Date.now() + 60_000, ttlMs: 10_000 });
    expect(dirs.has("file:///cache/paseo-downloads/dl-test-3")).toBe(false);
    expect(dirs.has("file:///cache/paseo-downloads/dl-test-4")).toBe(true);
    activeSink.abort();

    // 4. Confined URI check rejects escaping targets before creating files.
    const escapingFs: NativeDownloadFs = {
      ...fs,
      createFile: () => makeFile("file:///outside/escape.bin"),
    };
    expect(() => createNativeDownloadSink("escape.bin", escapingFs)).toThrow(
      "Refusing to write download outside private cache directory.",
    );
  });

  it("protects a long-running native download through share handoff and measures retention from completion/child mtime", async () => {
    const MIN = 60 * 1000;
    const TTL = 15 * MIN;
    let fakeNow = 1_000_000;

    const dirs = new Map<string, { exists: boolean; modTime: number }>();
    const files = new Map<string, { exists: boolean; modTime: number }>();
    const activeDirs = new Set<string>();
    const completedTimes = new Map<string, number>();

    const makeFile = (uri: string): NativeFileLike => ({
      uri,
      get exists() {
        return files.get(uri)?.exists ?? false;
      },
      create: () => {
        files.set(uri, { exists: true, modTime: fakeNow });
      },
      open: () => ({
        writeBytes: () => {
          // Writing file contents updates child file mtime, NOT the parent directory mtime.
          files.set(uri, { exists: true, modTime: fakeNow });
        },
        close: () => {},
      }),
      info: () => ({ modificationTime: files.get(uri)?.modTime }),
      delete: () => {
        files.delete(uri);
      },
    });

    const makeDir = (uri: string): NativeDirectoryLike => ({
      uri,
      get exists() {
        return dirs.get(uri)?.exists ?? false;
      },
      create: () => {
        dirs.set(uri, { exists: true, modTime: fakeNow });
      },
      list: () => {
        const prefix = uri.endsWith("/") ? uri : `${uri}/`;
        const childDirs = Array.from(dirs.entries())
          .filter(
            ([k, v]) => v.exists && k.startsWith(prefix) && !k.slice(prefix.length).includes("/"),
          )
          .map(([k]) => makeDir(k));
        const childFiles = Array.from(files.entries())
          .filter(
            ([k, v]) => v.exists && k.startsWith(prefix) && !k.slice(prefix.length).includes("/"),
          )
          .map(([k]) => makeFile(k));
        return [...childDirs, ...childFiles];
      },
      info: () => ({ modificationTime: dirs.get(uri)?.modTime }),
      delete: () => {
        dirs.delete(uri);
        const prefix = uri.endsWith("/") ? uri : `${uri}/`;
        for (const key of Array.from(files.keys())) {
          if (key.startsWith(prefix)) {
            files.delete(key);
          }
        }
      },
    });

    const baseUri = "file:///cache";
    dirs.set(baseUri, { exists: true, modTime: fakeNow });

    const fs: NativeDownloadFs = {
      getBaseDirectory: () => makeDir(baseUri),
      createDirectory: (parent, name) => makeDir(`${parent.uri}/${name}`),
      createFile: (parent, name) => makeFile(`${parent.uri}/${name}`),
      isDirectory: (entry): entry is NativeDirectoryLike => "list" in entry,
      generateDirName: () => "dl-long-transfer",
      activeDirs,
      completedTimes,
      now: () => fakeNow,
    };

    const dirUri = "file:///cache/paseo-downloads/dl-long-transfer";
    let dirExistedDuringShare = false;

    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: "huge.apk",
      path: "artifacts/huge.apk",
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(FILE_BYTES.byteLength).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      openDownloadSink: (name): OpenDownloadSinkResult => ({
        kind: "sink",
        sink: createNativeDownloadSink(name, fs),
      }),
      streamFile: async (_path, sink) => {
        sink.onBegin?.({
          mime: MIME_TYPE,
          size: FILE_BYTES.byteLength,
          encoding: "binary",
          modifiedAt: "2026-11-22T00:00:00.000Z",
        });
        // Simulate a 20-minute transfer (> 15-minute TTL) so dir creation mtime is already stale.
        fakeNow += 20 * MIN;
        sink.onChunk(FILE_BYTES);
        return { size: FILE_BYTES.byteLength, bytesWritten: FILE_BYTES.byteLength };
      },
      shareFile: async () => {
        // Concurrent download / toast dismissal triggers pruning while share sheet is open.
        pruneStaleNativeDownloads(fs, { now: fakeNow, ttlMs: TTL });
        dirExistedDuringShare = dirs.has(dirUri);
      },
    });

    // Protected throughout the share handoff despite 20-minute-old dir creation time.
    expect(dirExistedDuringShare).toBe(true);
    expect(dirs.has(dirUri)).toBe(true);
    expect(activeDirs.has("dl-long-transfer")).toBe(false);

    // 5 minutes after share handoff: still within 15-minute retention window (both in-memory and cold-restart).
    pruneStaleNativeDownloads(fs, { now: fakeNow + 5 * MIN, ttlMs: TTL });
    expect(dirs.has(dirUri)).toBe(true);

    // Cold-restart simulation (empty in-memory completion map): child file mtime still protects it.
    completedTimes.clear();
    pruneStaleNativeDownloads(fs, { now: fakeNow + 5 * MIN, ttlMs: TTL });
    expect(dirs.has(dirUri)).toBe(true);

    // 16 minutes after completion: past TTL from both completion and child mtime -> pruned cleanly.
    pruneStaleNativeDownloads(fs, { now: fakeNow + 16 * MIN, ttlMs: TTL });
    expect(dirs.has(dirUri)).toBe(false);
  });

  it("marks download as error instead of stranding toast when directTcp endpoint has malformed auth", async () => {
    const badAuthTcpConnection: DirectTcpHostConnection = {
      id: "direct:bad-auth",
      type: "directTcp",
      endpoint: "user:日本語@localhost:6767",
    };

    const download = await startDownload({
      profile: profileWith([badAuthTcpConnection]),
      activeConnectionId: badAuthTcpConnection.id,
    });

    expect(download?.status).toBe("error");
    expect(download?.message).toBeTruthy();
  });
});
