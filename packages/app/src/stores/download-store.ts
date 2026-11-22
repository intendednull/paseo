import { create } from "zustand";
import { File as FSFile, FileMode, Paths } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { FileStreamSink } from "@getpaseo/client/internal/daemon-client";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

interface DownloadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

// Buffered session fallback limit (used only when streaming directly to disk is unavailable,
// such as browsers without showSaveFilePicker or callers that only supply readFile).
export const MAX_SESSION_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const STREAM_PROGRESS_INTERVAL_MS = 150;

export interface DownloadStreamSink {
  /** Local file URI to hand to the native share sheet after completion; `null` on web. */
  readonly uri: string | null;
  write: (chunk: Uint8Array) => void;
  close: () => Promise<void> | void;
  abort: () => Promise<void> | void;
}

export type OpenDownloadSinkResult =
  | { kind: "sink"; sink: DownloadStreamSink }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

export interface DownloadedBytes {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string | null;
}

export interface Download {
  id: string;
  serverId: string;
  scopeId: string;
  fileName: string;
  status: "downloading" | "complete" | "error";
  message?: string;
  progress?: DownloadProgress;
  startedAt: number;
}

interface DownloadState {
  downloads: Map<string, Download>;
  activeDownloadId: string | null;

  startDownload: (params: {
    serverId: string;
    scopeId: string;
    fileName: string;
    path: string;
    daemonProfile: HostProfile | undefined;
    /** Connection the host runtime is using right now; `null` while disconnected. */
    activeConnectionId: string | null;
    requestFileDownloadToken: (path: string) => Promise<{
      token: string | null;
      fileName: string | null;
      mimeType: string | null;
      size: number | null;
      error: string | null;
    }>;
    /** Reads the whole file over the session socket; used as buffered fallback when streaming to disk is unavailable. */
    readFile: (path: string, maxBytes: number) => Promise<{ bytes: Uint8Array; size: number }>;
    /** Streams the file chunk-by-chunk over the session socket with O(1) memory and no size cap. */
    streamFile?: (
      path: string,
      sink: FileStreamSink,
      maxBytes?: number,
    ) => Promise<{ size: number; bytesWritten: number }>;
    openDownloadSink?: (
      fileName: string,
    ) => Promise<OpenDownloadSinkResult> | OpenDownloadSinkResult;
    shareFile?: typeof shareSavedFile;
    saveFile?: typeof saveDownloadedBytes;
    fetchFile?: typeof fetch;
  }) => Promise<void>;

  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string) => void;
  failDownload: (id: string, message: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

function generateDownloadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useDownloadStore = create<DownloadState>()((set, get) => ({
  downloads: new Map(),
  activeDownloadId: null,

  startDownload: async ({
    serverId,
    scopeId,
    fileName,
    path,
    daemonProfile,
    activeConnectionId,
    requestFileDownloadToken,
    readFile,
    streamFile,
    openDownloadSink = defaultOpenDownloadSink,
    shareFile = shareSavedFile,
    saveFile = saveDownloadedBytes,
    fetchFile = fetch,
  }) => {
    const id = generateDownloadId();
    const download: Download = {
      id,
      serverId,
      scopeId,
      fileName,
      status: "downloading",
      startedAt: Date.now(),
    };

    set((state) => ({
      downloads: new Map(state.downloads).set(id, download),
      activeDownloadId: id,
    }));

    try {
      const tokenResponse = await requestFileDownloadToken(path);
      if (tokenResponse.error || !tokenResponse.token) {
        throw new Error(tokenResponse.error ?? i18n.t("downloads.requestTokenFailed"));
      }

      const resolvedFileName = tokenResponse.fileName ?? fileName;
      const downloadTarget = resolveDaemonDownloadTarget(daemonProfile, activeConnectionId);
      if (!downloadTarget) {
        // Relay, SSH, socket and pipe hosts have no HTTP endpoint: transfer the file over the
        // session socket that is already connected (#543).
        const outcome = await downloadOverSession({
          id,
          path,
          resolvedFileName,
          mimeType: tokenResponse.mimeType,
          announcedSize: tokenResponse.size,
          readFile,
          streamFile,
          openDownloadSink,
          saveFile,
          onProgress: (progress) => get().updateProgress(id, progress),
        });
        if (outcome.kind === "cancelled") {
          get().dismissDownload(id);
          return;
        }
        get().completeDownload(id);
        if (outcome.uri !== null) {
          await shareFile(outcome.uri, tokenResponse.mimeType, resolvedFileName);
        }
        return;
      }
      if (!downloadTarget.baseUrl) {
        throw new Error(i18n.t("downloads.hostUnavailable"));
      }

      const downloadUrl = buildDownloadUrl(downloadTarget.baseUrl, tokenResponse.token);

      if (isWeb) {
        const file = await fetchDownload(fetchFile, downloadUrl);
        saveBrowserFile(file, resolvedFileName);
        get().completeDownload(id);
        return;
      }

      const downloadStartTime = Date.now();
      const targetFile = resolveDownloadTargetFile(resolvedFileName);
      const downloadResumable = LegacyFileSystem.createDownloadResumable(
        downloadUrl,
        targetFile.uri,
        downloadTarget.authHeader
          ? { headers: { Authorization: downloadTarget.authHeader } }
          : undefined,
        (data) => {
          const now = Date.now();
          const { totalBytesWritten, totalBytesExpectedToWrite } = data;

          if (totalBytesExpectedToWrite <= 0) {
            return;
          }

          const percent = totalBytesWritten / totalBytesExpectedToWrite;
          const elapsed = (now - downloadStartTime) / 1000;
          const speed = elapsed > 0 ? totalBytesWritten / elapsed : 0;
          const remaining = totalBytesExpectedToWrite - totalBytesWritten;
          const eta = speed > 0 ? remaining / speed : 0;

          get().updateProgress(id, {
            percent,
            bytesWritten: totalBytesWritten,
            totalBytes: totalBytesExpectedToWrite,
            speed,
            eta,
          });
        },
      );

      const result = await downloadResumable.downloadAsync();
      if (!result) {
        throw new Error(i18n.t("downloads.cancelled"));
      }

      get().completeDownload(id);

      await shareSavedFile(result.uri, tokenResponse.mimeType, resolvedFileName);
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
      get().failDownload(id, message);
    }
  },

  updateProgress: (id, progress) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download || download.status !== "downloading") {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, progress });
      return { downloads: updated };
    });
  },

  completeDownload: (id) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, status: "complete" });
      return { downloads: updated };
    });
  },

  failDownload: (id, message) => {
    set((state) => {
      const download = state.downloads.get(id);
      if (!download) {
        return state;
      }
      const updated = new Map(state.downloads);
      updated.set(id, { ...download, status: "error", message });
      return { downloads: updated };
    });
  },

  dismissDownload: (id) => {
    set((state) => {
      const updated = new Map(state.downloads);
      updated.delete(id);
      const newActiveId =
        state.activeDownloadId === id ? findMostRecentDownloadId(updated) : state.activeDownloadId;
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },

  dismissAllCompleted: () => {
    set((state) => {
      const updated = new Map(state.downloads);
      for (const [id, download] of updated) {
        if (download.status !== "downloading") {
          updated.delete(id);
        }
      }
      let newActiveId: string | null;
      if (!state.activeDownloadId) newActiveId = null;
      else if (updated.has(state.activeDownloadId)) newActiveId = state.activeDownloadId;
      else newActiveId = findMostRecentDownloadId(updated);
      return { downloads: updated, activeDownloadId: newActiveId };
    });
  },
}));

function findMostRecentDownloadId(downloads: Map<string, Download>): string | null {
  let mostRecent: Download | null = null;
  for (const download of downloads.values()) {
    if (!mostRecent || download.startedAt > mostRecent.startedAt) {
      mostRecent = download;
    }
  }
  return mostRecent?.id ?? null;
}

interface DownloadTarget {
  baseUrl: string | null;
  authHeader: string | null;
}

/**
 * The HTTP download route is only reachable over a direct TCP connection. Returns `null` when
 * the connection in use is anything else (relay, SSH, socket, pipe, or none yet), so the caller
 * reads the file over the session socket instead.
 */
function resolveDaemonDownloadTarget(
  daemon: HostProfile | undefined,
  activeConnectionId: string | null,
): DownloadTarget | null {
  const connection = daemon?.connections.find((conn) => conn.id === activeConnectionId);
  if (connection?.type !== "directTcp") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(
      buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    );
  } catch {
    return { baseUrl: null, authHeader: null };
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }

  let authCredentials: { username: string; password: string } | null = null;
  if (parsed.username || parsed.password) {
    authCredentials = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
    parsed.username = "";
    parsed.password = "";
  }

  parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "/");

  const baseUrl = parsed.origin;
  const authHeader = authCredentials
    ? `Basic ${btoa(`${authCredentials.username}:${authCredentials.password}`)}`
    : null;

  return { baseUrl, authHeader };
}

function buildDownloadUrl(baseUrl: string, token: string): string {
  const url = new URL("/api/files/download", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Fetches the file instead of navigating to it. The app runs on another origin than the host
 * (paseo://app on desktop), so a link to the download URL navigates the whole window, and any
 * response that is not the file (a proxy's 401 page, a 404) replaces the app.
 */
async function fetchDownload(fetchFile: typeof fetch, url: string): Promise<Blob> {
  let response: Response;
  try {
    // Send the same cookies the host's WebSocket handshake sends, so a proxy in front of the
    // host lets the download through. Refuse redirects: a proxy that redirects to a login page
    // would otherwise be saved as the file.
    response = await fetchFile(url, { credentials: "include", redirect: "error" });
  } catch {
    throw new Error(i18n.t("downloads.failed"));
  }
  if (!response.ok) {
    throw new Error(i18n.t("downloads.httpFailed", { status: response.status }));
  }
  try {
    // The body streams after the headers, so the connection can still drop here.
    return await response.blob();
  } catch {
    throw new Error(i18n.t("downloads.failed"));
  }
}

type SessionDownloadOutcome = { kind: "cancelled" } | { kind: "saved"; uri: string | null };

async function downloadOverSession(params: {
  id: string;
  path: string;
  resolvedFileName: string;
  mimeType: string | null;
  announcedSize: number | null;
  readFile: (path: string, maxBytes: number) => Promise<{ bytes: Uint8Array; size: number }>;
  streamFile?: (
    path: string,
    sink: FileStreamSink,
    maxBytes?: number,
  ) => Promise<{ size: number; bytesWritten: number }>;
  openDownloadSink: (fileName: string) => Promise<OpenDownloadSinkResult> | OpenDownloadSinkResult;
  saveFile: typeof saveDownloadedBytes;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<SessionDownloadOutcome> {
  if (params.streamFile) {
    const sinkResult = await params.openDownloadSink(params.resolvedFileName);
    if (sinkResult.kind === "cancelled") {
      return { kind: "cancelled" };
    }
    if (sinkResult.kind === "sink") {
      await streamIntoDownloadSink({
        path: params.path,
        announcedSize: params.announcedSize,
        streamFile: params.streamFile,
        sink: sinkResult.sink,
        onProgress: params.onProgress,
      });
      return { kind: "saved", uri: sinkResult.sink.uri };
    }
  }

  if (
    typeof params.announcedSize === "number" &&
    params.announcedSize > MAX_SESSION_DOWNLOAD_BYTES
  ) {
    throw new Error(
      i18n.t("composer.errors.fileTooLarge", {
        fileName: params.resolvedFileName,
        size: "64 MB",
      }),
    );
  }
  const { bytes, size } = await params.readFile(params.path, MAX_SESSION_DOWNLOAD_BYTES);
  // A daemon without a binary channel answers `encoding: "none"` for a binary file: no
  // content, real size. Never save that as a complete download.
  if (bytes.byteLength !== size) {
    throw new Error(
      `File transfer incomplete: expected ${size} bytes, received ${bytes.byteLength}.`,
    );
  }
  const savedUri = await params.saveFile({
    bytes,
    fileName: params.resolvedFileName,
    mimeType: params.mimeType,
  });
  return { kind: "saved", uri: savedUri };
}

async function streamIntoDownloadSink(params: {
  path: string;
  announcedSize: number | null;
  streamFile: (
    path: string,
    sink: FileStreamSink,
    maxBytes?: number,
  ) => Promise<{ size: number; bytesWritten: number }>;
  sink: DownloadStreamSink;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<void> {
  const downloadStartTime = Date.now();
  let totalBytes =
    typeof params.announcedSize === "number" && params.announcedSize >= 0
      ? params.announcedSize
      : 0;
  let bytesWritten = 0;
  let lastProgressAt = 0;

  const reportProgress = (force: boolean) => {
    if (totalBytes <= 0) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastProgressAt < STREAM_PROGRESS_INTERVAL_MS) {
      return;
    }
    lastProgressAt = now;
    const elapsed = (now - downloadStartTime) / 1000;
    const speed = elapsed > 0 ? bytesWritten / elapsed : 0;
    const remaining = Math.max(0, totalBytes - bytesWritten);
    const eta = speed > 0 ? remaining / speed : 0;
    params.onProgress({
      percent: Math.min(1, bytesWritten / totalBytes),
      bytesWritten,
      totalBytes,
      speed,
      eta,
    });
  };

  try {
    const result = await params.streamFile(params.path, {
      onBegin: (info) => {
        totalBytes = info.size;
        reportProgress(true);
      },
      onChunk: (chunk) => {
        params.sink.write(chunk);
        bytesWritten += chunk.byteLength;
        reportProgress(bytesWritten >= totalBytes);
      },
    });
    if (result.bytesWritten !== result.size) {
      throw new Error(
        `File transfer incomplete: expected ${result.size} bytes, received ${result.bytesWritten}.`,
      );
    }
    await params.sink.close();
  } catch (error) {
    await params.sink.abort();
    throw error;
  }
}

interface WebFileWritableStream {
  write: (data: Uint8Array<ArrayBuffer>) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
}

interface WebFilePickerHandle {
  createWritable: () => Promise<WebFileWritableStream>;
}

type ShowSaveFilePickerFn = (options?: { suggestedName?: string }) => Promise<WebFilePickerHandle>;

function toTightUint8Array(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    chunk.buffer instanceof ArrayBuffer &&
    chunk.byteOffset === 0 &&
    chunk.byteLength === chunk.buffer.byteLength
  ) {
    return chunk as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy;
}

async function defaultOpenDownloadSink(fileName: string): Promise<OpenDownloadSinkResult> {
  if (isWeb) {
    const picker =
      typeof window !== "undefined"
        ? (window as Window & { showSaveFilePicker?: ShowSaveFilePickerFn }).showSaveFilePicker
        : undefined;
    if (typeof picker !== "function") {
      return { kind: "unavailable" };
    }
    try {
      const fileHandle = await picker({ suggestedName: sanitizeDownloadFileName(fileName) });
      const writable = await fileHandle.createWritable();
      let writeChain: Promise<void> = Promise.resolve();
      let writeError: Error | null = null;
      let finished = false;

      return {
        kind: "sink",
        sink: {
          uri: null,
          write: (chunk) => {
            if (writeError) {
              throw writeError;
            }
            if (chunk.byteLength === 0) {
              return;
            }
            const tight = toTightUint8Array(chunk);
            writeChain = writeChain.then(async () => {
              try {
                await writable.write(tight);
              } catch (error) {
                writeError = error instanceof Error ? error : new Error(String(error));
              }
              return undefined;
            });
          },
          close: async () => {
            if (finished) {
              return;
            }
            finished = true;
            await writeChain;
            if (writeError) {
              await writable.abort().catch(() => {});
              throw writeError;
            }
            await writable.close();
          },
          abort: async () => {
            if (finished) {
              return;
            }
            finished = true;
            await writeChain.catch(() => {});
            await writable.abort().catch(() => {});
          },
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { kind: "cancelled" };
      }
      return { kind: "unavailable" };
    }
  }

  const targetFile = resolveDownloadTargetFile(fileName);
  targetFile.create({ overwrite: true });
  const handle = targetFile.open(FileMode.Truncate);
  let closed = false;
  const closeHandle = () => {
    if (closed) {
      return;
    }
    closed = true;
    handle.close();
  };

  return {
    kind: "sink",
    sink: {
      uri: targetFile.uri,
      write: (chunk) => {
        if (chunk.byteLength === 0) {
          return;
        }
        handle.writeBytes(toTightUint8Array(chunk));
      },
      close: closeHandle,
      abort: () => {
        try {
          closeHandle();
        } catch {
          // Best-effort close before removing a partial download.
        }
        try {
          if (targetFile.exists) {
            targetFile.delete();
          }
        } catch {
          // Best-effort cleanup of a partial download.
        }
      },
    },
  };
}

/**
 * Saves bytes read over the session. Web and Electron hand them to the browser's download
 * manager and return `null`; native writes the file and returns its URI for the share sheet.
 */
async function saveDownloadedBytes({
  bytes,
  fileName,
  mimeType,
}: DownloadedBytes): Promise<string | null> {
  if (isWeb) {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    saveBrowserFile(new Blob([buffer], { type: mimeType ?? "application/octet-stream" }), fileName);
    return null;
  }
  // Resolve and write in one tick so two downloads of the same name cannot pick the same path.
  const targetFile = resolveDownloadTargetFile(fileName);
  targetFile.write(bytes);
  return targetFile.uri;
}

async function shareSavedFile(
  uri: string,
  mimeType: string | null,
  fileName: string,
): Promise<void> {
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: mimeType ?? undefined,
      dialogTitle: fileName
        ? i18n.t("downloads.shareFileNamed", { fileName })
        : i18n.t("downloads.shareFile"),
    });
  }
}

function saveBrowserFile(file: Blob, fileName: string) {
  if (typeof document === "undefined") {
    return;
  }

  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The browser may still be reading the blob while its save prompt is open.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function resolveDownloadTargetFile(fileName: string): FSFile {
  const directory = Paths.cache ?? Paths.document;
  if (!directory) {
    throw new Error("No download directory available.");
  }

  const safeName = sanitizeDownloadFileName(fileName);
  const split = splitFileName(safeName);
  let targetFile = new FSFile(directory, safeName);
  let suffix = 1;

  while (targetFile.exists) {
    targetFile = new FSFile(directory, `${split.base} (${suffix})${split.ext}`);
    suffix += 1;
  }

  return targetFile;
}

function sanitizeDownloadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "download";
  }
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
}

function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { base: fileName, ext: "" };
  }
  return {
    base: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot),
  };
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 1) {
    return "< 1s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
