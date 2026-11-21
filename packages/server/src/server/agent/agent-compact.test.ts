import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  AgentCompactionRefusedError,
  AgentCompactionUnsupportedError,
  AgentManager,
} from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import { createAgentMcpServer } from "./mcp-server.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { AgentTurnBusyError, sendPreparedPromptToAgent } from "./agent-prompt.js";
import { createAgentMessageDelivery } from "./agent-messages/delivery.js";
import {
  AgentCompactionAdmitError,
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentMode,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentSessionConfig,
  type AgentStreamEvent,
} from "./agent-sdk-types.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";

const BASE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class CompactTestSession implements AgentSession {
  readonly capabilities = BASE_CAPABILITIES;
  readonly id: string;
  readonly prompts: AgentPromptInput[] = [];
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, AgentPermissionRequest>();
  private activeTurnFinish: (() => void) | null = null;
  private closed = false;
  providerLocalSafe = true;

  constructor(
    readonly provider: string,
    private readonly options: {
      supportsCompaction?: boolean;
      omitCanStopRuntime?: boolean;
      onCanStopRuntime?: () => Promise<boolean> | boolean;
      onStartTurn?: (
        prompt: AgentPromptInput,
        options: AgentRunOptions | undefined,
      ) => Promise<void> | void;
      onPrompt?: (
        prompt: AgentPromptInput,
        emit: (event: AgentStreamEvent) => void,
        turnId: string,
      ) => Promise<void> | void;
    } = {},
  ) {
    this.id = `session-${randomUUID()}`;
    if (!options.omitCanStopRuntime) {
      this.canStopRuntime = async () => {
        if (!this.providerLocalSafe) return false;
        if (options.onCanStopRuntime) {
          return await options.onCanStopRuntime();
        }
        return this.activeTurnFinish === null && this.pendingPermissions.size === 0;
      };
    }
  }

  supportsCompaction?: () => boolean;
  canStopRuntime?: () => Promise<boolean>;

  configureSupport(): this {
    if (this.options.supportsCompaction !== undefined) {
      const value = this.options.supportsCompaction;
      this.supportsCompaction = () => value;
    }
    return this;
  }

  emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  seedUsage(usedTokens: number, maxTokens = 200_000): void {
    this.emit({
      type: "usage_updated",
      provider: this.provider,
      usage: { contextWindowUsedTokens: usedTokens, contextWindowMaxTokens: maxTokens },
    });
  }

  addPendingPermission(request: AgentPermissionRequest): void {
    this.pendingPermissions.set(request.id, request);
    this.emit({ type: "permission_requested", provider: this.provider, request });
  }

  finishHeldTurn(): void {
    this.activeTurnFinish?.();
    this.activeTurnFinish = null;
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    await this.options.onStartTurn?.(prompt, options);
    if (options?.admitBeforeDispatch) {
      if (!this.providerLocalSafe || options.admitBeforeDispatch() !== true) {
        throw new AgentCompactionAdmitError("Session became busy before compaction dispatch");
      }
    }
    this.prompts.push(prompt);
    const turnId = `turn-${randomUUID()}`;
    if (this.options.onPrompt) {
      void Promise.resolve(this.options.onPrompt(prompt, (event) => this.emit(event), turnId));
      return { turnId };
    }
    if (prompt === "HOLD_TURN") {
      this.emit({ type: "turn_started", provider: this.provider, turnId });
      this.activeTurnFinish = () => {
        this.emit({ type: "turn_completed", provider: this.provider, turnId });
      };
      return { turnId };
    }
    if (typeof prompt === "string" && prompt.startsWith("/compact")) {
      queueMicrotask(() => {
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "compaction", status: "loading" },
        });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "compaction",
            status: "completed",
            trigger: "manual",
            preTokens: 215_000,
          },
        });
        this.emit({
          type: "usage_updated",
          provider: this.provider,
          turnId,
          usage: { contextWindowUsedTokens: 18_400, contextWindowMaxTokens: 200_000 },
        });
        this.emit({
          type: "turn_completed",
          provider: this.provider,
          turnId,
          usage: { contextWindowUsedTokens: 18_400, contextWindowMaxTokens: 200_000 },
        });
      });
      return { turnId };
    }
    queueMicrotask(() => {
      this.emit({ type: "turn_completed", provider: this.provider, turnId });
    });
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: this.provider, sessionId: this.id };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [{ id: "default", label: "Default" }];
  }

  async getCurrentMode(): Promise<string | null> {
    return "default";
  }

  async setMode(): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingPermissions.values()];
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    this.pendingPermissions.delete(requestId);
    this.emit({
      type: "permission_resolved",
      provider: this.provider,
      requestId,
      resolution: response,
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    return { provider: this.provider, sessionId: this.id, nativeHandle: this.id };
  }

  async interrupt(): Promise<void> {
    this.finishHeldTurn();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

function makeClient(provider: string, createSessionImpl: () => AgentSession): AgentClient {
  return {
    provider,
    capabilities: BASE_CAPABILITIES,
    async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
      return createSessionImpl();
    },
    async resumeSession(): Promise<AgentSession> {
      return createSessionImpl();
    },
    async fetchCatalog() {
      return { models: [], modes: [{ id: "default", label: "Default" }] };
    },
    async isAvailable() {
      return true;
    },
  };
}

describe("AgentManager.compactAgent (Claude-only v1)", () => {
  test("compacts a Claude session with raw /compact and reports before/after context size", async () => {
    const root = await createTempDir("paseo-compact-slash-");
    const logger = createTestLogger();
    const session = new CompactTestSession("claude", {
      supportsCompaction: true,
    }).configureSupport();
    const manager = new AgentManager({
      clients: { claude: makeClient("claude", () => session) },
      logger,
    });

    const agent = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    session.seedUsage(210_000, 200_000);
    await manager.flush();

    const result = await manager.compactAgent(agent.id, { instructions: "preserve test state" });

    expect(session.prompts).toEqual(["/compact preserve test state"]);
    expect(result).toEqual({
      agentId: agent.id,
      provider: "claude",
      contextTokensBefore: 215_000,
      contextTokensAfter: 18_400,
      contextWindowMaxTokens: 200_000,
      status: "idle",
    });
  });

  test("does not report stale pre-compaction tokens when provider emits no post-compaction usage", async () => {
    const root = await createTempDir("paseo-compact-no-post-");
    const logger = createTestLogger();
    const session = new CompactTestSession("claude", {
      supportsCompaction: true,
      onPrompt: (_prompt, emit, turnId) => {
        queueMicrotask(() => {
          emit({
            type: "usage_updated",
            provider: "claude",
            turnId,
            usage: { contextWindowUsedTokens: 199_000, contextWindowMaxTokens: 200_000 },
          });
          emit({
            type: "timeline",
            provider: "claude",
            turnId,
            item: {
              type: "compaction",
              status: "completed",
              trigger: "manual",
              preTokens: 198_500,
            },
          });
          emit({ type: "turn_completed", provider: "claude", turnId });
        });
      },
    }).configureSupport();
    const manager = new AgentManager({
      clients: { claude: makeClient("claude", () => session) },
      logger,
    });

    const agent = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    session.seedUsage(198_000, 200_000);
    await manager.flush();

    const result = await manager.compactAgent(agent.id);

    expect(result.contextTokensBefore).toBe(198_500);
    expect(result.contextTokensAfter).toBeNull();
  });

  test("fails when /compact finishes without a compact_boundary and preserves nullable token counts for a confirmed boundary", async () => {
    const root = await createTempDir("paseo-compact-boundary-");
    const logger = createTestLogger();

    // Case 1: ordinary successful turn (e.g. "Unknown command: /compact") with no compact_boundary.
    const unknownCmdSession = new CompactTestSession("claude", {
      supportsCompaction: true,
      onPrompt: (_prompt, emit, turnId) => {
        emit({
          type: "timeline",
          provider: "claude",
          turnId,
          item: { type: "assistant_message", text: "Unknown command: /compact" },
        });
        emit({ type: "turn_completed", provider: "claude", turnId });
      },
    }).configureSupport();

    // Case 2: spinner cleanup compaction:completed without trigger (no real compact_boundary).
    const cleanupOnlySession = new CompactTestSession("claude", {
      supportsCompaction: true,
      onPrompt: (_prompt, emit, turnId) => {
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
          item: { type: "compaction", status: "completed" },
        });
        emit({ type: "turn_completed", provider: "claude", turnId });
      },
    }).configureSupport();

    // Case 3: confirmed compact_boundary (trigger: "manual") with no pre/post token numbers.
    const confirmedNullableSession = new CompactTestSession("claude", {
      supportsCompaction: true,
      onPrompt: (_prompt, emit, turnId) => {
        emit({
          type: "timeline",
          provider: "claude",
          turnId,
          item: { type: "compaction", status: "completed", trigger: "manual" },
        });
        emit({ type: "turn_completed", provider: "claude", turnId });
      },
    }).configureSupport();

    const queue = [unknownCmdSession, cleanupOnlySession, confirmedNullableSession];
    const manager = new AgentManager({
      clients: { claude: makeClient("claude", () => queue.shift()!) },
      logger,
    });

    const a1 = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    await expect(manager.compactAgent(a1.id)).rejects.toThrow("no compact_boundary");

    const a2 = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    await expect(manager.compactAgent(a2.id)).rejects.toThrow("no compact_boundary");

    const a3 = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    const confirmed = await manager.compactAgent(a3.id);
    expect(confirmed.contextTokensBefore).toBeNull();
    expect(confirmed.contextTokensAfter).toBeNull();
    expect(confirmed.status).toBe("idle");
  });

  test.each(["codex", "opencode", "antigravity", "copilot", "pi", "omp"])(
    "returns unsupported for non-Claude provider %s in v1",
    async (provider) => {
      const root = await createTempDir(`paseo-compact-unsup-${provider}-`);
      const logger = createTestLogger();
      // Even if a non-Claude stub returned true for supportsCompaction, v1 enforces Claude-only.
      const session = new CompactTestSession(provider, {
        supportsCompaction: true,
      }).configureSupport();
      const manager = new AgentManager({
        clients: { [provider]: makeClient(provider, () => session) },
        logger,
      });

      const agent = await manager.createAgent({ provider, cwd: root }, randomUUID(), {
        workspaceId: "ws-1",
      });

      await expect(manager.compactAgent(agent.id)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionUnsupportedError &&
          error.message === `Compaction is unsupported for ${provider}`,
      );
      expect(session.prompts).toEqual([]);
    },
  );

  test("refuses compaction when the agent is mid-turn", async () => {
    const root = await createTempDir("paseo-compact-busy-");
    const logger = createTestLogger();
    const session = new CompactTestSession("claude", {
      supportsCompaction: true,
    }).configureSupport();
    const manager = new AgentManager({
      clients: { claude: makeClient("claude", () => session) },
      logger,
    });

    const agent = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    const stream = manager.streamAgent(agent.id, "HOLD_TURN");
    const draining = (async () => {
      for await (const _ of stream) {
        // drain
      }
    })();

    await vi.waitFor(() => {
      expect(manager.getAgent(agent.id)?.lifecycle).toBe("running");
    });

    await expect(manager.compactAgent(agent.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError &&
        error.reason === "mid_turn" &&
        error.message.includes("mid-turn"),
    );

    session.finishHeldTurn();
    await draining;
  });

  test("refuses compaction when the agent has pending permissions", async () => {
    const root = await createTempDir("paseo-compact-perm-");
    const logger = createTestLogger();
    const session = new CompactTestSession("claude", {
      supportsCompaction: true,
    }).configureSupport();
    const manager = new AgentManager({
      clients: { claude: makeClient("claude", () => session) },
      logger,
    });

    const agent = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    session.addPendingPermission({
      id: "perm-1",
      provider: "claude",
      name: "Bash",
      kind: "tool",
    });

    await vi.waitFor(() => {
      expect(manager.getPendingPermissions(agent.id)).toHaveLength(1);
    });

    await expect(manager.compactAgent(agent.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError &&
        error.reason === "pending_permissions" &&
        error.message.includes("pending permission"),
    );
  });

  test("resumes a closed durable agent and refuses an archived agent", async () => {
    const root = await createTempDir("paseo-compact-closed-");
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const sessions: CompactTestSession[] = [];
    const manager = new AgentManager({
      clients: {
        claude: makeClient("claude", () => {
          const s = new CompactTestSession("claude", {
            supportsCompaction: true,
          }).configureSupport();
          sessions.push(s);
          return s;
        }),
      },
      registry: storage,
      logger,
    });

    const closedAgent = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    await manager.closeAgent(closedAgent.id);

    const compacted = await manager.compactAgent(closedAgent.id);
    expect(compacted.contextTokensBefore).toBe(215_000);
    expect(compacted.contextTokensAfter).toBe(18_400);
    expect(sessions).toHaveLength(2);

    const archivedAgent = await manager.createAgent(
      { provider: "claude", cwd: root },
      randomUUID(),
      { workspaceId: "ws-1" },
    );
    await manager.archiveAgent(archivedAgent.id);
    await expect(manager.compactAgent(archivedAgent.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError &&
        error.reason === "archived" &&
        error.message.includes("archived"),
    );

    await manager.closeAgent(closedAgent.id);
    await manager.flush();
    await storage.flush();
  });

  test("enforces shared work protections: queued messages, background work, throwing/missing probe, and rolls back run lock", async () => {
    const root = await createTempDir("paseo-compact-safe-");
    const logger = createTestLogger();
    const sessions: CompactTestSession[] = [];
    let omitNextProbe = false;
    const manager = new AgentManager({
      clients: {
        claude: makeClient("claude", () => {
          const s = new CompactTestSession("claude", {
            supportsCompaction: true,
            omitCanStopRuntime: omitNextProbe,
          }).configureSupport();
          omitNextProbe = false;
          sessions.push(s);
          return s;
        }),
      },
      logger,
    });

    const parent = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    const parentSession = sessions[0]!;

    // 1. Protected agent (queued messages / pending finish subscriptions) is refused.
    let protectedIds = new Set<string>([parent.id]);
    manager.setCompactionProtectionCheck((id) => protectedIds.has(id));
    await expect(manager.compactAgent(parent.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError &&
        error.message.includes("queued messages or pending child notifications"),
    );
    protectedIds = new Set();

    // 2. Running daemon background work is refused.
    manager.setDaemonBackgroundWork({
      agentId: parent.id,
      namespace: "change-request-watch",
      id: "pr-1",
      kind: "monitor",
      description: "Watching PR #1",
      startedAt: new Date().toISOString(),
      countsAsRunning: true,
      stop: async () => {},
    });
    await expect(manager.compactAgent(parent.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError &&
        error.message.includes("active background work"),
    );
    manager.removeDaemonBackgroundWork({
      agentId: parent.id,
      namespace: "change-request-watch",
      id: "pr-1",
    });

    // 3. Throwing provider probe fails closed and rolls back run lock.
    parentSession.canStopRuntime = async () => {
      throw new Error("probe boom");
    };
    await expect(manager.compactAgent(parent.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError &&
        error.message.includes("provider runtime reported active work"),
    );
    expect(manager.hasInFlightRun(parent.id)).toBe(false);
    parentSession.canStopRuntime = async () => true;

    // 4. Missing canStopRuntime on root fails closed and rolls back lock.
    omitNextProbe = true;
    const noProbe = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    await expect(manager.compactAgent(noProbe.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError &&
        error.message.includes("cannot verify runtime safety"),
    );
    expect(manager.hasInFlightRun(noProbe.id)).toBe(false);
    expect(parentSession.prompts).toEqual([]);
  });

  test("refuses compaction whenever the root has any live descendant (even idle) or one spawns before dispatch, and allows compaction once closed or archived", async () => {
    const root = await createTempDir("paseo-compact-descendant-");
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    let onRootStartTurn: (() => Promise<void> | void) | undefined;
    const claudeSessions: CompactTestSession[] = [];
    const manager = new AgentManager({
      clients: {
        claude: makeClient("claude", () => {
          const isRoot = claudeSessions.length === 0;
          const s = new CompactTestSession("claude", {
            supportsCompaction: true,
            onStartTurn: isRoot ? () => onRootStartTurn?.() : undefined,
          }).configureSupport();
          claudeSessions.push(s);
          return s;
        }),
        "claude-acp": makeClient("claude-acp", () =>
          new CompactTestSession("claude-acp", { supportsCompaction: false }).configureSupport(),
        ),
      },
      registry: storage,
      logger,
    });

    try {
      const parent = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
        workspaceId: "ws-1",
      });
      const parentSession = claudeSessions[0]!;

      // 1. Live idle Claude descendant refuses manual compaction.
      const idleClaudeChild = await manager.createAgent(
        { provider: "claude", cwd: root },
        randomUUID(),
        { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
      );
      await expect(manager.compactAgent(parent.id)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError &&
          error.reason === "not_eligible" &&
          error.message.includes("live descendant agent"),
      );
      expect(parentSession.prompts).toEqual([]);
      expect(manager.hasInFlightRun(parent.id)).toBe(false);

      // 2. Closing the descendant unblocks compaction.
      await manager.closeAgent(idleClaudeChild.id);
      const afterClose = await manager.compactAgent(parent.id);
      expect(afterClose.contextTokensAfter).toBe(18_400);
      expect(parentSession.prompts).toEqual(["/compact"]);

      // 3. Live idle ACP descendant refuses manual compaction; archiving unblocks it.
      const idleAcpChild = await manager.createAgent(
        { provider: "claude-acp", cwd: root },
        randomUUID(),
        { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
      );
      await expect(manager.compactAgent(parent.id)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError &&
          error.reason === "not_eligible" &&
          error.message.includes("live descendant agent"),
      );
      expect(parentSession.prompts).toHaveLength(1);
      await manager.archiveAgent(idleAcpChild.id);

      // 4. Descendant spawned while root awaits startTurn (simulating ensureQuery) is caught
      //    synchronously by admitBeforeDispatch, refusing compaction and rolling back the run slot.
      let lateChildId: string | null = null;
      onRootStartTurn = async () => {
        const lateChild = await manager.createAgent(
          { provider: "claude-acp", cwd: root },
          randomUUID(),
          { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
        );
        lateChildId = lateChild.id;
      };
      await expect(manager.compactAgent(parent.id)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError && error.reason === "not_eligible",
      );
      onRootStartTurn = undefined;
      expect(lateChildId).not.toBeNull();
      expect(parentSession.prompts).toHaveLength(1);
      expect(manager.hasInFlightRun(parent.id)).toBe(false);

      // Closing the late child allows compaction again.
      await manager.closeAgent(lateChildId!);
      const finalCompact = await manager.compactAgent(parent.id);
      expect(finalCompact.contextTokensAfter).toBe(18_400);
      expect(parentSession.prompts).toHaveLength(2);
    } finally {
      await manager.flush();
      await storage.flush();
    }
  });

  test("refuses compaction when a direct child is closed but a grandchild is still live (including after reopening independently), and recovers once the grandchild closes", async () => {
    const rootDir = await createTempDir("paseo-compact-grandchild-");
    const agentsDir = path.join(rootDir, "agents");
    const logger = createTestLogger();
    const storage1 = new AgentStorage(agentsDir, logger);
    const sessions1: CompactTestSession[] = [];
    const manager1 = new AgentManager({
      clients: {
        claude: makeClient("claude", () => {
          const s = new CompactTestSession("claude", {
            supportsCompaction: true,
          }).configureSupport();
          sessions1.push(s);
          return s;
        }),
      },
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
    // Unrelated closed root X + live child Y must NOT falsely block A once C closes.
    const otherRootX = await manager1.createAgent(
      { provider: "claude", cwd: rootDir },
      randomUUID(),
      { workspaceId: "ws-1" },
    );
    const otherChildY = await manager1.createAgent(
      { provider: "claude", cwd: rootDir },
      randomUUID(),
      { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: otherRootX.id } },
    );

    // Close direct child B while grandchild C remains live -> A must STILL be refused.
    await manager1.closeAgent(childB.id);
    await manager1.closeAgent(otherRootX.id);
    await expect(manager1.compactAgent(rootA.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError &&
        error.reason === "not_eligible" &&
        error.message.includes(`live descendant agent ${grandchildC.id}`),
    );
    expect(sessions1[0]!.prompts).toEqual([]);
    expect(manager1.hasInFlightRun(rootA.id)).toBe(false);

    // Close all live agents and reopen ONLY A, C, and unrelated Y in a brand-new manager
    // over the same durable storage (B and X are never loaded live in manager2).
    await manager1.closeAgent(rootA.id);
    await manager1.closeAgent(grandchildC.id);
    await manager1.closeAgent(otherChildY.id);
    await manager1.flush();
    await storage1.flush();

    const storage2 = new AgentStorage(agentsDir, logger);
    const sessions2 = new Map<string, CompactTestSession>();
    const manager2 = new AgentManager({
      clients: {
        claude: makeClient("claude", () => {
          const s = new CompactTestSession("claude", {
            supportsCompaction: true,
          }).configureSupport();
          sessions2.set(s.id, s);
          return s;
        }),
      },
      registry: storage2,
      logger,
    });

    try {
      await ensureAgentLoaded(rootA.id, {
        agentManager: manager2,
        agentStorage: storage2,
        logger,
      });
      await ensureAgentLoaded(grandchildC.id, {
        agentManager: manager2,
        agentStorage: storage2,
        logger,
      });
      await ensureAgentLoaded(otherChildY.id, {
        agentManager: manager2,
        agentStorage: storage2,
        logger,
      });
      expect(manager2.getAgent(childB.id)).toBeNull();

      // Even though B was never live in manager2, durable ancestry resolves C -> B -> A and refuses!
      await expect(manager2.compactAgent(rootA.id)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError &&
          error.reason === "not_eligible" &&
          error.message.includes(`live descendant agent ${grandchildC.id}`),
      );
      expect(manager2.hasInFlightRun(rootA.id)).toBe(false);

      // Closing grandchild C restores eligibility for root A (while unrelated Y -> closed X stays open!).
      await manager2.closeAgent(grandchildC.id);
      const recovered = await manager2.compactAgent(rootA.id);
      expect(recovered.contextTokensAfter).toBe(18_400);

      // Conservative fallback: a live agent whose parent cannot be resolved refuses compaction.
      const orphan = await manager2.createAgent(
        { provider: "claude", cwd: rootDir },
        randomUUID(),
        { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: "missing-parent-id" } },
      );
      await expect(manager2.compactAgent(rootA.id)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError &&
          error.reason === "not_eligible" &&
          error.message.includes(`cannot verify ancestry of live agent ${orphan.id}`),
      );
      await manager2.closeAgent(orphan.id);
    } finally {
      await manager2.flush();
      await storage2.flush();
    }
  });

  test("compaction occupies the ordinary foreground run slot so real queued agent messages get AgentTurnBusyError, requeue, and deliver after compaction", async () => {
    const root = await createTempDir("paseo-compact-delivery-");
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const probeGate = deferred<boolean>();
    const rootSession = new CompactTestSession("claude", {
      supportsCompaction: true,
      onCanStopRuntime: () => probeGate.promise,
    }).configureSupport();
    const manager = new AgentManager({
      clients: {
        claude: makeClient("claude", () => rootSession),
      },
      registry: storage,
      logger,
    });

    const target = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });

    const deliveryErrors: unknown[] = [];
    const timers: Array<{ fn: () => void; canceled: boolean }> = [];
    let simulateRaceBypassIsRunning = true;
    const delivery = createAgentMessageDelivery({
      schedule: (_delayMs, callback) => {
        const entry = { fn: callback, canceled: false };
        timers.push(entry);
        return () => {
          entry.canceled = true;
        };
      },
      // Simulate a race where delivery enters dispatch() right as compaction holds the run slot,
      // proving sendPreparedPromptToAgent / streamAgent throws typed AgentTurnBusyError (so
      // delivery.ts requeues instead of dropping the message).
      isRunning: (id) => (simulateRaceBypassIsRunning ? false : manager.hasInFlightRun(id)),
      subscribe: (onStateChange) =>
        manager.subscribe((event) => {
          if (event.type === "agent_state") {
            onStateChange(event.agent.id);
          }
        }),
      dispatch: async (request) =>
        (
          await sendPreparedPromptToAgent({
            agentManager: manager,
            agentStorage: storage,
            agentId: request.recipientId,
            prompt: request.prompt,
            logger,
            idleOnly: request.idleOnly,
            admit: request.admit,
            onDispatch: request.onDispatch,
            activeTurnBehavior: request.activeTurnBehavior,
          })
        ).disposition,
      onError: (error) => {
        deliveryErrors.push(error);
      },
    });

    try {
      // Start compaction; pause inside root's canStopRuntime probe.
      const compactPromise = manager.compactAgent(target.id);
      await vi.waitFor(() => {
        expect(manager.hasInFlightRun(target.id)).toBe(true);
      });

      // Direct streamAgent on the target throws typed AgentTurnBusyError (never plain Error).
      expect(() => manager.streamAgent(target.id, "direct-root")).toThrow(AgentTurnBusyError);

      // Enqueue a real agent message through createAgentMessageDelivery to the target.
      const queuedDelivery = delivery.enqueue({
        recipientId: target.id,
        prompt: "Follow up on root",
        activeTurnBehavior: "steer",
      });

      // Fire quiet-window timer while compaction holds the run slot:
      // delivery enters dispatch(), hits AgentTurnBusyError, and requeues cleanly.
      for (const t of timers.splice(0)) {
        if (!t.canceled) t.fn();
      }
      const countActiveTimers = () => timers.filter((t) => !t.canceled).length;
      await vi.waitFor(() => {
        expect(countActiveTimers()).toBeGreaterThanOrEqual(1);
      });
      expect(deliveryErrors).toEqual([]);
      expect(rootSession.prompts).toEqual([]);

      // Release probe -> compaction runs -> run slot releases -> requeued message delivers cleanly!
      simulateRaceBypassIsRunning = false;
      probeGate.resolve(true);
      const compactResult = await compactPromise;
      expect(compactResult.contextTokensAfter).toBe(18_400);

      // Fire any requeued retry timer if subscribe didn't already dispatch.
      for (const t of timers.splice(0)) {
        if (!t.canceled) t.fn();
      }
      await expect(queuedDelivery.dispatched).resolves.toBe("turn_started");
      expect(deliveryErrors).toEqual([]);
      expect(rootSession.prompts[0]).toBe("/compact");
      expect(rootSession.prompts.some((p) => String(p).includes("Follow up on root"))).toBe(true);
    } finally {
      await delivery.close();
      await manager.flush();
      await storage.flush();
    }
  });
});

describe("ClaudeAgentSession compaction safety & dispatch gate", () => {
  test("canStopRuntime returns false while compacting or compactionMarkerOpen is true", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({ provider: "claude", cwd: "/tmp" });
    try {
      expect(session.supportsCompaction?.()).toBe(true);
      expect(await session.canStopRuntime?.()).toBe(true);

      const internals = session as unknown as {
        compacting: boolean;
        compactionMarkerOpen: boolean;
      };
      internals.compacting = true;
      expect(await session.canStopRuntime?.()).toBe(false);
      internals.compacting = false;

      internals.compactionMarkerOpen = true;
      expect(await session.canStopRuntime?.()).toBe(false);
      internals.compactionMarkerOpen = false;

      expect(await session.canStopRuntime?.()).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("startTurn rechecks Claude safety and admitBeforeDispatch after ensureHistoryReady and ensureQuery without pushing or mutating state", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({ provider: "claude", cwd: "/tmp" });
    try {
      const pushed: unknown[] = [];
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));

      const internals = session as unknown as {
        activeForegroundTurnId: string | null;
        autonomousTurn: { id: string } | null;
        compacting: boolean;
        input: { push: (msg: unknown) => void; end: () => void } | null;
        ensureHistoryReady: () => Promise<void>;
        ensureQuery: () => Promise<void>;
        startQueryPump: () => void;
        completeAutonomousTurn: () => void;
      };
      internals.input = {
        push: (msg: unknown) => pushed.push(msg),
        end: () => {},
      };
      const completeAutonomousSpy = vi.spyOn(internals, "completeAutonomousTurn");

      // Case 1: autonomous turn starts while awaiting ensureHistoryReady().
      internals.ensureHistoryReady = async () => {
        internals.autonomousTurn = { id: "auto-turn-1" };
      };
      internals.ensureQuery = async () => {};
      await expect(
        session.startTurn("/compact", { admitBeforeDispatch: () => true }),
      ).rejects.toBeInstanceOf(AgentCompactionAdmitError);
      expect(internals.activeForegroundTurnId).toBeNull();
      expect(completeAutonomousSpy).not.toHaveBeenCalled();
      expect(pushed).toEqual([]);
      expect(events).toEqual([]);
      internals.autonomousTurn = null;

      // Case 2: compacting becomes true (or admitBeforeDispatch flips false) while awaiting ensureQuery().
      internals.ensureHistoryReady = async () => {};
      let admit = true;
      internals.ensureQuery = async () => {
        admit = false;
      };
      await expect(
        session.startTurn("/compact", { admitBeforeDispatch: () => admit }),
      ).rejects.toBeInstanceOf(AgentCompactionAdmitError);
      expect(internals.activeForegroundTurnId).toBeNull();
      expect(pushed).toEqual([]);
      expect(events).toEqual([]);

      // Case 3: compacting flag flips true during ensureQuery() even when admitBeforeDispatch returns true.
      internals.ensureQuery = async () => {
        internals.compacting = true;
      };
      await expect(
        session.startTurn("/compact", { admitBeforeDispatch: () => true }),
      ).rejects.toBeInstanceOf(AgentCompactionAdmitError);
      expect(internals.activeForegroundTurnId).toBeNull();
      expect(pushed).toEqual([]);
      expect(events).toEqual([]);
      internals.compacting = false;

      // Case 4: already-queued microtask flips autonomousTurn before ensureQuery continuation runs ->
      // inline check refuses without calling completeAutonomousTurn or pushing.
      const queryGate = deferred<void>();
      internals.ensureQuery = () => queryGate.promise;
      const pendingTurn = session.startTurn("/compact", { admitBeforeDispatch: () => true });
      queueMicrotask(() => {
        internals.autonomousTurn = { id: "late-auto-1" };
      });
      queryGate.resolve();
      await expect(pendingTurn).rejects.toBeInstanceOf(AgentCompactionAdmitError);
      expect(internals.activeForegroundTurnId).toBeNull();
      expect(completeAutonomousSpy).not.toHaveBeenCalled();
      expect(pushed).toEqual([]);
      expect(events).toEqual([]);
      internals.autonomousTurn = null;

      // Case 5: two-hop queueMicrotask from the ensureQuery stub flips provider state.
      // Because the final post-query check is inline in startTurn with zero awaits before
      // this.input.push(), push NEVER observes busy state (either synchronous dispatch completes
      // before the flip runs, or compaction is refused if the flip already ran), and
      // completeAutonomousTurn is never called.
      let observedBusyAtPush = false;
      const twoHopDone = deferred<void>();
      const flipBusyState = () => {
        internals.compacting = true;
        internals.autonomousTurn = { id: "two-hop-auto" };
        twoHopDone.resolve();
      };
      const scheduleSecondHop = () => {
        queueMicrotask(flipBusyState);
      };
      internals.input = {
        push: (msg: unknown) => {
          observedBusyAtPush = internals.compacting || internals.autonomousTurn !== null;
          pushed.push(msg);
        },
        end: () => {},
      };
      internals.ensureQuery = async () => {
        queueMicrotask(scheduleSecondHop);
      };
      internals.startQueryPump = () => {};
      let outcome: "dispatched" | "refused" = "dispatched";
      try {
        await session.startTurn("/compact", { admitBeforeDispatch: () => true });
      } catch (error) {
        if (error instanceof AgentCompactionAdmitError) {
          outcome = "refused";
        } else {
          throw error;
        }
      }
      await twoHopDone.promise;
      expect(observedBusyAtPush).toBe(false);
      expect(completeAutonomousSpy).not.toHaveBeenCalled();
      if (outcome === "dispatched") {
        expect(pushed).toHaveLength(1);
      } else {
        expect(pushed).toEqual([]);
        expect(events).toEqual([]);
      }
    } finally {
      await session.close();
    }
  });

  test("turns compact_result=failed into turn_failed", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({ logger });
    const session = await client.createSession({ provider: "claude", cwd: "/tmp" });
    try {
      const internals = session as unknown as {
        appendSystemMessageEvents: (message: unknown, events: AgentStreamEvent[]) => void;
        appendResultEvents: (message: unknown, events: AgentStreamEvent[]) => void;
      };
      const events: AgentStreamEvent[] = [];
      internals.appendSystemMessageEvents(
        { type: "system", subtype: "status", status: "compacting" },
        events,
      );
      internals.appendSystemMessageEvents(
        {
          type: "system",
          subtype: "status",
          status: null,
          compact_result: "failed",
          compact_error: "Nothing to compact",
        },
        events,
      );
      internals.appendResultEvents(
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "",
          uuid: "res-1",
          session_id: "sess-1",
          total_cost_usd: 0,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
        events,
      );

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: { type: "compaction", status: "loading" },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          item: { type: "compaction", status: "completed" },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn_failed",
          error: "Nothing to compact",
        }),
      );
    } finally {
      await session.close();
    }
  });
});

describe("compact_agent MCP tool", () => {
  async function createMcpHarness(
    clients: Record<string, AgentClient>,
    options?: { pendingMessageIds?: Set<string>; pendingFinishCallerIds?: Set<string> },
  ) {
    const root = await createTempDir("paseo-mcp-compact-");
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const manager = new AgentManager({ clients, registry: storage, logger });
    const server = await createAgentMcpServer({
      agentManager: manager,
      agentStorage: storage,
      providerSnapshotManager: createProviderSnapshotManagerStub({
        providers: Object.keys(clients),
      }),
      logger,
      callerContext: { agentId: "caller-concierge" },
      ...(options?.pendingMessageIds
        ? {
            agentMessages: () =>
              ({
                hasPending: (id: string) => options.pendingMessageIds!.has(id),
              }) as unknown as Parameters<typeof createAgentMcpServer>[0]["agentMessages"] extends
                | (() => infer R)
                | undefined
                ? R
                : never,
          }
        : {}),
      ...(options?.pendingFinishCallerIds
        ? {
            finishSubscriptions: () =>
              ({
                hasPendingForCaller: (id: string) => options.pendingFinishCallerIds!.has(id),
              }) as unknown as Parameters<
                typeof createAgentMcpServer
              >[0]["finishSubscriptions"] extends (() => infer R) | undefined
                ? R
                : never,
          }
        : {}),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    return {
      root,
      manager,
      storage,
      mcpClient,
      close: async () => {
        await mcpClient.close();
        await server.close();
        await manager.flush();
        await storage.flush();
      },
    };
  }

  test("compacts an idle Claude agent without wrapping /compact and refuses busy or non-Claude targets", async () => {
    const claudeSession = new CompactTestSession("claude", {
      supportsCompaction: true,
    }).configureSupport();
    const codexSession = new CompactTestSession("codex", {
      supportsCompaction: false,
    }).configureSupport();
    const harness = await createMcpHarness({
      claude: makeClient("claude", () => claudeSession),
      codex: makeClient("codex", () => codexSession),
    });

    try {
      const { tools } = await harness.mcpClient.listTools();
      expect(tools.some((tool) => tool.name === "compact_agent")).toBe(true);

      const target = await harness.manager.createAgent(
        { provider: "claude", cwd: harness.root },
        randomUUID(),
        { workspaceId: "ws-1" },
      );
      claudeSession.seedUsage(212_000, 200_000);
      await harness.manager.flush();

      const res = await harness.mcpClient.callTool({
        name: "compact_agent",
        arguments: { agentId: target.id },
      });
      expect(res.isError).not.toBe(true);
      expect(claudeSession.prompts).toEqual(["/compact"]);
      expect(res.structuredContent).toEqual({
        success: true,
        agentId: target.id,
        provider: "claude",
        contextTokensBefore: 215_000,
        contextTokensAfter: 18_400,
        contextWindowMaxTokens: 200_000,
        status: "idle",
      });

      // Mid-turn refusal
      const stream = harness.manager.streamAgent(target.id, "HOLD_TURN");
      const draining = (async () => {
        for await (const _ of stream) {
          // drain
        }
      })();
      await vi.waitFor(() => {
        expect(harness.manager.getAgent(target.id)?.lifecycle).toBe("running");
      });
      const busyRes = await harness.mcpClient.callTool({
        name: "compact_agent",
        arguments: { agentId: target.id },
      });
      expect(busyRes.isError).toBe(true);
      expect(JSON.stringify(busyRes.content)).toContain("mid-turn");
      claudeSession.finishHeldTurn();
      await draining;

      // Non-Claude provider refusal
      const unsupAgent = await harness.manager.createAgent(
        { provider: "codex", cwd: harness.root },
        randomUUID(),
        { workspaceId: "ws-1" },
      );
      const unsupRes = await harness.mcpClient.callTool({
        name: "compact_agent",
        arguments: { agentId: unsupAgent.id },
      });
      expect(unsupRes.isError).toBe(true);
      expect(JSON.stringify(unsupRes.content)).toContain("unsupported for codex");
    } finally {
      await harness.close();
    }
  });

  test("refuses compact_agent via MCP when target has queued agent messages or pending finish subscriptions", async () => {
    const claudeSession = new CompactTestSession("claude", {
      supportsCompaction: true,
    }).configureSupport();
    const pendingMessageIds = new Set<string>();
    const pendingFinishCallerIds = new Set<string>();
    const harness = await createMcpHarness(
      { claude: makeClient("claude", () => claudeSession) },
      { pendingMessageIds, pendingFinishCallerIds },
    );

    try {
      const target = await harness.manager.createAgent(
        { provider: "claude", cwd: harness.root },
        randomUUID(),
        { workspaceId: "ws-1" },
      );

      pendingMessageIds.add(target.id);
      const queuedRes = await harness.mcpClient.callTool({
        name: "compact_agent",
        arguments: { agentId: target.id },
      });
      expect(queuedRes.isError).toBe(true);
      expect(JSON.stringify(queuedRes.content)).toContain("queued messages");
      pendingMessageIds.clear();

      pendingFinishCallerIds.add(target.id);
      const finishRes = await harness.mcpClient.callTool({
        name: "compact_agent",
        arguments: { agentId: target.id },
      });
      expect(finishRes.isError).toBe(true);
      expect(JSON.stringify(finishRes.content)).toContain("pending child notifications");
      pendingFinishCallerIds.clear();

      expect(claudeSession.prompts).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
