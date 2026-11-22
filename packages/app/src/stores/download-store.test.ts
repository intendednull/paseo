import { beforeEach, describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import { i18n } from "@/i18n/i18next";
import {
  MAX_SESSION_DOWNLOAD_BYTES,
  useDownloadStore,
  type Download,
  type DownloadedBytes,
  type DownloadStreamSink,
  type OpenDownloadSinkResult,
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

  it("streams files larger than 64 MB directly to the sink with progress and no size cap", async () => {
    const TWO_GIB = 2 * 1024 * 1024 * 1024;
    const chunks = [new TextEncoder().encode("chunk-one-"), new TextEncoder().encode("chunk-two")];
    const written: Uint8Array[] = [];
    let closed = false;
    let aborted = false;
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
      requestFileDownloadToken: createTokenRequest(TWO_GIB).request,
      readFile: reader.read,
      streamFile: async (_path, streamSink) => {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
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
      shareFile: async (uri, mimeType, fileName) => {
        shared.push({ uri, mimeType, fileName });
      },
    });

    const { activeDownloadId, downloads } = useDownloadStore.getState();
    const download = activeDownloadId ? downloads.get(activeDownloadId) : undefined;
    expect(download).toMatchObject({ status: "complete" });
    expect(download?.progress?.percent).toBe(1);
    expect(written).toEqual(chunks);
    expect(closed).toBe(true);
    expect(aborted).toBe(false);
    expect(reader.requested).toEqual([]);
    expect(shared).toEqual([
      { uri: "file:///cache/big.apk", mimeType: MIME_TYPE, fileName: FILE_NAME },
    ]);
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
      requestFileDownloadToken: createTokenRequest(1024 * 1024 * 200).request,
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

  it("dismisses cleanly when the save-file picker is cancelled", async () => {
    let streamCalled = false;
    await useDownloadStore.getState().startDownload({
      serverId: "srv_remote",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      path: FILE_PATH,
      daemonProfile: profileWith([relayConnection]),
      activeConnectionId: relayConnection.id,
      requestFileDownloadToken: createTokenRequest(1024 * 1024 * 200).request,
      readFile: createFileReader(async () => ({ bytes: FILE_BYTES, size: FILE_BYTES.byteLength }))
        .read,
      streamFile: async () => {
        streamCalled = true;
        return { size: 0, bytesWritten: 0 };
      },
      openDownloadSink: (): OpenDownloadSinkResult => ({ kind: "cancelled" }),
    });

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
});
