import { create } from "zustand";
import { Directory, File as FSFile, FileMode, Paths } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { FileStreamOptions, FileStreamSink } from "@getpaseo/client/internal/daemon-client";
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
// Finite upper bound for streamed session downloads so a daemon cannot exhaust local storage.
export const MAX_STREAM_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024;
// Keep headroom on local storage when available disk space can be queried.
export const MIN_FREE_DISK_RESERVE_BYTES = 256 * 1024 * 1024;
// Bound in-flight web FileSystemWritableFileStream writes so a slow disk cannot grow heap unboundedly.
export const MAX_WEB_PENDING_WRITE_BYTES = 16 * 1024 * 1024;
export const MAX_WEB_PENDING_WRITE_CHUNKS = 512;
// Retain completed native cache downloads briefly for Android/iOS share handoff, then prune.
export const NATIVE_DOWNLOAD_CACHE_TTL_MS = 15 * 60 * 1000;

const NATIVE_DOWNLOADS_DIR_NAME = "paseo-downloads";
const STREAM_PROGRESS_INTERVAL_MS = 150;
const MAX_DOWNLOAD_FILENAME_LENGTH = 180;

export interface DownloadStreamSink {
  /** Local file URI to hand to the native share sheet after completion; `null` on web. */
  readonly uri: string | null;
  /** Optional setup run after token/size validation and before streaming starts. */
  prepare?: () => Promise<void> | void;
  /** Optional listener invoked on asynchronous sink failures so streaming can abort immediately. */
  setErrorHandler?: (handler: ((error: Error) => void) | null) => void;
  write: (chunk: Uint8Array) => void;
  close: () => Promise<void> | void;
  abort: () => Promise<void> | void;
  /** Optional hook invoked after post-download handoff (e.g. share sheet) to release retention lock. */
  release?: () => void;
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

export type StreamFileFn = (
  path: string,
  sink: FileStreamSink,
  options?: Omit<FileStreamOptions, "requestId">,
) => Promise<{ size: number; bytesWritten: number }>;

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
    /** Streams the file chunk-by-chunk over the session socket with bounded memory. */
    streamFile?: StreamFileFn;
    openDownloadSink?: (
      fileName: string,
    ) => Promise<OpenDownloadSinkResult> | OpenDownloadSinkResult;
    /** Finite upper byte budget for streamed downloads; defaults to `MAX_STREAM_DOWNLOAD_BYTES`. */
    maxStreamBytes?: number;
    /** Minimum free disk headroom to preserve when disk space is known; defaults to `MIN_FREE_DISK_RESERVE_BYTES`. */
    diskReserveBytes?: number;
    /** Returns available local disk bytes, or `null` when unknown. */
    getAvailableDiskBytes?: () => Promise<number | null> | number | null;
    shareFile?: typeof shareSavedFile;
    saveFile?: typeof saveDownloadedBytes;
    fetchFile?: typeof fetch;
  }) => Promise<void>;

  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string) => void;
  failDownload: (id: string, message: string) => void;
  cancelDownload: (id: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

const activeDownloadControllers = new Map<string, AbortController>();
const activeNativeDownloadDirs = new Set<string>();
const completedNativeDownloadTimes = new Map<string, number>();
const activeDiskReservations = new Map<string, { reserved: number; written: number }>();
let diskAdmissionQueue: Promise<void> = Promise.resolve();

async function withDiskAdmissionLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = diskAdmissionQueue;
  let release!: () => void;
  diskAdmissionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function isValidByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function generateDownloadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateUniqueDirectoryName(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `dl-${crypto.randomUUID()}`;
  }
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const useDownloadStore = create<DownloadState>()((set, get) => ({
  downloads: new Map(),
  activeDownloadId: null,

  startDownload: async (params) => {
    const id = generateDownloadId();
    const download: Download = {
      id,
      serverId: params.serverId,
      scopeId: params.scopeId,
      fileName: params.fileName,
      status: "downloading",
      startedAt: Date.now(),
    };

    const controller = new AbortController();
    activeDownloadControllers.set(id, controller);

    set((state) => ({
      downloads: new Map(state.downloads).set(id, download),
      activeDownloadId: id,
    }));

    const openDownloadSink = params.openDownloadSink ?? defaultOpenDownloadSink;
    const shareFile = params.shareFile ?? shareSavedFile;
    let preOpenedSink: DownloadStreamSink | null = null;
    let preOpenedSinkUnavailable = false;

    try {
      // Keep target resolution inside try (still before the first `await`) so malformed credentials
      // in a directTcp URL fail the download cleanly instead of stranding the toast/controller.
      const downloadTarget = resolveDaemonDownloadTarget(
        params.daemonProfile,
        params.activeConnectionId,
      );

      // On web/Electron, invoke showSaveFilePicker before the first `await` so transient user
      // activation from the click is still active even over a high-latency relay.
      if (!downloadTarget && params.streamFile && isWeb) {
        const sinkResult = await openDownloadSink(params.fileName);
        if (sinkResult.kind === "cancelled") {
          get().dismissDownload(id);
          return;
        }
        preOpenedSink = sinkResult.kind === "sink" ? sinkResult.sink : null;
        preOpenedSinkUnavailable = sinkResult.kind === "unavailable";
      }

      const tokenResponse = await requestValidatedDownloadToken(
        params.requestFileDownloadToken,
        params.path,
        controller.signal,
      );
      const resolvedFileName = tokenResponse.fileName ?? params.fileName;
      const onProgress = (progress: DownloadProgress) => get().updateProgress(id, progress);

      if (!downloadTarget) {
        // Relay, SSH, socket and pipe hosts have no HTTP endpoint: transfer the file over the
        // session socket that is already connected (#543).
        const sinkToUse = preOpenedSink;
        preOpenedSink = null;
        const outcome = await downloadOverSession({
          id,
          path: params.path,
          resolvedFileName,
          mimeType: tokenResponse.mimeType,
          announcedSize: tokenResponse.size,
          readFile: params.readFile,
          streamFile: params.streamFile,
          preOpenedSink: sinkToUse,
          preOpenedSinkUnavailable,
          openDownloadSink,
          maxStreamBytes: params.maxStreamBytes,
          diskReserveBytes: params.diskReserveBytes,
          getAvailableDiskBytes: params.getAvailableDiskBytes,
          controller,
          saveFile: params.saveFile,
          onProgress,
        });
        if (outcome.kind === "cancelled") {
          get().dismissDownload(id);
          return;
        }
        try {
          get().completeDownload(id);
          if (outcome.uri !== null) {
            await shareFile(outcome.uri, tokenResponse.mimeType, resolvedFileName);
          }
        } finally {
          outcome.release?.();
        }
        return;
      }

      const savedHttpUri = await downloadOverHttp({
        downloadTarget,
        token: tokenResponse.token,
        resolvedFileName,
        fetchFile: params.fetchFile ?? fetch,
        onProgress,
      });
      get().completeDownload(id);
      if (savedHttpUri !== null) {
        await shareFile(savedHttpUri, tokenResponse.mimeType, resolvedFileName);
      }
    } catch (error) {
      if (preOpenedSink) {
        await preOpenedSink.abort();
      }
      const message = error instanceof Error ? error.message : i18n.t("downloads.failed");
      get().failDownload(id, message);
    } finally {
      activeDownloadControllers.delete(id);
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

  cancelDownload: (id) => {
    const controller = activeDownloadControllers.get(id);
    get().dismissDownload(id);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(i18n.t("downloads.cancelled")));
    }
  },

  dismissDownload: (id) => {
    const controller = activeDownloadControllers.get(id);
    set((state) => {
      const updated = new Map(state.downloads);
      updated.delete(id);
      const newActiveId =
        state.activeDownloadId === id ? findMostRecentDownloadId(updated) : state.activeDownloadId;
      return { downloads: updated, activeDownloadId: newActiveId };
    });
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(i18n.t("downloads.cancelled")));
    }
    if (!isWeb) {
      pruneDefaultNativeDownloadsCache();
    }
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
    if (!isWeb) {
      pruneDefaultNativeDownloadsCache();
    }
  },
}));

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  if (typeof signal.reason === "string" && signal.reason.length > 0) {
    return new Error(signal.reason);
  }
  return new Error(i18n.t("downloads.cancelled"));
}

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

async function requestValidatedDownloadToken(
  requestFileDownloadToken: (path: string) => Promise<{
    token: string | null;
    fileName: string | null;
    mimeType: string | null;
    size: number | null;
    error: string | null;
  }>,
  path: string,
  signal: AbortSignal,
): Promise<{
  token: string;
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
}> {
  if (signal.aborted) {
    throw createAbortError(signal);
  }
  const tokenResponse = await requestFileDownloadToken(path);
  if (tokenResponse.error || !tokenResponse.token) {
    throw new Error(tokenResponse.error ?? i18n.t("downloads.requestTokenFailed"));
  }
  if (tokenResponse.size !== null && !isValidByteCount(tokenResponse.size)) {
    throw new Error("Invalid file size reported by daemon.");
  }
  if (signal.aborted) {
    throw createAbortError(signal);
  }
  return {
    token: tokenResponse.token,
    fileName: tokenResponse.fileName,
    mimeType: tokenResponse.mimeType,
    size: tokenResponse.size,
  };
}

async function downloadOverHttp(params: {
  downloadTarget: DownloadTarget;
  token: string;
  resolvedFileName: string;
  fetchFile: typeof fetch;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<string | null> {
  if (!params.downloadTarget.baseUrl) {
    throw new Error(i18n.t("downloads.hostUnavailable"));
  }
  const downloadUrl = buildDownloadUrl(params.downloadTarget.baseUrl, params.token);
  if (isWeb) {
    const file = await fetchDownload(params.fetchFile, downloadUrl);
    saveBrowserFile(file, params.resolvedFileName);
    return null;
  }

  const downloadStartTime = Date.now();
  const targetFile = resolveDownloadTargetFile(params.resolvedFileName);
  const downloadResumable = LegacyFileSystem.createDownloadResumable(
    downloadUrl,
    targetFile.uri,
    params.downloadTarget.authHeader
      ? { headers: { Authorization: params.downloadTarget.authHeader } }
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

      params.onProgress({
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
  return result.uri;
}

type SessionDownloadOutcome =
  | { kind: "cancelled" }
  | { kind: "saved"; uri: string | null; release?: () => void };

async function resolveStreamBudget(params: {
  id: string;
  resolvedFileName: string;
  announcedSize: number | null;
  maxStreamBytes: number;
  diskReserveBytes: number;
  getAvailableDiskBytes: () => Promise<number | null> | number | null;
}): Promise<{ maxBytes: number; expectedSize: number | undefined; reservedDisk: boolean }> {
  if (!isValidByteCount(params.maxStreamBytes) || params.maxStreamBytes <= 0) {
    throw new RangeError("maxStreamBytes must be a positive safe integer.");
  }
  if (!isValidByteCount(params.diskReserveBytes)) {
    throw new RangeError("diskReserveBytes must be a non-negative safe integer.");
  }
  if (params.announcedSize !== null && !isValidByteCount(params.announcedSize)) {
    throw new Error("Invalid file size reported by daemon.");
  }
  if (params.announcedSize !== null && params.announcedSize > params.maxStreamBytes) {
    throw new Error(
      `File "${params.resolvedFileName}" exceeds the maximum download size (${formatByteBudget(params.maxStreamBytes)}).`,
    );
  }

  return withDiskAdmissionLock(async () => {
    if (!isWeb) {
      // Reclaim expired cache downloads before checking available disk space.
      pruneDefaultNativeDownloadsCache();
    }

    let budget = params.maxStreamBytes;
    let reservedDisk = false;
    const availableDiskBytes = await params.getAvailableDiskBytes();
    if (
      typeof availableDiskBytes === "number" &&
      Number.isFinite(availableDiskBytes) &&
      availableDiskBytes >= 0
    ) {
      let otherReservedRemaining = 0;
      for (const [otherId, entry] of activeDiskReservations) {
        if (otherId === params.id) {
          continue;
        }
        otherReservedRemaining += Math.max(0, entry.reserved - entry.written);
      }
      const diskBudget = Math.max(
        0,
        Math.floor(availableDiskBytes) - params.diskReserveBytes - otherReservedRemaining,
      );
      if (params.announcedSize !== null && params.announcedSize > diskBudget) {
        throw new Error(
          `Not enough free disk space to download "${params.resolvedFileName}" (need ${formatByteBudget(params.announcedSize)}, available after reserve: ${formatByteBudget(diskBudget)}).`,
        );
      }
      budget = Math.min(budget, diskBudget);
      reservedDisk = true;
    }

    const expectedSize = params.announcedSize !== null ? params.announcedSize : undefined;
    const maxBytes = expectedSize !== undefined ? Math.min(budget, expectedSize) : budget;
    if (reservedDisk) {
      activeDiskReservations.set(params.id, { reserved: maxBytes, written: 0 });
    }
    return { maxBytes, expectedSize, reservedDisk };
  });
}

function formatByteBudget(bytes: number): string {
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  if (bytes >= gib) {
    return `${(bytes / gib).toFixed(1)} GB`;
  }
  if (bytes >= mib) {
    return `${Math.round(bytes / mib)} MB`;
  }
  return `${bytes} B`;
}

async function downloadOverSession(params: {
  id: string;
  path: string;
  resolvedFileName: string;
  mimeType: string | null;
  announcedSize: number | null;
  readFile: (path: string, maxBytes: number) => Promise<{ bytes: Uint8Array; size: number }>;
  streamFile?: StreamFileFn;
  preOpenedSink: DownloadStreamSink | null;
  preOpenedSinkUnavailable: boolean;
  openDownloadSink: (fileName: string) => Promise<OpenDownloadSinkResult> | OpenDownloadSinkResult;
  maxStreamBytes?: number;
  diskReserveBytes?: number;
  getAvailableDiskBytes?: () => Promise<number | null> | number | null;
  controller: AbortController;
  saveFile?: typeof saveDownloadedBytes;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<SessionDownloadOutcome> {
  if (params.streamFile) {
    let sink: DownloadStreamSink | null = params.preOpenedSink;
    let budget: {
      maxBytes: number;
      expectedSize: number | undefined;
      reservedDisk: boolean;
    } | null = null;
    try {
      if (sink || !params.preOpenedSinkUnavailable) {
        budget = await resolveStreamBudget({
          id: params.id,
          resolvedFileName: params.resolvedFileName,
          announcedSize: params.announcedSize,
          maxStreamBytes: params.maxStreamBytes ?? MAX_STREAM_DOWNLOAD_BYTES,
          diskReserveBytes: params.diskReserveBytes ?? MIN_FREE_DISK_RESERVE_BYTES,
          getAvailableDiskBytes: params.getAvailableDiskBytes ?? defaultGetAvailableDiskBytes,
        });
      }

      if (!sink && !params.preOpenedSinkUnavailable) {
        const sinkResult = await params.openDownloadSink(params.resolvedFileName);
        if (sinkResult.kind === "cancelled") {
          return { kind: "cancelled" };
        }
        if (sinkResult.kind === "sink") {
          sink = sinkResult.sink;
        }
      }

      if (sink && budget) {
        await streamIntoDownloadSink({
          id: params.id,
          path: params.path,
          maxBytes: budget.maxBytes,
          expectedSize: budget.expectedSize,
          streamFile: params.streamFile,
          sink,
          controller: params.controller,
          onProgress: params.onProgress,
        });
        return { kind: "saved", uri: sink.uri, release: sink.release };
      }
    } catch (error) {
      if (sink) {
        await sink.abort();
      }
      throw error;
    } finally {
      activeDiskReservations.delete(params.id);
    }
  }

  return downloadBufferedOverSession(params);
}

async function downloadBufferedOverSession(params: {
  path: string;
  resolvedFileName: string;
  mimeType: string | null;
  announcedSize: number | null;
  readFile: (path: string, maxBytes: number) => Promise<{ bytes: Uint8Array; size: number }>;
  saveFile?: typeof saveDownloadedBytes;
}): Promise<SessionDownloadOutcome> {
  if (params.announcedSize !== null && params.announcedSize > MAX_SESSION_DOWNLOAD_BYTES) {
    throw new Error(
      i18n.t("composer.errors.fileTooLarge", {
        fileName: params.resolvedFileName,
        size: "64 MB",
      }),
    );
  }
  const { bytes, size } = await params.readFile(params.path, MAX_SESSION_DOWNLOAD_BYTES);
  if (
    !isValidByteCount(size) ||
    size > MAX_SESSION_DOWNLOAD_BYTES ||
    bytes.byteLength > MAX_SESSION_DOWNLOAD_BYTES
  ) {
    throw new Error(
      i18n.t("composer.errors.fileTooLarge", {
        fileName: params.resolvedFileName,
        size: "64 MB",
      }),
    );
  }
  // A daemon without a binary channel answers `encoding: "none"` for a binary file: no
  // content, real size. Never save that as a complete download.
  if (bytes.byteLength !== size) {
    throw new Error(
      `File transfer incomplete: expected ${size} bytes, received ${bytes.byteLength}.`,
    );
  }
  const saveFile = params.saveFile ?? saveDownloadedBytes;
  const savedUri = await saveFile({
    bytes,
    fileName: params.resolvedFileName,
    mimeType: params.mimeType,
  });
  return { kind: "saved", uri: savedUri };
}

async function streamIntoDownloadSink(params: {
  id: string;
  path: string;
  maxBytes: number;
  expectedSize: number | undefined;
  streamFile: StreamFileFn;
  sink: DownloadStreamSink;
  controller: AbortController;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<void> {
  const downloadStartTime = Date.now();
  let totalBytes = params.expectedSize ?? 0;
  let totalBytesKnown = params.expectedSize !== undefined;
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

  // Keep abort wired to the sink across streaming, draining, and close so cancelling after
  // network FileEnd cannot still commit the file while buffered chunks are flushing.
  const onSignalAbort = () => {
    void Promise.resolve(params.sink.abort()).catch(() => {});
  };
  params.controller.signal.addEventListener("abort", onSignalAbort, { once: true });

  try {
    if (params.controller.signal.aborted) {
      throw createAbortError(params.controller.signal);
    }
    await params.sink.prepare?.();
    if (params.controller.signal.aborted) {
      throw createAbortError(params.controller.signal);
    }
    params.sink.setErrorHandler?.((error) => {
      if (!params.controller.signal.aborted) {
        params.controller.abort(error);
      }
    });

    const result = await params.streamFile(
      params.path,
      {
        onBegin: (info) => {
          if (!isValidByteCount(info.size)) {
            throw new Error("Invalid file size reported by daemon.");
          }
          if (params.expectedSize !== undefined && info.size !== params.expectedSize) {
            throw new Error(
              `File size mismatch: expected ${params.expectedSize} bytes, daemon sent ${info.size}.`,
            );
          }
          if (info.size > params.maxBytes) {
            throw new Error("File is too large to display");
          }
          totalBytes = info.size;
          totalBytesKnown = true;
          const reservation = activeDiskReservations.get(params.id);
          if (reservation) {
            reservation.reserved = Math.min(reservation.reserved, info.size);
          }
          reportProgress(true);
        },
        onChunk: (chunk) => {
          if (chunk.byteLength === 0) {
            return;
          }
          const nextWritten = bytesWritten + chunk.byteLength;
          if (nextWritten > params.maxBytes) {
            throw new Error("File is too large to display");
          }
          if (totalBytesKnown && nextWritten > totalBytes) {
            throw new Error(
              `File transfer incomplete: expected ${totalBytes} bytes, received ${nextWritten}.`,
            );
          }
          params.sink.write(chunk);
          bytesWritten = nextWritten;
          const reservation = activeDiskReservations.get(params.id);
          if (reservation) {
            reservation.written = bytesWritten;
          }
          reportProgress(bytesWritten >= totalBytes);
        },
      },
      {
        maxBytes: params.maxBytes,
        ...(params.expectedSize !== undefined ? { expectedSize: params.expectedSize } : {}),
        signal: params.controller.signal,
      },
    );

    if (params.controller.signal.aborted) {
      throw createAbortError(params.controller.signal);
    }
    if (!isValidByteCount(result.size) || !isValidByteCount(result.bytesWritten)) {
      throw new Error("Invalid file size reported by daemon.");
    }
    if (params.expectedSize !== undefined && result.size !== params.expectedSize) {
      throw new Error(
        `File size mismatch: expected ${params.expectedSize} bytes, daemon sent ${result.size}.`,
      );
    }
    if (result.size > params.maxBytes || result.bytesWritten > params.maxBytes) {
      throw new Error("File is too large to display");
    }
    if (result.bytesWritten !== result.size || bytesWritten !== result.size) {
      throw new Error(
        `File transfer incomplete: expected ${result.size} bytes, received ${Math.min(result.bytesWritten, bytesWritten)}.`,
      );
    }

    await params.sink.close();
  } catch (error) {
    await params.sink.abort();
    throw error;
  } finally {
    params.controller.signal.removeEventListener("abort", onSignalAbort);
    params.sink.setErrorHandler?.(null);
  }
}

export interface WebFileWritableStream {
  write: (data: Uint8Array<ArrayBuffer>) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
}

export interface WebFilePickerHandle {
  createWritable: () => Promise<WebFileWritableStream>;
}

export interface WindowWithSaveFilePicker {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<WebFilePickerHandle>;
}

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

export function createWebDownloadSink(
  fileHandle: WebFilePickerHandle,
  options?: { maxPendingBytes?: number; maxPendingChunks?: number },
): DownloadStreamSink {
  const maxPendingBytes = options?.maxPendingBytes ?? MAX_WEB_PENDING_WRITE_BYTES;
  const maxPendingChunks = options?.maxPendingChunks ?? MAX_WEB_PENDING_WRITE_CHUNKS;
  if (!isValidByteCount(maxPendingBytes) || maxPendingBytes <= 0) {
    throw new RangeError("maxPendingBytes must be a positive safe integer.");
  }
  if (!isValidByteCount(maxPendingChunks) || maxPendingChunks <= 0) {
    throw new RangeError("maxPendingChunks must be a positive safe integer.");
  }

  let writable: WebFileWritableStream | null = null;
  let state: "idle" | "open" | "closing" | "closed" | "aborted" = "idle";
  let writeError: Error | null = null;
  let errorHandler: ((error: Error) => void) | null = null;
  const isAborted = () => state === "aborted";
  // Fixed-capacity circular ring buffer: O(1) enqueue/dequeue with bounded slot & object count.
  const ring = Array.from<Uint8Array<ArrayBuffer> | undefined>({ length: maxPendingChunks });
  let ringHead = 0;
  let ringTail = 0;
  let ringCount = 0;
  let inFlightChunks = 0;
  let pendingBytes = 0;
  let pumpPromise: Promise<void> | null = null;
  let abortPromise: Promise<void> | null = null;
  const canDrain = () => (state === "open" || state === "closing") && !writeError && ringCount > 0;

  const clearQueue = () => {
    ring.fill(undefined);
    ringHead = 0;
    ringTail = 0;
    ringCount = 0;
    pendingBytes = 0;
  };

  const notifyError = (error: Error) => {
    if (state === "aborted") {
      return;
    }
    if (!writeError) {
      writeError = error;
    }
    clearQueue();
    errorHandler?.(writeError);
  };

  const startPump = () => {
    if (pumpPromise) {
      return;
    }
    pumpPromise = (async () => {
      try {
        while (canDrain()) {
          const nextChunk = ring[ringHead];
          ring[ringHead] = undefined;
          ringHead = (ringHead + 1) % maxPendingChunks;
          ringCount -= 1;
          if (!nextChunk || !writable) {
            continue;
          }
          inFlightChunks += 1;
          try {
            await writable.write(nextChunk);
          } catch (error) {
            notifyError(error instanceof Error ? error : new Error(String(error)));
            break;
          } finally {
            inFlightChunks = Math.max(0, inFlightChunks - 1);
            pendingBytes = Math.max(0, pendingBytes - nextChunk.byteLength);
          }
        }
      } finally {
        pumpPromise = null;
      }
    })();
  };

  return {
    uri: null,
    setErrorHandler: (handler) => {
      errorHandler = handler;
      if (handler && writeError) {
        handler(writeError);
      }
    },
    prepare: async () => {
      if (isAborted()) {
        throw writeError ?? new Error("Download aborted.");
      }
      if (state === "open") {
        return;
      }
      const created = await fileHandle.createWritable();
      if (isAborted()) {
        await created.abort().catch(() => {});
        throw writeError ?? new Error("Download aborted.");
      }
      writable = created;
      state = "open";
    },
    write: (chunk) => {
      if (writeError) {
        throw writeError;
      }
      if (state !== "open" || !writable) {
        throw new Error("Download sink is not open.");
      }
      if (chunk.byteLength === 0) {
        return;
      }
      if (ringCount + inFlightChunks >= maxPendingChunks) {
        const overflow = new Error(
          `Download write queue exceeded ${maxPendingChunks} pending chunks while writing to disk.`,
        );
        notifyError(overflow);
        throw overflow;
      }
      if (pendingBytes + chunk.byteLength > maxPendingBytes) {
        const overflow = new Error(
          `Download write buffer exceeded ${maxPendingBytes} bytes while writing to disk.`,
        );
        notifyError(overflow);
        throw overflow;
      }
      const tight = toTightUint8Array(chunk);
      ring[ringTail] = tight;
      ringTail = (ringTail + 1) % maxPendingChunks;
      ringCount += 1;
      pendingBytes += tight.byteLength;
      startPump();
    },
    close: async () => {
      if (state === "closed") {
        return;
      }
      if (isAborted()) {
        throw writeError ?? new Error("Download aborted.");
      }
      if (state !== "open" || !writable) {
        throw new Error("Download sink is not open.");
      }
      state = "closing";
      if (pumpPromise) {
        await pumpPromise;
      }
      if (writeError || isAborted()) {
        throw writeError ?? new Error("Download aborted.");
      }
      await writable.close();
      if (isAborted()) {
        throw writeError ?? new Error("Download aborted.");
      }
      state = "closed";
    },
    abort: async () => {
      if (state === "closed") {
        return;
      }
      if (abortPromise) {
        return abortPromise;
      }
      state = "aborted";
      clearQueue();
      const targetWritable = writable;
      abortPromise = targetWritable ? targetWritable.abort().catch(() => {}) : Promise.resolve();
      await abortPromise;
    },
  };
}

export async function openWebDownloadSink(
  win: WindowWithSaveFilePicker | undefined,
  fileName: string,
  options?: { maxPendingBytes?: number; maxPendingChunks?: number },
): Promise<OpenDownloadSinkResult> {
  if (!win || typeof win.showSaveFilePicker !== "function") {
    return { kind: "unavailable" };
  }
  try {
    // Invoke as a method on `win` (preserving the receiver) before any `await` so transient user
    // activation from the click is preserved.
    const fileHandle = await win.showSaveFilePicker({
      suggestedName: sanitizeDownloadFileName(fileName),
    });
    return {
      kind: "sink",
      sink: createWebDownloadSink(fileHandle, options),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "cancelled" };
    }
    return { kind: "unavailable" };
  }
}

export interface NativeFileHandleLike {
  writeBytes: (bytes: Uint8Array) => void;
  close: () => void;
}

export interface NativeFileLike {
  readonly uri: string;
  readonly exists: boolean;
  create: (options?: { overwrite?: boolean; intermediates?: boolean }) => void;
  open: (mode?: FileMode) => NativeFileHandleLike;
  info?: () => { modificationTime?: number };
  delete: () => void;
}

export interface NativeDirectoryLike {
  readonly uri: string;
  readonly exists: boolean;
  create: (options?: {
    intermediates?: boolean;
    overwrite?: boolean;
    idempotent?: boolean;
  }) => void;
  list: () => Array<NativeDirectoryLike | NativeFileLike>;
  info: () => { modificationTime?: number };
  delete: () => void;
}

export interface NativeDownloadFs {
  getBaseDirectory: () => NativeDirectoryLike | null | undefined;
  createDirectory: (parent: NativeDirectoryLike, name: string) => NativeDirectoryLike;
  createFile: (parent: NativeDirectoryLike, name: string) => NativeFileLike;
  isDirectory: (entry: NativeDirectoryLike | NativeFileLike) => entry is NativeDirectoryLike;
  generateDirName?: () => string;
  activeDirs?: Set<string>;
  completedTimes?: Map<string, number>;
  now?: () => number;
}

const defaultNativeDownloadFs: NativeDownloadFs = {
  getBaseDirectory: () => Paths.cache ?? Paths.document,
  createDirectory: (parent, name) => new Directory(parent as Directory, name),
  createFile: (parent, name) => new FSFile(parent as Directory, name),
  isDirectory: (entry): entry is NativeDirectoryLike => entry instanceof Directory,
  generateDirName: generateUniqueDirectoryName,
  activeDirs: activeNativeDownloadDirs,
  completedTimes: completedNativeDownloadTimes,
  now: () => Date.now(),
};

function normalizeDirUri(uri: string): string {
  return uri.endsWith("/") ? uri : `${uri}/`;
}

function assertChildUriConfined(
  parentDirUri: string,
  childUri: string,
  expectedSegment: string,
): void {
  const prefix = normalizeDirUri(parentDirUri);
  if (!childUri.startsWith(prefix)) {
    throw new Error("Refusing to write download outside private cache directory.");
  }
  const rawRelative = childUri.slice(prefix.length).replace(/\/$/, "");
  if (
    !rawRelative ||
    rawRelative === "." ||
    rawRelative === ".." ||
    rawRelative.includes("/") ||
    rawRelative.includes("\\") ||
    rawRelative.includes("\0")
  ) {
    throw new Error("Refusing to write download outside private cache directory.");
  }
  if (rawRelative === expectedSegment) {
    return;
  }
  let decodedRelative: string;
  try {
    decodedRelative = decodeURIComponent(rawRelative);
  } catch {
    throw new Error("Refusing to write download outside private cache directory.");
  }
  if (
    !decodedRelative ||
    decodedRelative === "." ||
    decodedRelative === ".." ||
    decodedRelative.includes("/") ||
    decodedRelative.includes("\\") ||
    decodedRelative.includes("\0") ||
    decodedRelative !== expectedSegment
  ) {
    throw new Error("Refusing to write download outside private cache directory.");
  }
}

function latestNativeDirectoryActivityTime(
  entry: NativeDirectoryLike,
  dirName: string,
  completedTimes: Map<string, number>,
): number | null {
  let latest = -Infinity;
  const recordedCompletion = completedTimes.get(dirName);
  if (typeof recordedCompletion === "number" && Number.isFinite(recordedCompletion)) {
    latest = Math.max(latest, recordedCompletion);
  }
  const dirModTime = entry.info().modificationTime;
  if (typeof dirModTime === "number" && Number.isFinite(dirModTime)) {
    latest = Math.max(latest, dirModTime);
  }
  try {
    // Writing bytes to a child file does not advance the parent directory's mtime on POSIX/Android,
    // so measure retention from the newest child file's mtime as well as any completion marker.
    for (const child of entry.list()) {
      try {
        const childModTime = child.info?.().modificationTime;
        if (typeof childModTime === "number" && Number.isFinite(childModTime)) {
          latest = Math.max(latest, childModTime);
        }
      } catch {
        // Ignore individual child stat failures.
      }
    }
  } catch {
    // Ignore child listing failures.
  }
  return Number.isFinite(latest) ? latest : null;
}

function pruneNativeDownloadEntry(params: {
  entry: NativeDirectoryLike | NativeFileLike;
  fs: NativeDownloadFs;
  rootPrefix: string;
  activeDirs: Set<string>;
  completedTimes: Map<string, number>;
  now: number;
  ttlMs: number;
}): void {
  if (!params.fs.isDirectory(params.entry) || !params.entry.uri.startsWith(params.rootPrefix)) {
    return;
  }
  const dirName = params.entry.uri.slice(params.rootPrefix.length).replace(/\/$/, "");
  if (!dirName || dirName.includes("/") || params.activeDirs.has(dirName)) {
    return;
  }
  try {
    const latestActivity = latestNativeDirectoryActivityTime(
      params.entry,
      dirName,
      params.completedTimes,
    );
    if (latestActivity !== null && params.now - latestActivity >= params.ttlMs) {
      params.entry.delete();
      params.completedTimes.delete(dirName);
    }
  } catch {
    // Best-effort cache pruning.
  }
}

export function pruneStaleNativeDownloads(
  fs: NativeDownloadFs = defaultNativeDownloadFs,
  options?: { now?: number; ttlMs?: number },
): void {
  const now = options?.now ?? (fs.now ?? Date.now)();
  const ttlMs = options?.ttlMs ?? NATIVE_DOWNLOAD_CACHE_TTL_MS;
  const activeDirs = fs.activeDirs ?? activeNativeDownloadDirs;
  const completedTimes = fs.completedTimes ?? completedNativeDownloadTimes;

  try {
    const baseDir = fs.getBaseDirectory();
    if (!baseDir) {
      return;
    }
    const downloadsRoot = fs.createDirectory(baseDir, NATIVE_DOWNLOADS_DIR_NAME);
    if (!downloadsRoot.exists) {
      return;
    }
    const rootPrefix = normalizeDirUri(downloadsRoot.uri);
    for (const entry of downloadsRoot.list()) {
      pruneNativeDownloadEntry({ entry, fs, rootPrefix, activeDirs, completedTimes, now, ttlMs });
    }
  } catch {
    // Best-effort cache pruning.
  }
}

function pruneDefaultNativeDownloadsCache(): void {
  pruneStaleNativeDownloads(defaultNativeDownloadFs);
}

export function createNativeDownloadSink(
  fileName: string,
  fs: NativeDownloadFs = defaultNativeDownloadFs,
): DownloadStreamSink {
  const baseDir = fs.getBaseDirectory();
  if (!baseDir) {
    throw new Error("No download directory available.");
  }

  const safeName = sanitizeDownloadFileName(fileName);
  const downloadsRoot = fs.createDirectory(baseDir, NATIVE_DOWNLOADS_DIR_NAME);
  if (!downloadsRoot.exists) {
    downloadsRoot.create({ intermediates: true, idempotent: true });
  }

  const activeDirs = fs.activeDirs ?? activeNativeDownloadDirs;
  const completedTimes = fs.completedTimes ?? completedNativeDownloadTimes;
  const getNow = fs.now ?? Date.now;
  const dirName = (fs.generateDirName ?? generateUniqueDirectoryName)();
  if (!/^[a-zA-Z0-9_-]+$/.test(dirName)) {
    throw new Error("Invalid native download directory name.");
  }

  const targetDir = fs.createDirectory(downloadsRoot, dirName);
  assertChildUriConfined(downloadsRoot.uri, targetDir.uri, dirName);

  activeDirs.add(dirName);
  let createdDir = false;
  let createdFile = false;
  let targetFile: NativeFileLike | null = null;
  let handle: NativeFileHandleLike | null = null;
  let closed = false;
  let cleanedUp = false;

  const closeHandleSafe = () => {
    if (!handle) {
      return;
    }
    const current = handle;
    handle = null;
    current.close();
  };

  const cleanupOwned = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    try {
      closeHandleSafe();
    } catch {
      // Best-effort close before removing a partial download.
    }
    if (createdFile && targetFile) {
      try {
        if (targetFile.exists) {
          targetFile.delete();
        }
      } catch {
        // Best-effort cleanup of a partial download created by this request.
      }
    }
    if (createdDir) {
      try {
        if (targetDir.exists) {
          targetDir.delete();
        }
      } catch {
        // Best-effort cleanup of the private directory created by this request.
      }
    }
    activeDirs.delete(dirName);
    completedTimes.delete(dirName);
  };

  try {
    // Exclusive creation of both the private per-download directory and target file so a concurrent
    // download or pre-existing file can never be clobbered or mistakenly deleted on failure.
    targetDir.create({ intermediates: false, overwrite: false, idempotent: false });
    createdDir = true;

    const candidateFile = fs.createFile(targetDir, safeName);
    assertChildUriConfined(targetDir.uri, candidateFile.uri, safeName);
    candidateFile.create({ overwrite: false });
    targetFile = candidateFile;
    createdFile = true;

    handle = candidateFile.open(FileMode.Truncate);
  } catch (error) {
    cleanupOwned();
    throw error;
  }

  return {
    uri: targetFile.uri,
    write: (chunk) => {
      if (!handle || closed || cleanedUp) {
        throw new Error("Download sink is not open.");
      }
      if (chunk.byteLength === 0) {
        return;
      }
      handle.writeBytes(toTightUint8Array(chunk));
    },
    close: () => {
      if (closed) {
        return;
      }
      if (cleanedUp || !handle) {
        throw new Error("Download sink is not open.");
      }
      closeHandleSafe();
      closed = true;
      completedTimes.set(dirName, getNow());
      // Keep `dirName` in `activeDirs` until `release()` runs after `shareFile` completes so a
      // concurrent download or toast dismissal cannot prune the file during share handoff.
    },
    release: () => {
      if (closed) {
        completedTimes.set(dirName, getNow());
      }
      activeDirs.delete(dirName);
    },
    abort: () => {
      if (closed) {
        return;
      }
      cleanupOwned();
    },
  };
}

async function defaultGetAvailableDiskBytes(): Promise<number | null> {
  if (isWeb) {
    return null;
  }
  try {
    const syncSpace = Paths.availableDiskSpace;
    if (typeof syncSpace === "number" && Number.isFinite(syncSpace) && syncSpace >= 0) {
      return syncSpace;
    }
  } catch {
    // Fall through to legacy async query.
  }
  try {
    const asyncSpace = await LegacyFileSystem.getFreeDiskStorageAsync();
    if (typeof asyncSpace === "number" && Number.isFinite(asyncSpace) && asyncSpace >= 0) {
      return asyncSpace;
    }
  } catch {
    // Disk space unavailable on this runtime.
  }
  return null;
}

async function defaultOpenDownloadSink(fileName: string): Promise<OpenDownloadSinkResult> {
  if (isWeb) {
    const win =
      typeof window !== "undefined" ? (window as Window & WindowWithSaveFilePicker) : undefined;
    return openWebDownloadSink(win, fileName);
  }

  return {
    kind: "sink",
    sink: createNativeDownloadSink(fileName),
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
  link.download = sanitizeDownloadFileName(fileName);
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

function stripUnsafeControlCharacters(input: string): string {
  let result = "";
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      continue;
    }
    result += input[i];
  }
  return result;
}

export function sanitizeDownloadFileName(fileName: string): string {
  // Strip ASCII control chars and Unicode BiDi override characters first.
  const withoutControls = stripUnsafeControlCharacters(fileName);
  // Extract basename across POSIX and Windows path separators so traversal prefixes cannot survive.
  const segments = withoutControls.split(/[\\/]+/);
  const baseSegment = segments[segments.length - 1] ?? "";
  let cleaned = baseSegment.replace(/[:*?"<>|]+/g, "_").trim();

  // Reject dot-segments (".", "..", "...") and strip leading/trailing dots that confuse filesystems.
  cleaned = cleaned.replace(/^\.+/, "").replace(/\.+$/, "").trim();
  if (!cleaned || /^_+$/.test(cleaned)) {
    return "download";
  }

  if (cleaned.length > MAX_DOWNLOAD_FILENAME_LENGTH) {
    const { base, ext } = splitFileName(cleaned);
    if (ext.length > 0 && ext.length <= 32) {
      const maxBase = Math.max(1, MAX_DOWNLOAD_FILENAME_LENGTH - ext.length);
      cleaned = `${base.slice(0, maxBase)}${ext}`;
    } else {
      cleaned = cleaned.slice(0, MAX_DOWNLOAD_FILENAME_LENGTH);
    }
  }

  return cleaned;
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
