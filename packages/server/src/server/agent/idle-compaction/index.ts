import type { Logger } from "pino";
import { withTimeout } from "../../../utils/promise-timeout.js";

export interface IdleCompactionProviderSettings {
  enabled?: boolean;
  idleMinutes?: number;
  maxIdleMinutes?: number;
  minContextTokens?: number;
}

export interface IdleCompactionSettings {
  enabled: boolean;
  minContextTokens: number;
  idleMinutes?: number;
  maxIdleMinutes?: number;
  providers?: Record<string, IdleCompactionProviderSettings>;
}

export interface ResolvedProviderIdleCompactionPolicy {
  idleMinutes: number;
  maxIdleMinutes: number;
  minContextTokens: number;
}

/**
 * Default per-provider idle compaction settings.
 *
 * Only Claude is enabled by default, mirroring Claude Code's verified policy
 * (54 min trigger before the 60 min prompt-cache window, 200k min context tokens).
 * Other providers are disabled by default and opt-in under `providers.<id>` so
 * operators can configure thresholds matching their backend's actual cache TTL.
 */
export const DEFAULT_IDLE_COMPACTION_PROVIDERS: Readonly<
  Record<
    string,
    Readonly<
      Required<Pick<IdleCompactionProviderSettings, "enabled" | "idleMinutes" | "maxIdleMinutes">>
    >
  >
> = Object.freeze({
  claude: Object.freeze({ enabled: true, idleMinutes: 54, maxIdleMinutes: 60 }),
});

/**
 * Mirrors Claude Code's minimum context size default (200k tokens) with
 * per-provider idle thresholds in `DEFAULT_IDLE_COMPACTION_PROVIDERS`.
 */
export const DEFAULT_IDLE_COMPACTION_SETTINGS: Readonly<IdleCompactionSettings> = Object.freeze({
  enabled: true,
  minContextTokens: 200_000,
});

export interface IdleCompactionOutcome {
  agentId: string;
  provider: string;
  sessionId: string | null;
  contextTokensBefore: number | null;
  contextTokensAfter: number | null;
  contextWindowMaxTokens: number | null;
  updatedAtAfter: number;
}

/** A captured live runtime capability. Its lifecycle owner revalidates before compacting. */
export interface IdleCompactionCandidate {
  readonly identity: object;
  readonly agentId: string;
  readonly parentAgentId: string | undefined;
  readonly provider: string;
  readonly sessionId: string | null;
  readonly lastActivityAt: number;
  readonly contextWindowUsedTokens: number | undefined;
  isEligible(): boolean;
  /**
   * Authoritative synchronous live-descendant check (including descendants reached
   * through closed intermediate parents via durable records). When omitted,
   * idle-compaction walks `runtimes` and conservatively blocks on unresolved parents.
   */
  hasLiveDescendant?(): boolean;
  supportsCompaction?(): Promise<boolean> | boolean;
  canStopRuntime?(): Promise<boolean>;
  compactIfEligible(revalidate: () => boolean): Promise<IdleCompactionOutcome | null>;
}

interface Options {
  settings: IdleCompactionSettings;
  runtimes(): readonly IdleCompactionCandidate[];
  isProtected?(agentId: string): boolean;
  logger: Pick<Logger, "debug" | "info" | "warn">;
  now?: () => number;
  schedule?: (tick: () => void, intervalMs: number) => () => void;
}

export interface IdleCompactionSweepResult {
  compacted: IdleCompactionOutcome[];
  failures: Array<{ agentId: string; error: unknown }>;
}

const SWEEP_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function defaultMaxIdleMinutes(idleMinutes: number): number {
  return idleMinutes + Math.max(1, Math.ceil(idleMinutes / 9));
}

function normalizeProviderOverrides(
  providers: Record<string, IdleCompactionProviderSettings> | undefined,
): Record<string, IdleCompactionProviderSettings> | undefined {
  if (!providers) return undefined;
  const normalized: Record<string, IdleCompactionProviderSettings> = {};
  for (const [providerId, override] of Object.entries(providers)) {
    if (!providerId || !override || typeof override !== "object") continue;
    const entry: IdleCompactionProviderSettings = {};
    if (typeof override.enabled === "boolean") entry.enabled = override.enabled;
    const idleMinutes = positiveFinite(override.idleMinutes);
    if (idleMinutes !== undefined) entry.idleMinutes = idleMinutes;
    const maxIdleMinutes = positiveFinite(override.maxIdleMinutes);
    if (maxIdleMinutes !== undefined) entry.maxIdleMinutes = maxIdleMinutes;
    const minContextTokens = positiveInteger(override.minContextTokens);
    if (minContextTokens !== undefined) entry.minContextTokens = minContextTokens;
    if (Object.keys(entry).length > 0) {
      normalized[providerId] = entry;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeIdleCompactionSettings(
  input: Partial<IdleCompactionSettings> | undefined,
): IdleCompactionSettings {
  const idleMinutes = positiveFinite(input?.idleMinutes);
  const maxIdleMinutes = positiveFinite(input?.maxIdleMinutes);
  const minContextTokens =
    positiveInteger(input?.minContextTokens) ?? DEFAULT_IDLE_COMPACTION_SETTINGS.minContextTokens;
  const providers = normalizeProviderOverrides(input?.providers);
  return {
    enabled: input?.enabled ?? DEFAULT_IDLE_COMPACTION_SETTINGS.enabled,
    minContextTokens,
    ...(idleMinutes !== undefined ? { idleMinutes } : {}),
    ...(maxIdleMinutes !== undefined ? { maxIdleMinutes } : {}),
    ...(providers !== undefined ? { providers } : {}),
  };
}

function resolveMaxIdleMinutes(
  idleMinutes: number,
  override: IdleCompactionProviderSettings | undefined,
  builtin: { maxIdleMinutes: number } | undefined,
  fallbackMax: number | undefined,
): number {
  if (override?.maxIdleMinutes !== undefined) return override.maxIdleMinutes;
  if (override?.idleMinutes === undefined && builtin !== undefined) return builtin.maxIdleMinutes;
  return fallbackMax ?? defaultMaxIdleMinutes(idleMinutes);
}

/**
 * Resolve the effective idle compaction policy for one provider.
 * Returns null when idle auto-compaction is disabled or misconfigured for this provider.
 */
export function resolveProviderIdleCompactionPolicy(
  settings: IdleCompactionSettings,
  provider: string,
): ResolvedProviderIdleCompactionPolicy | null {
  if (!settings.enabled) return null;
  const builtin = DEFAULT_IDLE_COMPACTION_PROVIDERS[provider];
  const override = settings.providers?.[provider];
  if (!(override?.enabled ?? builtin?.enabled ?? false)) return null;

  const idleMinutes = override?.idleMinutes ?? builtin?.idleMinutes ?? settings.idleMinutes;
  if (idleMinutes === undefined) return null;

  const maxIdleMinutes = resolveMaxIdleMinutes(
    idleMinutes,
    override,
    builtin,
    settings.maxIdleMinutes,
  );
  if (maxIdleMinutes <= idleMinutes) return null;

  return {
    idleMinutes,
    maxIdleMinutes,
    minContextTokens: override?.minContextTokens ?? settings.minContextTokens,
  };
}

export function formatIdleCompactionTimelineMessage(outcome: {
  contextTokensBefore: number | null;
  contextTokensAfter: number | null;
}): string {
  const { contextTokensBefore, contextTokensAfter } = outcome;
  if (contextTokensBefore !== null && contextTokensAfter !== null) {
    return `Auto-compacted idle session before prompt cache expiry (${contextTokensBefore.toLocaleString("en-US")} -> ${contextTokensAfter.toLocaleString("en-US")} tokens).`;
  }
  if (contextTokensBefore !== null) {
    return `Auto-compacted idle session before prompt cache expiry (${contextTokensBefore.toLocaleString("en-US")} tokens before compaction).`;
  }
  return "Auto-compacted idle session before prompt cache expiry.";
}

/** Owns idle compaction clocks, safety checks, per-provider policies, and sweep lifetime. */
export function createIdleCompaction(options: Options) {
  const protectedAt = new WeakMap<object, { at: number; protected: boolean }>();
  const handledActivityAt = new WeakMap<object, number>();
  let activeSweep: Promise<IdleCompactionSweepResult> | null = null;
  let stopped = false;
  let settings = normalizeIdleCompactionSettings(options.settings);
  let generation = 0;
  const isProtected = options.isProtected ?? (() => false);
  const now = options.now ?? Date.now;

  function hasLiveDescendant(
    root: IdleCompactionCandidate,
    runtimes: readonly IdleCompactionCandidate[],
  ): boolean {
    if (typeof root.hasLiveDescendant === "function") {
      return root.hasLiveDescendant();
    }
    const byId = new Map(runtimes.map((candidate) => [candidate.agentId, candidate]));
    for (const candidate of runtimes) {
      if (candidate.agentId === root.agentId) continue;
      let parentId = candidate.parentAgentId;
      const visited = new Set<string>([candidate.agentId]);
      while (parentId !== undefined) {
        if (parentId === root.agentId) return true;
        if (visited.has(parentId)) break;
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) return true;
        parentId = parent.parentAgentId;
      }
    }
    return false;
  }

  function baselineAllows(
    runtime: IdleCompactionCandidate,
    runtimes: readonly IdleCompactionCandidate[],
  ): boolean {
    return (
      !hasLiveDescendant(runtime, runtimes) && runtime.isEligible() && !isProtected(runtime.agentId)
    );
  }

  async function providerAllows(
    runtime: IdleCompactionCandidate,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    // Fail closed: the target runtime must expose a safety probe.
    if (typeof runtime.canStopRuntime !== "function") {
      return false;
    }
    const allowed = await withTimeout(
      runtime.canStopRuntime(),
      PROBE_TIMEOUT_MS,
      `Runtime safety probe timed out for ${runtime.agentId}`,
    ).then(
      (safe) => safe === true,
      (error) => {
        options.logger.debug(
          { agentId: runtime.agentId, provider: runtime.provider, err: error },
          "Idle compaction safety probe failed; failing closed",
        );
        return false;
      },
    );
    return isCurrent() && allowed;
  }

  async function isSupported(
    runtime: IdleCompactionCandidate,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (!runtime.supportsCompaction) return false;
    const supported = await withTimeout(
      Promise.resolve(runtime.supportsCompaction()),
      PROBE_TIMEOUT_MS,
      `Compaction capability probe timed out for ${runtime.agentId}`,
    );
    return isCurrent() && supported === true;
  }

  function recordExpiredWindow(
    runtime: IdleCompactionCandidate,
    policy: ResolvedProviderIdleCompactionPolicy,
  ): void {
    handledActivityAt.set(runtime.identity, runtime.lastActivityAt);
    options.logger.debug(
      {
        agentId: runtime.agentId,
        provider: runtime.provider,
        cacheAgeMs: now() - runtime.lastActivityAt,
        idleThresholdMinutes: policy.idleMinutes,
        maxIdleMinutes: policy.maxIdleMinutes,
      },
      "Idle compaction skipped because session exceeded prompt cache window",
    );
  }

  function evaluateIdleTrigger(
    runtime: IdleCompactionCandidate,
    policy: ResolvedProviderIdleCompactionPolicy,
  ): { ready: boolean; idleSince: number } {
    const currentNow = now();
    if (protectedAt.get(runtime.identity)?.protected) {
      protectedAt.set(runtime.identity, { at: currentNow, protected: false });
    }
    const idleSince = Math.max(runtime.lastActivityAt, protectedAt.get(runtime.identity)?.at ?? 0);
    return {
      ready: currentNow - idleSince >= policy.idleMinutes * 60_000,
      idleSince,
    };
  }

  function settleCompactionResult(
    runtime: IdleCompactionCandidate,
    policy: ResolvedProviderIdleCompactionPolicy,
    idleSince: number,
    isWithinCacheWindow: () => boolean,
    isCurrent: () => boolean,
    outcome: IdleCompactionOutcome | null,
    result: IdleCompactionSweepResult,
  ): void {
    if (outcome) {
      handledActivityAt.set(runtime.identity, outcome.updatedAtAfter);
      result.compacted.push(outcome);
      options.logger.info(
        {
          agentId: outcome.agentId,
          provider: outcome.provider,
          sessionId: outcome.sessionId,
          idleMs: now() - idleSince,
          cacheAgeMs: now() - runtime.lastActivityAt,
          idleThresholdMinutes: policy.idleMinutes,
          maxIdleMinutes: policy.maxIdleMinutes,
          contextTokensBefore: outcome.contextTokensBefore,
          contextTokensAfter: outcome.contextTokensAfter,
          contextWindowMaxTokens: outcome.contextWindowMaxTokens,
        },
        "Auto-compacted idle agent before prompt cache expiry",
      );
      return;
    }
    if (!isCurrent()) return;
    if (!isWithinCacheWindow()) {
      recordExpiredWindow(runtime, policy);
    } else {
      protectedAt.set(runtime.identity, { at: now(), protected: true });
    }
  }

  async function evaluateCandidate(
    runtime: IdleCompactionCandidate,
    runtimes: readonly IdleCompactionCandidate[],
    currentSettings: IdleCompactionSettings,
    isCurrent: () => boolean,
    result: IdleCompactionSweepResult,
  ): Promise<void> {
    const policy = resolveProviderIdleCompactionPolicy(currentSettings, runtime.provider);
    if (!policy || handledActivityAt.get(runtime.identity) === runtime.lastActivityAt) return;
    if (
      runtime.contextWindowUsedTokens === undefined ||
      runtime.contextWindowUsedTokens < policy.minContextTokens
    ) {
      return;
    }

    // Cache expiry is always derived from root's last cache-refresh activity against
    // the live clock (never from protectedAt).
    const isWithinCacheWindow = () =>
      now() - runtime.lastActivityAt < policy.maxIdleMinutes * 60_000;
    if (!isWithinCacheWindow()) {
      recordExpiredWindow(runtime, policy);
      return;
    }

    try {
      if (!(await isSupported(runtime, isCurrent))) return;

      const allowed =
        baselineAllows(runtime, runtimes) && (await providerAllows(runtime, isCurrent));
      if (!isCurrent()) return;
      if (!allowed) {
        protectedAt.set(runtime.identity, { at: now(), protected: true });
        options.logger.debug(
          { agentId: runtime.agentId, provider: runtime.provider },
          "Idle compaction deferred by a baseline, live-descendant, or provider veto",
        );
        return;
      }

      if (!isWithinCacheWindow()) {
        recordExpiredWindow(runtime, policy);
        return;
      }

      const { ready, idleSince } = evaluateIdleTrigger(runtime, policy);
      if (!ready) return;

      const revalidate = () =>
        isCurrent() && isWithinCacheWindow() && baselineAllows(runtime, options.runtimes());

      const outcome = await runtime.compactIfEligible(revalidate);
      settleCompactionResult(
        runtime,
        policy,
        idleSince,
        isWithinCacheWindow,
        isCurrent,
        outcome,
        result,
      );
    } catch (error) {
      if (!isCurrent()) return;
      handledActivityAt.set(runtime.identity, runtime.lastActivityAt);
      result.failures.push({ agentId: runtime.agentId, error });
      options.logger.warn(
        { agentId: runtime.agentId, provider: runtime.provider, err: error },
        "Idle auto-compaction failed",
      );
    }
  }

  async function runSweep(): Promise<IdleCompactionSweepResult> {
    const result: IdleCompactionSweepResult = { compacted: [], failures: [] };
    const sweepGeneration = generation;
    const currentSettings = settings;
    const isCurrent = () => currentSettings.enabled && !stopped && generation === sweepGeneration;
    if (!isCurrent()) return result;

    const runtimes = options.runtimes();
    for (const runtime of runtimes) {
      if (!isCurrent()) break;
      await evaluateCandidate(runtime, runtimes, currentSettings, isCurrent, result);
    }
    return result;
  }

  function sweep(): Promise<IdleCompactionSweepResult> {
    if (activeSweep) return activeSweep;
    activeSweep = runSweep().finally(() => {
      activeSweep = null;
    });
    return activeSweep;
  }

  const schedule =
    options.schedule ??
    ((tick, intervalMs) => {
      const timer = setInterval(tick, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    });

  const cancel = schedule(() => {
    void sweep().catch((error) =>
      options.logger.warn({ err: error }, "Idle compaction sweep failed"),
    );
  }, SWEEP_INTERVAL_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    generation++;
    cancel();
  }

  return {
    sweep,
    stop,
    getSettings(): IdleCompactionSettings {
      return {
        ...settings,
        ...(settings.providers !== undefined
          ? {
              providers: Object.fromEntries(
                Object.entries(settings.providers).map(([key, value]) => [key, { ...value }]),
              ),
            }
          : {}),
      };
    },
    updateSettings(next: Partial<IdleCompactionSettings> | undefined) {
      const normalized = normalizeIdleCompactionSettings(next);
      if (JSON.stringify(settings) === JSON.stringify(normalized)) return;
      settings = normalized;
      generation++;
    },
    async close() {
      stop();
      await activeSweep;
    },
  };
}
