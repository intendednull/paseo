import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, onTestFinished, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { AgentStorage } from "../agent-storage.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { loadConfig, resolveReloadableConfig } from "../../config.js";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { loadPersistedConfig } from "../../persisted-config.js";
import { connectIdleCompactionConfig } from "../../bootstrap.js";
import {
  createIdleCompaction,
  DEFAULT_IDLE_COMPACTION_PROVIDERS,
  DEFAULT_IDLE_COMPACTION_SETTINGS,
  resolveProviderIdleCompactionPolicy,
  type IdleCompactionCandidate,
  type IdleCompactionSettings,
} from "./index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

class FakeCandidateRuntime {
  readonly identity = {};
  busy = false;
  activity = 0;
  contextTokens: number | undefined = 450_000;
  postCompactTokens: number | null = 20_000;
  supportsCompaction = true;
  parentAgentId: string | undefined;
  probe: (() => Promise<boolean>) | undefined = async () => true;
  admitCompact: (() => Promise<void>) | undefined;
  failCompact: Error | null = null;
  compactions = 0;

  constructor(
    readonly id = "agent-1",
    readonly provider = "claude",
  ) {}

  capture(now: () => number): IdleCompactionCandidate {
    const activity = this.activity;
    return {
      identity: this.identity,
      agentId: this.id,
      parentAgentId: this.parentAgentId,
      provider: this.provider,
      sessionId: `sess-${this.id}`,
      lastActivityAt: activity,
      contextWindowUsedTokens: this.contextTokens,
      isEligible: () => !this.busy && this.activity === activity,
      supportsCompaction: () => this.supportsCompaction,
      canStopRuntime: this.probe,
      compactIfEligible: async (revalidate) => {
        await this.admitCompact?.();
        if (!revalidate()) return null;
        if (this.failCompact) throw this.failCompact;
        this.compactions++;
        const before = this.contextTokens ?? null;
        this.contextTokens = this.postCompactTokens ?? this.contextTokens;
        // Compaction + timeline notification advances agent.updatedAt.
        this.activity = now() + 1_000;
        return {
          agentId: this.id,
          provider: this.provider,
          sessionId: `sess-${this.id}`,
          contextTokensBefore: before,
          contextTokensAfter: this.postCompactTokens,
          contextWindowMaxTokens: 1_000_000,
          updatedAtAfter: this.activity,
        };
      },
    };
  }
}

function createScenario(settings: Partial<IdleCompactionSettings> = {}) {
  const runtime = new FakeCandidateRuntime();
  const runtimes = [runtime];
  let time = 0;
  let protectedCaller = false;
  const infoLogs: Array<{ obj: unknown; msg: string }> = [];
  const warnLogs: Array<{ obj: unknown; msg: string }> = [];
  const logger = {
    debug: () => {},
    info: (obj: unknown, msg?: string) => {
      infoLogs.push({ obj, msg: msg ?? "" });
    },
    warn: (obj: unknown, msg?: string) => {
      warnLogs.push({ obj, msg: msg ?? "" });
    },
  };
  const idleCompaction = createIdleCompaction({
    settings: { ...DEFAULT_IDLE_COMPACTION_SETTINGS, ...settings },
    logger,
    now: () => time,
    runtimes: () => runtimes.map((item) => item.capture(() => time)),
    isProtected: () => protectedCaller,
    schedule: (_callback, interval) => {
      expect(interval).toBe(60_000);
      return () => {};
    },
  });
  onTestFinished(() => idleCompaction.close());
  return {
    runtime,
    runtimes,
    idleCompaction,
    infoLogs,
    warnLogs,
    protect: (value: boolean) => {
      protectedCaller = value;
    },
    setMinutes: (minutes: number) => {
      time = minutes * 60_000;
    },
    sweepAtMinutes: (minutes: number) => {
      time = minutes * 60_000;
      return idleCompaction.sweep();
    },
  };
}

describe("idle auto-compaction per-provider policy", () => {
  test("enables Claude by default at 54m / 60m window / 400k tokens and keeps unverified providers opt-in", () => {
    expect(DEFAULT_IDLE_COMPACTION_SETTINGS).toEqual({
      enabled: true,
      minContextTokens: 400_000,
    });
    expect(DEFAULT_IDLE_COMPACTION_PROVIDERS).toEqual({
      claude: { enabled: true, idleMinutes: 54, maxIdleMinutes: 60 },
    });

    expect(resolveProviderIdleCompactionPolicy(DEFAULT_IDLE_COMPACTION_SETTINGS, "claude")).toEqual(
      {
        idleMinutes: 54,
        maxIdleMinutes: 60,
        minContextTokens: 400_000,
      },
    );
    // Non-Claude providers are disabled by default (opt-in via providers.<id>).
    expect(
      resolveProviderIdleCompactionPolicy(DEFAULT_IDLE_COMPACTION_SETTINGS, "codex"),
    ).toBeNull();
    expect(
      resolveProviderIdleCompactionPolicy(DEFAULT_IDLE_COMPACTION_SETTINGS, "antigravity"),
    ).toBeNull();
    expect(
      resolveProviderIdleCompactionPolicy(DEFAULT_IDLE_COMPACTION_SETTINGS, "opencode"),
    ).toBeNull();
    expect(
      resolveProviderIdleCompactionPolicy(DEFAULT_IDLE_COMPACTION_SETTINGS, "copilot"),
    ).toBeNull();
    expect(resolveProviderIdleCompactionPolicy(DEFAULT_IDLE_COMPACTION_SETTINGS, "pi")).toBeNull();
    expect(
      resolveProviderIdleCompactionPolicy(DEFAULT_IDLE_COMPACTION_SETTINGS, "custom"),
    ).toBeNull();

    // Explicit opt-in and Claude overage override derive a tight maxIdleMinutes upper bound.
    expect(
      resolveProviderIdleCompactionPolicy(
        {
          enabled: true,
          minContextTokens: 400_000,
          providers: {
            claude: { idleMinutes: 4 },
            codex: { enabled: true, idleMinutes: 20, maxIdleMinutes: 25 },
            broken: { enabled: true, idleMinutes: 10, maxIdleMinutes: 10 },
          },
        },
        "claude",
      ),
    ).toEqual({ idleMinutes: 4, maxIdleMinutes: 5, minContextTokens: 400_000 });
    expect(
      resolveProviderIdleCompactionPolicy(
        {
          enabled: true,
          minContextTokens: 400_000,
          providers: {
            codex: { enabled: true, idleMinutes: 20, maxIdleMinutes: 25 },
          },
        },
        "codex",
      ),
    ).toEqual({ idleMinutes: 20, maxIdleMinutes: 25, minContextTokens: 400_000 });
    expect(
      resolveProviderIdleCompactionPolicy(
        {
          enabled: true,
          minContextTokens: 400_000,
          providers: {
            broken: { enabled: true, idleMinutes: 10, maxIdleMinutes: 10 },
          },
        },
        "broken",
      ),
    ).toBeNull();
  });

  test("triggers Claude at 54m by default and triggers opt-in providers at their configured thresholds", async () => {
    const claude = new FakeCandidateRuntime("agent-claude", "claude");
    const codex = new FakeCandidateRuntime("agent-codex", "codex");
    const antigravity = new FakeCandidateRuntime("agent-agy", "antigravity");
    const opencode = new FakeCandidateRuntime("agent-oc", "opencode");
    const uncached = new FakeCandidateRuntime("agent-pi", "pi");

    const s = createScenario({
      providers: {
        opencode: { enabled: true, idleMinutes: 4 },
        antigravity: { enabled: true, idleMinutes: 13 },
        codex: { enabled: true, idleMinutes: 27 },
      },
    });
    s.runtimes.splice(0, 1, claude, codex, antigravity, opencode, uncached);

    // At 3 min: nothing fires yet.
    expect((await s.sweepAtMinutes(3)).compacted).toEqual([]);

    // At 4 min: opt-in OpenCode fires; others wait.
    expect((await s.sweepAtMinutes(4)).compacted.map((c) => c.agentId)).toEqual(["agent-oc"]);

    // At 13 min: opt-in Antigravity fires.
    expect((await s.sweepAtMinutes(13)).compacted.map((c) => c.agentId)).toEqual(["agent-agy"]);

    // At 27 min: opt-in Codex fires.
    expect((await s.sweepAtMinutes(27)).compacted.map((c) => c.agentId)).toEqual(["agent-codex"]);

    // At 53 min: Claude still waits.
    expect((await s.sweepAtMinutes(53)).compacted).toEqual([]);

    // At 54 min: Claude fires; non-opted-in provider still skipped.
    const at54 = await s.sweepAtMinutes(54);
    expect(at54.compacted.map((c) => c.agentId)).toEqual(["agent-claude"]);
    expect(uncached.compactions).toBe(0);
    expect(s.infoLogs).toContainEqual(
      expect.objectContaining({
        msg: "Auto-compacted idle agent before prompt cache expiry",
        obj: expect.objectContaining({
          agentId: "agent-claude",
          idleThresholdMinutes: 54,
          maxIdleMinutes: 60,
          contextTokensBefore: 450_000,
          contextTokensAfter: 20_000,
        }),
      }),
    );
  });

  test("skips sessions that exceeded the prompt cache window (e.g. host suspend or sweep backlog)", async () => {
    const s = createScenario();
    // First sweep happens at 65m (past Claude's 60m upper bound): cache is already cold, skip.
    expect((await s.sweepAtMinutes(65)).compacted).toEqual([]);
    expect(s.runtime.compactions).toBe(0);

    // Subsequent sweeps for the same stale activity also skip.
    expect((await s.sweepAtMinutes(66)).compacted).toEqual([]);
    expect(s.runtime.compactions).toBe(0);

    // New activity re-arms the 54m..60m window.
    s.runtime.activity = 70 * 60_000;
    expect((await s.sweepAtMinutes(124)).compacted).toHaveLength(1);
    expect(s.runtime.compactions).toBe(1);
  });

  test("fails closed when a candidate or child omits canStopRuntime", async () => {
    const s = createScenario();
    s.runtime.probe = undefined;
    expect((await s.sweepAtMinutes(55)).compacted).toEqual([]);
    expect(s.runtime.compactions).toBe(0);

    s.runtime.probe = async () => true;
    const child = new FakeCandidateRuntime("child-no-probe", "claude");
    child.parentAgentId = s.runtime.id;
    child.probe = undefined;
    s.runtimes.push(child);
    expect((await s.sweepAtMinutes(56)).compacted).toEqual([]);
    expect(s.runtime.compactions).toBe(0);
  });

  test("stop() immediately halts admission without waiting for an in-flight compaction", async () => {
    const s = createScenario();
    const compactGate = deferred<void>();
    s.runtime.admitCompact = () => compactGate.promise;

    const pendingSweep = s.sweepAtMinutes(54);
    // Wait a tick for compaction admission to be reached.
    await Promise.resolve();
    await Promise.resolve();

    // stop() must return synchronously without waiting for compactGate.
    s.idleCompaction.stop();

    // New sweeps after stop() return empty immediately.
    compactGate.resolve();
    await pendingSweep;
    expect(s.runtime.compactions).toBe(0);
  });

  test("supports per-provider threshold overrides (e.g. Claude 5-minute overage) and explicit opt-in/out", async () => {
    const claude = new FakeCandidateRuntime("agent-claude", "claude");
    const codex = new FakeCandidateRuntime("agent-codex", "codex");
    const pi = new FakeCandidateRuntime("agent-pi", "pi");

    const s = createScenario({
      providers: {
        claude: { idleMinutes: 4, minContextTokens: 100_000 },
        codex: { enabled: false },
        pi: { enabled: true, idleMinutes: 20 },
      },
    });
    claude.contextTokens = 120_000;
    s.runtimes.splice(0, 1, claude, codex, pi);

    expect((await s.sweepAtMinutes(4)).compacted.map((c) => c.agentId)).toEqual(["agent-claude"]);
    expect((await s.sweepAtMinutes(20)).compacted.map((c) => c.agentId)).toEqual(["agent-pi"]);
    expect((await s.sweepAtMinutes(55)).compacted).toEqual([]);
    expect(codex.compactions).toBe(0);
  });

  test("skips sessions below the minimum context size threshold", async () => {
    const s = createScenario();
    s.runtime.contextTokens = 399_999;
    expect((await s.sweepAtMinutes(55)).compacted).toEqual([]);
    expect(s.runtime.compactions).toBe(0);

    s.runtime.contextTokens = undefined;
    expect((await s.sweepAtMinutes(60)).compacted).toEqual([]);
    expect(s.runtime.compactions).toBe(0);
  });

  test("checks upper bound against live clock after a delayed preceding candidate and during final admission", async () => {
    const first = new FakeCandidateRuntime("agent-first", "claude");
    const second = new FakeCandidateRuntime("agent-second", "claude");
    const third = new FakeCandidateRuntime("agent-third", "claude");

    const s = createScenario();
    s.runtimes.splice(0, 1, first, second, third);

    // Sweep starts at 55m (all three within 54m..60m). First compaction takes 6m,
    // advancing the live clock to 61m before second is evaluated.
    first.admitCompact = async () => {
      s.setMinutes(61);
    };
    const result = await s.sweepAtMinutes(55);
    // First itself crossed 60m before revalidate() ran -> skipped; second and third also see 61m -> skipped!
    expect(result.compacted).toEqual([]);
    expect(first.compactions).toBe(0);
    expect(second.compactions).toBe(0);
    expect(third.compactions).toBe(0);

    // Reset activity at 70m: first finishes at 125m (within 54m..60m -> 55m age),
    // advances live clock to 131m (61m age) before second is evaluated.
    first.activity = 70 * 60_000;
    second.activity = 70 * 60_000;
    third.activity = 70 * 60_000;
    first.admitCompact = undefined;
    const origProbe = second.probe;
    second.probe = async () => {
      s.setMinutes(131);
      return (await origProbe?.()) ?? true;
    };
    const secondRun = await s.sweepAtMinutes(125);
    expect(secondRun.compacted.map((c) => c.agentId)).toEqual(["agent-first"]);
    expect(second.compactions).toBe(0);
    expect(third.compactions).toBe(0);
  });

  test("never compacts a cold cache after a long live-descendant veto clears with no root activity", async () => {
    const s = createScenario();
    const child = new FakeCandidateRuntime("child-1", "claude");
    child.parentAgentId = s.runtime.id;
    child.contextTokens = 10_000;
    child.busy = false;
    s.runtimes.push(child);

    // Root had activity at t=0. Live child (even idle) stays open until t=50m, then closes at t=51m with NO root activity.
    expect((await s.sweepAtMinutes(50)).compacted).toEqual([]);
    s.runtimes.splice(s.runtimes.indexOf(child), 1);
    // At t=51m: child closed, starting post-veto cooldown (51 + 54 = 105m).
    expect((await s.sweepAtMinutes(51)).compacted).toEqual([]);
    // At t=55m: still inside post-veto cooldown.
    expect((await s.sweepAtMinutes(55)).compacted).toEqual([]);
    // At t=60m and t=105m: root cache expired at t=60m (derived from root lastActivityAt=0, NOT protectedAt=51m).
    expect((await s.sweepAtMinutes(60)).compacted).toEqual([]);
    expect((await s.sweepAtMinutes(105)).compacted).toEqual([]);
    expect(s.runtime.compactions).toBe(0);
  });

  test("never compacts when busy, protected, provider vetoes background work, or any live descendant exists (even idle)", async () => {
    const s = createScenario();
    s.runtime.busy = true;
    expect((await s.sweepAtMinutes(55)).compacted).toEqual([]);
    s.runtime.busy = false;
    s.runtime.activity = 56 * 60_000;
    expect((await s.sweepAtMinutes(56)).compacted).toEqual([]);
    expect((await s.sweepAtMinutes(109)).compacted).toEqual([]);

    // Provider background work veto (e.g. Claude background bash / monitor).
    s.runtime.probe = async () => false;
    expect((await s.sweepAtMinutes(110)).compacted).toEqual([]);
    s.runtime.probe = async () => true;
    s.runtime.activity = 111 * 60_000;
    expect((await s.sweepAtMinutes(111)).compacted).toEqual([]);

    // Protected caller (e.g. pending finish subscription or queued message).
    s.protect(true);
    expect((await s.sweepAtMinutes(166)).compacted).toEqual([]);
    s.protect(false);
    s.runtime.activity = 171 * 60_000;
    expect((await s.sweepAtMinutes(171)).compacted).toEqual([]);

    // Any live managed child (even idle!) protects parent; once child closes and root refreshes, compacts at +54m.
    const child = new FakeCandidateRuntime("child-1", "claude");
    child.parentAgentId = s.runtime.id;
    child.contextTokens = 10_000;
    child.busy = false;
    s.runtimes.push(child);
    expect((await s.sweepAtMinutes(226)).compacted).toEqual([]);

    s.runtimes.splice(s.runtimes.indexOf(child), 1);
    s.runtime.activity = 231 * 60_000;
    expect((await s.sweepAtMinutes(231)).compacted).toEqual([]);
    expect((await s.sweepAtMinutes(284)).compacted).toEqual([]);
    expect((await s.sweepAtMinutes(285)).compacted).toHaveLength(1);
  });

  test("skips sessions whose runtime reports compaction unsupported", async () => {
    const s = createScenario();
    s.runtime.supportsCompaction = false;
    expect((await s.sweepAtMinutes(55)).compacted).toEqual([]);
  });

  test("does not loop-compact an already-compacted idle session even if post tokens stay above threshold", async () => {
    const s = createScenario({ minContextTokens: 50_000 });
    s.runtime.contextTokens = 250_000;
    s.runtime.postCompactTokens = 80_000; // still >= 50k

    expect((await s.sweepAtMinutes(54)).compacted).toHaveLength(1);
    expect(s.runtime.compactions).toBe(1);

    // Even 2 hours later with no new real activity, do not compact again.
    expect((await s.sweepAtMinutes(180)).compacted).toEqual([]);
    expect(s.runtime.compactions).toBe(1);

    // New user/agent activity re-arms idle compaction after another 54m.
    s.runtime.activity = 185 * 60_000;
    expect((await s.sweepAtMinutes(238)).compacted).toEqual([]);
    expect((await s.sweepAtMinutes(239)).compacted).toHaveLength(1);
    expect(s.runtime.compactions).toBe(2);
  });

  test("does not retry-loop on failure for the same idle state", async () => {
    const s = createScenario();
    s.runtime.failCompact = new Error("upstream unavailable");

    const first = await s.sweepAtMinutes(54);
    expect(first.failures).toHaveLength(1);
    expect(s.warnLogs).toHaveLength(1);

    const second = await s.sweepAtMinutes(55);
    expect(second.failures).toEqual([]);
    expect(second.compacted).toEqual([]);
  });

  test("aborts compaction when activity arrives during async provider safety probe", async () => {
    const s = createScenario();
    const probeGate = deferred<boolean>();
    s.runtime.probe = () => probeGate.promise;

    const pending = s.sweepAtMinutes(54);
    s.runtime.busy = true;
    probeGate.resolve(true);

    const result = await pending;
    expect(result.compacted).toEqual([]);
    expect(s.runtime.compactions).toBe(0);
  });
});

describe("AgentManager + daemon config integration", () => {
  test("auto-compaction records a timeline notification, blocks on running background work, and allows standing heartbeats", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-idle-compact-mgr-"));
    tempDirs.push(root);
    const logger = createTestLogger();

    const subscribers = new Set<(event: AgentStreamEvent) => void>();
    const prompts: AgentPromptInput[] = [];
    const emit = (event: AgentStreamEvent) => {
      for (const subscriber of subscribers) subscriber(event);
    };

    const session: AgentSession = {
      provider: "claude",
      id: "sess-claude",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      } satisfies AgentCapabilityFlags,
      supportsCompaction: () => true,
      canStopRuntime: async () => true,
      run: async (): Promise<AgentRunResult> => ({
        sessionId: "sess-claude",
        finalText: "",
        timeline: [],
      }),
      startTurn: async (prompt) => {
        prompts.push(prompt);
        const turnId = `turn-${randomUUID()}`;
        queueMicrotask(() => {
          emit({
            type: "timeline",
            provider: "claude",
            turnId,
            item: { type: "compaction", status: "loading" },
          });
          emit({
            type: "timeline",
            provider: "claude",
            turnId,
            item: {
              type: "compaction",
              status: "completed",
              trigger: "manual",
              preTokens: 420_000,
            },
          });
          emit({
            type: "usage_updated",
            provider: "claude",
            turnId,
            usage: { contextWindowUsedTokens: 15_000, contextWindowMaxTokens: 1_000_000 },
          });
          emit({
            type: "turn_completed",
            provider: "claude",
            turnId,
            usage: { contextWindowUsedTokens: 15_000, contextWindowMaxTokens: 1_000_000 },
          });
        });
        return { turnId };
      },
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      async *streamHistory() {},
      getRuntimeInfo: async (): Promise<AgentRuntimeInfo> => ({
        provider: "claude",
        sessionId: "sess-claude",
      }),
      getAvailableModes: async (): Promise<AgentMode[]> => [{ id: "default", label: "Default" }],
      getCurrentMode: async () => "default",
      setMode: async () => {},
      getPendingPermissions: (): AgentPermissionRequest[] => [],
      respondToPermission: async () => {},
      describePersistence: (): AgentPersistenceHandle => ({
        provider: "claude",
        sessionId: "sess-claude",
      }),
      interrupt: async () => {},
      close: async () => {
        subscribers.clear();
      },
    };

    const client: AgentClient = {
      provider: "claude",
      capabilities: session.capabilities,
      createSession: async (_config: AgentSessionConfig) => session,
      resumeSession: async () => session,
      fetchCatalog: async () => ({ models: [], modes: [{ id: "default", label: "Default" }] }),
      isAvailable: async () => true,
    };

    const manager = new AgentManager({ clients: { claude: client }, logger });
    const agent = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    emit({
      type: "usage_updated",
      provider: "claude",
      usage: { contextWindowUsedTokens: 420_000, contextWindowMaxTokens: 1_000_000 },
    });
    await manager.flush();

    // Running daemon background work (countsAsRunning: true) blocks idle compaction.
    manager.setDaemonBackgroundWork({
      agentId: agent.id,
      namespace: "change-request-watch",
      id: "pr-1",
      kind: "monitor",
      description: "Watching PR #1",
      startedAt: new Date().toISOString(),
      countsAsRunning: true,
      stop: async () => {},
    });

    // First sweep at +1m while running watch is active -> blocked (sets protectedAt).
    // Remove watch and add standing heartbeat (countsAsRunning: false); sweep at +2m observes
    // protection cleared; at +56m (54m after cleared AND <60m from root activity) -> compacts!
    let nowMs = Date.now() + 1 * 60_000;
    const idleCompaction = createIdleCompaction({
      settings: DEFAULT_IDLE_COMPACTION_SETTINGS,
      runtimes: () => manager.getIdleCompactionCandidates(),
      logger,
      now: () => nowMs,
      schedule: () => () => {},
    });
    onTestFinished(() => idleCompaction.close());

    expect((await idleCompaction.sweep()).compacted).toEqual([]);

    manager.removeDaemonBackgroundWork({
      agentId: agent.id,
      namespace: "change-request-watch",
      id: "pr-1",
    });
    manager.setDaemonBackgroundWork({
      agentId: agent.id,
      namespace: "heartbeat",
      id: "hb-1",
      kind: "heartbeat",
      description: "Periodic check",
      startedAt: new Date().toISOString(),
      countsAsRunning: false,
      stop: async () => {},
    });

    // Sweep after protection clears starts the 54-minute cooldown (root cache still warm until +60m).
    nowMs += 1 * 60_000;
    expect((await idleCompaction.sweep()).compacted).toEqual([]);

    nowMs += 54 * 60_000;
    const sweepResult = await idleCompaction.sweep();
    expect(sweepResult.compacted).toHaveLength(1);
    expect(prompts).toEqual(["/compact"]);

    const timeline = await manager.fetchTimeline(agent.id, { direction: "tail", limit: 20 });
    expect(timeline.rows.map((row) => row.item)).toContainEqual({
      type: "notification",
      level: "info",
      message: "Auto-compacted idle session before prompt cache expiry (420,000 -> 15,000 tokens).",
    });
  });

  test("auto-compaction fails closed when ONLY provider-local state flips after a successful sweep safety probe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-idle-compact-provider-race-"));
    tempDirs.push(root);
    const logger = createTestLogger();

    const subscribers = new Set<(event: AgentStreamEvent) => void>();
    const prompts: AgentPromptInput[] = [];
    const emit = (event: AgentStreamEvent) => {
      for (const subscriber of subscribers) subscriber(event);
    };

    let probeCount = 0;
    let providerLocalSafe = true;
    const session: AgentSession = {
      provider: "claude",
      id: "sess-race",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
      } satisfies AgentCapabilityFlags,
      supportsCompaction: () => true,
      canStopRuntime: async () => {
        probeCount++;
        // First probe (idle-compaction sweep) succeeds; then provider-local state flips
        // before final admission without any daemon event.
        if (probeCount === 1) {
          providerLocalSafe = false;
          return true;
        }
        return providerLocalSafe;
      },
      run: async (): Promise<AgentRunResult> => ({
        sessionId: "sess-race",
        finalText: "",
        timeline: [],
      }),
      startTurn: async (prompt) => {
        prompts.push(prompt);
        return { turnId: `turn-${randomUUID()}` };
      },
      subscribe: (cb) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      async *streamHistory() {},
      getRuntimeInfo: async (): Promise<AgentRuntimeInfo> => ({
        provider: "claude",
        sessionId: "sess-race",
      }),
      getAvailableModes: async (): Promise<AgentMode[]> => [{ id: "default", label: "Default" }],
      getCurrentMode: async () => "default",
      setMode: async () => {},
      getPendingPermissions: (): AgentPermissionRequest[] => [],
      respondToPermission: async () => {},
      describePersistence: (): AgentPersistenceHandle => ({
        provider: "claude",
        sessionId: "sess-race",
      }),
      interrupt: async () => {},
      close: async () => {
        subscribers.clear();
      },
    };

    const client: AgentClient = {
      provider: "claude",
      capabilities: session.capabilities,
      createSession: async (_config: AgentSessionConfig) => session,
      resumeSession: async () => session,
      fetchCatalog: async () => ({ models: [], modes: [{ id: "default", label: "Default" }] }),
      isAvailable: async () => true,
    };

    const manager = new AgentManager({ clients: { claude: client }, logger });
    await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    emit({
      type: "usage_updated",
      provider: "claude",
      usage: { contextWindowUsedTokens: 420_000, contextWindowMaxTokens: 1_000_000 },
    });
    await manager.flush();

    const idleCompaction = createIdleCompaction({
      settings: DEFAULT_IDLE_COMPACTION_SETTINGS,
      runtimes: () => manager.getIdleCompactionCandidates(),
      logger,
      now: () => Date.now() + 55 * 60_000,
      schedule: () => () => {},
    });
    onTestFinished(() => idleCompaction.close());

    const result = await idleCompaction.sweep();
    expect(result.compacted).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(prompts).toEqual([]);
    expect(probeCount).toBeGreaterThanOrEqual(2);
  });

  test("auto-compaction refuses while the root has any live idle descendant and compacts once it closes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-idle-compact-descendant-"));
    tempDirs.push(root);
    const logger = createTestLogger();

    const prompts: AgentPromptInput[] = [];
    const subscribers = new Set<(event: AgentStreamEvent) => void>();
    const emit = (event: AgentStreamEvent) => {
      for (const subscriber of subscribers) subscriber(event);
    };
    const capabilities: AgentCapabilityFlags = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    };
    const makeSession = (provider: string, id: string): AgentSession => ({
      provider,
      id,
      capabilities,
      supportsCompaction: () => provider === "claude",
      canStopRuntime: async () => true,
      run: async (): Promise<AgentRunResult> => ({ sessionId: id, finalText: "", timeline: [] }),
      startTurn: async (prompt) => {
        prompts.push(prompt);
        const turnId = `turn-${randomUUID()}`;
        queueMicrotask(() => {
          emit({
            type: "timeline",
            provider,
            turnId,
            item: {
              type: "compaction",
              status: "completed",
              trigger: "manual",
              preTokens: 420_000,
            },
          });
          emit({
            type: "usage_updated",
            provider,
            turnId,
            usage: { contextWindowUsedTokens: 16_000, contextWindowMaxTokens: 1_000_000 },
          });
          emit({
            type: "turn_completed",
            provider,
            turnId,
            usage: { contextWindowUsedTokens: 16_000, contextWindowMaxTokens: 1_000_000 },
          });
        });
        return { turnId };
      },
      subscribe: (cb) => {
        if (provider === "claude") subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      async *streamHistory() {},
      getRuntimeInfo: async (): Promise<AgentRuntimeInfo> => ({ provider, sessionId: id }),
      getAvailableModes: async (): Promise<AgentMode[]> => [{ id: "default", label: "Default" }],
      getCurrentMode: async () => "default",
      setMode: async () => {},
      getPendingPermissions: (): AgentPermissionRequest[] => [],
      respondToPermission: async () => {},
      describePersistence: (): AgentPersistenceHandle => ({ provider, sessionId: id }),
      interrupt: async () => {},
      close: async () => {},
    });
    const makeTestClient = (provider: string, id: string): AgentClient => ({
      provider,
      capabilities,
      createSession: async (_config: AgentSessionConfig) => makeSession(provider, id),
      resumeSession: async () => makeSession(provider, id),
      fetchCatalog: async () => ({ models: [], modes: [{ id: "default", label: "Default" }] }),
      isAvailable: async () => true,
    });

    const manager = new AgentManager({
      clients: {
        claude: makeTestClient("claude", "sess-root"),
        "claude-acp": makeTestClient("claude-acp", "sess-acp-child"),
      },
      logger,
    });
    const parent = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    const child = await manager.createAgent({ provider: "claude-acp", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
      labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
    });
    emit({
      type: "usage_updated",
      provider: "claude",
      usage: { contextWindowUsedTokens: 420_000, contextWindowMaxTokens: 1_000_000 },
    });
    await manager.flush();

    let nowMs = Date.now() + 1 * 60_000;
    const idleCompaction = createIdleCompaction({
      settings: DEFAULT_IDLE_COMPACTION_SETTINGS,
      runtimes: () => manager.getIdleCompactionCandidates(),
      logger,
      now: () => nowMs,
      schedule: () => () => {},
    });
    onTestFinished(() => idleCompaction.close());

    // Live idle ACP child blocks auto-compaction at +1m and +55m.
    expect((await idleCompaction.sweep()).compacted).toEqual([]);
    nowMs = Date.now() + 55 * 60_000;
    expect((await idleCompaction.sweep()).compacted).toEqual([]);
    expect(prompts).toEqual([]);

    // Close the child, refresh root activity, observe veto cleared, then compact at +54m.
    await manager.closeAgent(child.id);
    emit({
      type: "usage_updated",
      provider: "claude",
      usage: { contextWindowUsedTokens: 425_000, contextWindowMaxTokens: 1_000_000 },
    });
    await manager.flush();

    nowMs = Date.now() + 1 * 60_000;
    expect((await idleCompaction.sweep()).compacted).toEqual([]);
    nowMs += 54 * 60_000;
    const afterClose = await idleCompaction.sweep();
    expect(afterClose.compacted).toHaveLength(1);
    expect(prompts).toEqual(["/compact"]);
  });

  test("auto-compaction refuses when a direct child is closed but a grandchild is live (even after reopening independently), and recovers once the grandchild closes", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "paseo-idle-compact-grandchild-"));
    tempDirs.push(rootDir);
    const agentsDir = path.join(rootDir, "agents");
    const logger = createTestLogger();

    const prompts: AgentPromptInput[] = [];
    const subscribers = new Map<string, Set<(event: AgentStreamEvent) => void>>();
    const emitFor = (sessionId: string, event: AgentStreamEvent) => {
      for (const cb of subscribers.get(sessionId) ?? []) cb(event);
    };
    const capabilities: AgentCapabilityFlags = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    };
    let nextSessionIdx = 0;
    const makeSession = (fixedId?: string): AgentSession => {
      const id = fixedId ?? `sess-gc-${++nextSessionIdx}`;
      const subs = new Set<(event: AgentStreamEvent) => void>();
      subscribers.set(id, subs);
      return {
        provider: "claude",
        id,
        capabilities,
        supportsCompaction: () => true,
        canStopRuntime: async () => true,
        run: async (): Promise<AgentRunResult> => ({ sessionId: id, finalText: "", timeline: [] }),
        startTurn: async (prompt) => {
          prompts.push(prompt);
          const turnId = `turn-${randomUUID()}`;
          queueMicrotask(() => {
            emitFor(id, {
              type: "timeline",
              provider: "claude",
              turnId,
              item: {
                type: "compaction",
                status: "completed",
                trigger: "manual",
                preTokens: 420_000,
              },
            });
            emitFor(id, {
              type: "usage_updated",
              provider: "claude",
              turnId,
              usage: { contextWindowUsedTokens: 16_000, contextWindowMaxTokens: 1_000_000 },
            });
            emitFor(id, {
              type: "turn_completed",
              provider: "claude",
              turnId,
              usage: { contextWindowUsedTokens: 16_000, contextWindowMaxTokens: 1_000_000 },
            });
          });
          return { turnId };
        },
        subscribe: (cb) => {
          subs.add(cb);
          return () => subs.delete(cb);
        },
        async *streamHistory() {},
        getRuntimeInfo: async (): Promise<AgentRuntimeInfo> => ({
          provider: "claude",
          sessionId: id,
        }),
        getAvailableModes: async (): Promise<AgentMode[]> => [{ id: "default", label: "Default" }],
        getCurrentMode: async () => "default",
        setMode: async () => {},
        getPendingPermissions: (): AgentPermissionRequest[] => [],
        respondToPermission: async () => {},
        describePersistence: (): AgentPersistenceHandle => ({
          provider: "claude",
          sessionId: id,
          nativeHandle: id,
        }),
        interrupt: async () => {},
        close: async () => {},
      };
    };
    const makeClient = (): AgentClient => ({
      provider: "claude",
      capabilities,
      createSession: async (_config: AgentSessionConfig) => makeSession(),
      resumeSession: async (handle) => makeSession(handle.sessionId),
      fetchCatalog: async () => ({ models: [], modes: [{ id: "default", label: "Default" }] }),
      isAvailable: async () => true,
    });

    const storage1 = new AgentStorage(agentsDir, logger);
    const manager1 = new AgentManager({
      clients: { claude: makeClient() },
      registry: storage1,
      logger,
    });
    const rootA = await manager1.createAgent({ provider: "claude", cwd: rootDir }, randomUUID(), {
      workspaceId: "ws-1",
    });
    const childB = await manager1.createAgent({ provider: "claude", cwd: rootDir }, randomUUID(), {
      workspaceId: "ws-1",
      labels: { [PARENT_AGENT_ID_LABEL]: rootA.id },
    });
    const grandchildC = await manager1.createAgent(
      { provider: "claude", cwd: rootDir },
      randomUUID(),
      { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: childB.id } },
    );

    await manager1.closeAgent(childB.id);
    await manager1.closeAgent(rootA.id);
    await manager1.closeAgent(grandchildC.id);
    await manager1.flush();
    await storage1.flush();

    // Fresh manager over the same storage: reopen ONLY A and C (B stays closed and never live).
    const storage2 = new AgentStorage(agentsDir, logger);
    await storage2.initialize();
    const manager2 = new AgentManager({
      clients: { claude: makeClient() },
      registry: storage2,
      logger,
    });
    onTestFinished(async () => {
      await manager2.flush();
      await storage2.flush();
    });

    const reopenedA = await ensureAgentLoaded(rootA.id, {
      agentManager: manager2,
      agentStorage: storage2,
      logger,
    });
    await ensureAgentLoaded(grandchildC.id, {
      agentManager: manager2,
      agentStorage: storage2,
      logger,
    });
    const rootSessionId = reopenedA.persistence!.sessionId;
    emitFor(rootSessionId, {
      type: "usage_updated",
      provider: "claude",
      usage: { contextWindowUsedTokens: 420_000, contextWindowMaxTokens: 1_000_000 },
    });
    await manager2.flush();

    let nowMs = Date.now() + 1 * 60_000;
    const idleCompaction = createIdleCompaction({
      settings: DEFAULT_IDLE_COMPACTION_SETTINGS,
      runtimes: () => manager2.getIdleCompactionCandidates(),
      logger,
      now: () => nowMs,
      schedule: () => () => {},
    });
    onTestFinished(() => idleCompaction.close());

    // Live grandchild C (through closed child B) blocks auto-compaction of A.
    expect((await idleCompaction.sweep()).compacted).toEqual([]);
    nowMs = Date.now() + 55 * 60_000;
    expect((await idleCompaction.sweep()).compacted).toEqual([]);
    expect(prompts).toEqual([]);

    // Closing grandchild C + refreshing root activity allows auto-compaction to recover.
    await manager2.closeAgent(grandchildC.id);
    emitFor(rootSessionId, {
      type: "usage_updated",
      provider: "claude",
      usage: { contextWindowUsedTokens: 425_000, contextWindowMaxTokens: 1_000_000 },
    });
    await manager2.flush();

    nowMs = Date.now() + 1 * 60_000;
    expect((await idleCompaction.sweep()).compacted).toEqual([]);
    nowMs += 54 * 60_000;
    const afterClose = await idleCompaction.sweep();
    expect(afterClose.compacted).toHaveLength(1);
    expect(prompts).toEqual(["/compact"]);
  });

  test("daemon config resolves defaults, persists per-provider patches, and live-reloads agents.idleCompaction", async () => {
    const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-idle-compact-cfg-"));
    tempDirs.push(paseoHome);
    const logger = createTestLogger();

    const defaultCfg = loadConfig(paseoHome, { env: {} });
    expect(defaultCfg.idleCompaction).toEqual({
      enabled: true,
      minContextTokens: 400_000,
    });

    const toMutable = (cfg: { idleCompaction?: IdleCompactionSettings }) =>
      MutableDaemonConfigSchema.parse({
        relay: { enabled: false },
        mcp: { injectIntoAgents: false },
        idleCompaction: cfg.idleCompaction,
      });

    const store = new DaemonConfigStore(paseoHome, toMutable(defaultCfg), logger, {
      reloadSource: {
        resolve: (persisted) => {
          const reloaded = resolveReloadableConfig(persisted, { env: {} });
          return {
            mutable: toMutable(reloaded),
            overrideControlledPaths: reloaded.overrideControlledPaths,
          };
        },
      },
    });

    const idleCompaction = createIdleCompaction({
      settings: defaultCfg.idleCompaction!,
      runtimes: () => [],
      logger,
      schedule: () => () => {},
    });
    const unsubscribe = connectIdleCompactionConfig(store, idleCompaction);
    onTestFinished(async () => {
      unsubscribe();
      await idleCompaction.close();
    });

    await store.patch({
      idleCompaction: {
        providers: {
          claude: { idleMinutes: 4 },
          codex: { idleMinutes: 60 },
        },
      },
    });
    // Patching one provider preserves other persisted provider overrides.
    await store.patch({
      idleCompaction: {
        providers: {
          opencode: { enabled: false },
        },
      },
    });
    expect(loadPersistedConfig(paseoHome).agents?.idleCompaction).toEqual({
      providers: {
        claude: { idleMinutes: 4 },
        codex: { idleMinutes: 60 },
        opencode: { enabled: false },
      },
    });
    expect(idleCompaction.getSettings()).toEqual({
      enabled: true,
      minContextTokens: 400_000,
      providers: {
        claude: { idleMinutes: 4 },
        codex: { idleMinutes: 60 },
        opencode: { enabled: false },
      },
    });

    const currentPersisted = loadPersistedConfig(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({
        ...currentPersisted,
        agents: {
          ...currentPersisted.agents,
          idleCompaction: {
            enabled: true,
            minContextTokens: 250_000,
            providers: {
              claude: { idleMinutes: 50 },
              antigravity: { enabled: false },
            },
          },
        },
      }),
    );

    const reloadResult = await store.reload();
    expect(reloadResult.appliedPaths).toContain("agents.idleCompaction");
    expect(reloadResult.restartRequiredPaths).toEqual([]);
    expect(idleCompaction.getSettings()).toEqual({
      enabled: true,
      minContextTokens: 250_000,
      providers: {
        claude: { idleMinutes: 50 },
        antigravity: { enabled: false },
      },
    });
  });
});
