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
import {
  AgentTurnBusyError,
  sendPreparedPromptToAgent,
  waitForAgentRunStartWithTimeout,
} from "./agent-prompt.js";
import { createAgentMessageDelivery } from "./agent-messages/delivery.js";
import {
  createFinishSubscriptions,
  type FinishSubscription,
} from "./finish-subscriptions/index.js";
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
import { wrapSessionProvider } from "./provider-registry.js";
import { CodexAppServerAgentSession } from "./providers/codex-app-server-agent.js";
import { CodexAppServerRpcError } from "./providers/codex/app-server-transport.js";
import { createCodexAppServerChildProcess } from "./providers/codex/test-utils/fake-app-server.js";
import { OpenCodeV2AgentClient } from "./providers/opencode/v2/agent.js";
import { V2Harness } from "./providers/opencode/test-utils/v2-harness.js";
import { OpenCodeHttpError } from "./providers/opencode/http-error.js";

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
      supportsCompactionInstructions?: boolean;
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
  supportsCompactionInstructions?: boolean;
  canStopRuntime?: () => Promise<boolean>;

  configureSupport(): this {
    if (this.options.supportsCompaction !== undefined) {
      const value = this.options.supportsCompaction;
      this.supportsCompaction = () => value;
    }
    this.supportsCompactionInstructions =
      this.options.supportsCompactionInstructions ?? this.provider === "claude";
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

describe("AgentManager.compactAgent", () => {
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
    await expect(manager.compactAgent(a1.id)).rejects.toThrow("no compaction confirmation");

    const a2 = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    await expect(manager.compactAgent(a2.id)).rejects.toThrow("no compaction confirmation");

    const a3 = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    const confirmed = await manager.compactAgent(a3.id);
    expect(confirmed.contextTokensBefore).toBeNull();
    expect(confirmed.contextTokensAfter).toBeNull();
    expect(confirmed.status).toBe("idle");
  });

  test.each(["antigravity-acp", "antigravity-acp-2", "copilot", "pi", "omp"])(
    "returns unsupported for provider %s when session does not implement supportsCompaction",
    async (provider) => {
      const root = await createTempDir(`paseo-compact-unsup-${provider}-`);
      const logger = createTestLogger();
      const session = new CompactTestSession(provider).configureSupport();
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

  test("forwards supportsCompaction and supportsCompactionInstructions through wrapSessionProvider and rejects unsupported instructions", async () => {
    const root = await createTempDir("paseo-compact-wrap-");
    const logger = createTestLogger();
    const claudeInner = new CompactTestSession("claude", {
      supportsCompaction: true,
      supportsCompactionInstructions: true,
    }).configureSupport();
    const codexInner = new CompactTestSession("codex", {
      supportsCompaction: true,
      supportsCompactionInstructions: false,
    }).configureSupport();
    const manager = new AgentManager({
      clients: {
        "claude-api": makeClient("claude-api", () =>
          wrapSessionProvider("claude-api", claudeInner),
        ),
        codex: makeClient("codex", () => wrapSessionProvider("codex", codexInner)),
      },
      logger,
    });

    const claudeAgent = await manager.createAgent(
      { provider: "claude-api", cwd: root },
      randomUUID(),
      {
        workspaceId: "ws-1",
      },
    );
    const claudeResult = await manager.compactAgent(claudeAgent.id, {
      instructions: "keep API contract",
    });
    expect(claudeResult.provider).toBe("claude-api");
    expect(claudeInner.prompts).toEqual(["/compact keep API contract"]);

    const codexAgent = await manager.createAgent({ provider: "codex", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    await expect(
      manager.compactAgent(codexAgent.id, { instructions: "preserve details" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError &&
        error.message === "Compaction instructions are not supported for codex",
    );
    expect(codexInner.prompts).toEqual([]);
  });

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

    // 1. Protected agent (queued messages for manual; queued messages or finish subscriptions for auto) is refused.
    let protectedIds = new Set<string>([parent.id]);
    manager.setCompactionProtectionCheck((id) => protectedIds.has(id));
    await expect(manager.compactAgent(parent.id)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentCompactionRefusedError && error.message.includes("queued messages"),
    );
    await expect(manager.compactAgent(parent.id, { trigger: "auto" })).rejects.toSatisfy(
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

  test("auto compaction refuses whenever the root has any live descendant (even idle) or one spawns before dispatch, and allows compaction once closed or archived", async () => {
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

      // 1. Live idle Claude descendant refuses auto compaction.
      const idleClaudeChild = await manager.createAgent(
        { provider: "claude", cwd: root },
        randomUUID(),
        { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
      );
      await expect(manager.compactAgent(parent.id, { trigger: "auto" })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError &&
          error.reason === "not_eligible" &&
          error.message.includes("live descendant agent"),
      );
      expect(parentSession.prompts).toEqual([]);
      expect(manager.hasInFlightRun(parent.id)).toBe(false);

      // 2. Closing the descendant unblocks auto compaction.
      await manager.closeAgent(idleClaudeChild.id);
      const afterClose = await manager.compactAgent(parent.id, { trigger: "auto" });
      expect(afterClose.contextTokensAfter).toBe(18_400);
      expect(parentSession.prompts).toEqual(["/compact"]);

      // 3. Live idle ACP descendant refuses auto compaction; archiving unblocks it.
      const idleAcpChild = await manager.createAgent(
        { provider: "claude-acp", cwd: root },
        randomUUID(),
        { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
      );
      await expect(manager.compactAgent(parent.id, { trigger: "auto" })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError &&
          error.reason === "not_eligible" &&
          error.message.includes("live descendant agent"),
      );
      expect(parentSession.prompts).toHaveLength(1);
      await manager.archiveAgent(idleAcpChild.id);

      // 4. Descendant spawned while root awaits startTurn (simulating ensureQuery) is caught
      //    synchronously by admitBeforeDispatch, refusing auto compaction and rolling back the run slot.
      let lateChildId: string | null = null;
      onRootStartTurn = async () => {
        const lateChild = await manager.createAgent(
          { provider: "claude-acp", cwd: root },
          randomUUID(),
          { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: parent.id } },
        );
        lateChildId = lateChild.id;
      };
      await expect(manager.compactAgent(parent.id, { trigger: "auto" })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError && error.reason === "not_eligible",
      );
      onRootStartTurn = undefined;
      expect(lateChildId).not.toBeNull();
      expect(parentSession.prompts).toHaveLength(1);
      expect(manager.hasInFlightRun(parent.id)).toBe(false);

      // Closing the late child allows auto compaction again.
      await manager.closeAgent(lateChildId!);
      const finalCompact = await manager.compactAgent(parent.id, { trigger: "auto" });
      expect(finalCompact.contextTokensAfter).toBe(18_400);
      expect(parentSession.prompts).toHaveLength(2);
    } finally {
      await manager.flush();
      await storage.flush();
    }
  });

  test("auto compaction refuses when a direct child is closed but a grandchild is still live (including after reopening independently), and recovers once the grandchild closes", async () => {
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

    // Close direct child B while grandchild C remains live -> A must STILL be refused for auto.
    await manager1.closeAgent(childB.id);
    await manager1.closeAgent(otherRootX.id);
    await expect(manager1.compactAgent(rootA.id, { trigger: "auto" })).rejects.toSatisfy(
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

      // Even though B was never live in manager2, durable ancestry resolves C -> B -> A and refuses auto!
      await expect(manager2.compactAgent(rootA.id, { trigger: "auto" })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError &&
          error.reason === "not_eligible" &&
          error.message.includes(`live descendant agent ${grandchildC.id}`),
      );
      expect(manager2.hasInFlightRun(rootA.id)).toBe(false);

      // Closing grandchild C restores auto eligibility for root A (while unrelated Y -> closed X stays open!).
      await manager2.closeAgent(grandchildC.id);
      const recovered = await manager2.compactAgent(rootA.id, { trigger: "auto" });
      expect(recovered.contextTokensAfter).toBe(18_400);

      // Conservative fallback: a live agent whose parent cannot be resolved refuses auto compaction.
      const orphan = await manager2.createAgent(
        { provider: "claude", cwd: rootDir },
        randomUUID(),
        { workspaceId: "ws-1", labels: { [PARENT_AGENT_ID_LABEL]: "missing-parent-id" } },
      );
      await expect(manager2.compactAgent(rootA.id, { trigger: "auto" })).rejects.toSatisfy(
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

  test("compacts an idle Claude agent without wrapping /compact and refuses busy or unsupported targets", async () => {
    const claudeSession = new CompactTestSession("claude", {
      supportsCompaction: true,
    }).configureSupport();
    const acpSession = new CompactTestSession("antigravity-acp", {
      supportsCompaction: false,
    }).configureSupport();
    const harness = await createMcpHarness({
      claude: makeClient("claude", () => claudeSession),
      "antigravity-acp": makeClient("antigravity-acp", () => acpSession),
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

      // Unsupported provider refusal (ACP / antigravity-acp)
      const unsupAgent = await harness.manager.createAgent(
        { provider: "antigravity-acp", cwd: harness.root },
        randomUUID(),
        { workspaceId: "ws-1" },
      );
      const unsupRes = await harness.mcpClient.callTool({
        name: "compact_agent",
        arguments: { agentId: unsupAgent.id },
      });
      expect(unsupRes.isError).toBe(true);
      expect(JSON.stringify(unsupRes.content)).toContain("unsupported for antigravity-acp");
    } finally {
      await harness.close();
    }
  });

  test("refuses compact_agent via MCP on queued agent messages but allows pending finish subscriptions", async () => {
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
      expect(claudeSession.prompts).toEqual([]);

      // Pending finish subscriptions from live children no longer block manual compact_agent.
      pendingFinishCallerIds.add(target.id);
      const finishRes = await harness.mcpClient.callTool({
        name: "compact_agent",
        arguments: { agentId: target.id },
      });
      expect(finishRes.isError).not.toBe(true);
      expect(claudeSession.prompts).toEqual(["/compact"]);
      pendingFinishCallerIds.clear();
    } finally {
      await harness.close();
    }
  });
});

interface FakeCodexClientController {
  requests: Array<{ method: string; params: unknown }>;
  killed: boolean;
  emitNotification(method: string, params: unknown): void;
  setBackgroundTerminals(terminals: unknown[]): void;
  setThreadStatus(status: unknown): void;
  setGoal(goal: unknown): void;
  onCompactStart: ((params: unknown) => Promise<unknown>) | null;
  onBackgroundTerminalsList:
    | ((params: unknown) => Promise<{ data: unknown[]; nextCursor: string | null }>)
    | null;
  onTurnStart: ((params: unknown) => Promise<unknown>) | null;
  onTurnInterrupt: ((params: unknown) => Promise<unknown>) | null;
}

async function createCodexCompactHarness(options?: {
  compactionTimeoutMs?: number;
  compactionRpcTimeoutMs?: number;
  failChildKill?: boolean;
}) {
  const root = await createTempDir("paseo-compact-codex-");
  const logger = createTestLogger();
  let backgroundTerminals: unknown[] = [];
  let threadStatus: unknown = { type: "idle" };
  let goal: unknown = null;

  const fakeChild = createCodexAppServerChildProcess();
  const originalKill = fakeChild.kill.bind(fakeChild);
  const sendLine = (payload: unknown) => {
    fakeChild.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const controller: FakeCodexClientController = {
    requests: [],
    killed: false,
    emitNotification(method, params) {
      sendLine({ method, params });
    },
    setBackgroundTerminals(terminals) {
      backgroundTerminals = terminals;
    },
    setThreadStatus(status) {
      threadStatus = status;
    },
    setGoal(nextGoal) {
      goal = nextGoal;
    },
    onCompactStart: null,
    onBackgroundTerminalsList: null,
    onTurnStart: null,
    onTurnInterrupt: null,
  };

  fakeChild.kill = ((signal?: NodeJS.Signals | number) => {
    controller.killed = true;
    if (options?.failChildKill) {
      return false;
    }
    return originalKill(signal);
  }) as typeof fakeChild.kill;

  const methodHandlers: Record<string, (params: unknown) => unknown | Promise<unknown>> = {
    initialize: () => ({ userAgent: "codex-cli/0.169.0" }),
    "model/list": () => ({
      data: [{ id: "gpt-6.2-sol", isDefault: true, defaultReasoningEffort: "low" }],
    }),
    "config/read": () => ({ config: {} }),
    getUserSavedConfig: () => ({ config: {} }),
    "collaborationMode/list": () => ({ data: [] }),
    "skills/list": () => ({ data: [] }),
    "thread/resume": () => ({ thread: { id: "thread-root", status: threadStatus, turns: [] } }),
    "thread/read": () => ({ thread: { id: "thread-root", status: threadStatus, turns: [] } }),
    "thread/goal/get": () => ({ goal }),
    "thread/loaded/list": () => ({ data: ["thread-root"] }),
    "thread/backgroundTerminals/list": (params) =>
      controller.onBackgroundTerminalsList
        ? controller.onBackgroundTerminalsList(params)
        : { data: backgroundTerminals, nextCursor: null },
    "thread/compact/start": (params) =>
      controller.onCompactStart ? controller.onCompactStart(params) : {},
    "turn/start": (params) => (controller.onTurnStart ? controller.onTurnStart(params) : {}),
    "turn/interrupt": (params) =>
      controller.onTurnInterrupt ? controller.onTurnInterrupt(params) : {},
  };

  let buffer = "";
  fakeChild.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
        if (typeof msg.id === "number" && typeof msg.method === "string") {
          const { id, method, params } = msg;
          controller.requests.push({ method, params });
          void (async () => {
            await Promise.resolve();
            try {
              const handler = methodHandlers[method];
              const result = handler ? await handler(params) : {};
              sendLine({ id, result });
            } catch (error) {
              if (error instanceof CodexAppServerRpcError) {
                sendLine({
                  id,
                  error: { code: error.code ?? -32602, message: error.message, data: error.data },
                });
              } else {
                sendLine({
                  id,
                  error: {
                    code: -32000,
                    message: error instanceof Error ? error.message : String(error),
                  },
                });
              }
            }
          })();
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: root },
    { sessionId: "thread-root", metadata: { cwd: root } },
    logger,
    async () => fakeChild,
    {
      compactionTimeoutMs: options?.compactionTimeoutMs,
      compactionRpcTimeoutMs: options?.compactionRpcTimeoutMs,
    },
  );
  await session.connect();

  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: makeClient("codex", () => session) },
    registry: storage,
    logger,
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: root }, randomUUID(), {
    workspaceId: "ws-1",
  });

  return {
    root,
    logger,
    storage,
    manager,
    agent,
    session,
    controller,
    cleanup: async () => {
      await session.close();
      await manager.flush();
      await storage.flush();
    },
  };
}

describe("CodexAppServerAgentSession compaction", () => {
  test("compacts with strict (threadId, turnId) correlation and reports post-compaction usage", async () => {
    const { manager, agent, session, controller, cleanup } = await createCodexCompactHarness();
    try {
      expect(session.supportsCompaction()).toBe(true);
      expect(session.supportsCompactionInstructions).toBe(false);

      // Seed initial usage before compaction.
      controller.emitNotification("thread/tokenUsage/updated", {
        threadId: "thread-root",
        turnId: "turn-0",
        tokenUsage: { last: { totalTokens: 180_000 }, modelContextWindow: 828_400 },
      });
      await vi.waitFor(() => {
        expect(manager.getAgent(agent.id)?.lastUsage?.contextWindowUsedTokens).toBe(180_000);
      });
      await manager.flush();

      controller.onCompactStart = async () => {
        queueMicrotask(() => {
          controller.emitNotification("turn/started", {
            threadId: "thread-root",
            turn: { id: "compact-turn-1" },
          });
          controller.emitNotification("item/started", {
            threadId: "thread-root",
            turnId: "compact-turn-1",
            item: { id: "comp-item-1", type: "contextCompaction" },
          });
          // Unrelated turn/thread noise must be ignored and must not corrupt usage or confirmation.
          controller.emitNotification("thread/tokenUsage/updated", {
            threadId: "thread-root",
            turnId: "unrelated-turn",
            tokenUsage: { last: { totalTokens: 999_999 }, modelContextWindow: 828_400 },
          });
          controller.emitNotification("thread/tokenUsage/updated", {
            threadId: "thread-root",
            turnId: "compact-turn-1",
            tokenUsage: { last: { totalTokens: 22_400 }, modelContextWindow: 828_400 },
          });
          controller.emitNotification("item/completed", {
            threadId: "thread-root",
            turnId: "compact-turn-1",
            item: { id: "comp-item-1", type: "contextCompaction" },
          });
          controller.emitNotification("turn/completed", {
            threadId: "thread-root",
            turn: { id: "compact-turn-1", status: "completed", error: null },
          });
        });
        return {};
      };

      const result = await manager.compactAgent(agent.id);
      expect(result).toEqual({
        agentId: agent.id,
        provider: "codex",
        contextTokensBefore: 180_000,
        contextTokensAfter: 22_400,
        contextWindowMaxTokens: 828_400,
        status: "idle",
      });
      expect(await session.canStopRuntime()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("ignores wrong-turn or missing-turnId compaction events and fails when turn completes without positive confirmation", async () => {
    const { manager, agent, session, controller, cleanup } = await createCodexCompactHarness();
    try {
      controller.onCompactStart = async () => {
        queueMicrotask(() => {
          controller.emitNotification("turn/started", {
            threadId: "thread-root",
            turn: { id: "compact-turn-2" },
          });
          // Wrong turnId and missing turnId must never confirm compaction.
          controller.emitNotification("item/completed", {
            threadId: "thread-root",
            turnId: "other-turn",
            item: { id: "comp-other", type: "contextCompaction" },
          });
          controller.emitNotification("thread/compacted", {
            threadId: "thread-root",
          });
          // Wrong turnId on turn/completed must also be ignored.
          controller.emitNotification("turn/completed", {
            threadId: "thread-root",
            turn: { id: "other-turn", status: "completed", error: null },
          });
          // Actual compaction turn completes without positive confirmation.
          controller.emitNotification("turn/completed", {
            threadId: "thread-root",
            turn: { id: "compact-turn-2", status: "completed", error: null },
          });
        });
        return {};
      };

      await expect(manager.compactAgent(agent.id)).rejects.toThrow(
        "without positive compaction confirmation",
      );
      expect(await session.canStopRuntime()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("fails cleanly on turn/completed(failed) without falsely confirming open loading compaction items", async () => {
    const { manager, agent, session, controller, cleanup } = await createCodexCompactHarness();
    try {
      controller.onCompactStart = async () => {
        queueMicrotask(() => {
          controller.emitNotification("turn/started", {
            threadId: "thread-root",
            turn: { id: "compact-turn-fail" },
          });
          controller.emitNotification("item/started", {
            threadId: "thread-root",
            turnId: "compact-turn-fail",
            item: { id: "comp-fail-1", type: "contextCompaction" },
          });
          controller.emitNotification("turn/completed", {
            threadId: "thread-root",
            turn: {
              id: "compact-turn-fail",
              status: "failed",
              error: { message: "context compaction rejected by server" },
            },
          });
        });
        return {};
      };

      await expect(manager.compactAgent(agent.id)).rejects.toThrow(
        "context compaction rejected by server",
      );
      expect(await session.canStopRuntime()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("handles deterministic RPC error cleanly, keeps bound timeout active until late completion with message requeue, and tears down on uncorrelated timeout", async () => {
    // 1. Deterministic JSON-RPC error -> fails without tearing down or quarantining.
    const h1 = await createCodexCompactHarness({ compactionTimeoutMs: 40 });
    try {
      h1.controller.onCompactStart = async () => {
        throw new CodexAppServerRpcError("Nothing to compact", -32602, undefined);
      };
      await expect(h1.manager.compactAgent(h1.agent.id)).rejects.toThrow("Nothing to compact");
      expect(h1.controller.killed).toBe(false);
      expect(h1.session.isCompactionQuarantined()).toBe(false);
      expect(await h1.session.canStopRuntime()).toBe(true);
    } finally {
      await h1.cleanup();
    }

    // 2. Bound compaction (turn/started arrived) exceeds timeout -> does NOT release turn;
    //    queued agent message receives AgentTurnBusyError and requeues; late correlated completion
    //    succeeds and then the requeued message delivers cleanly.
    const h2 = await createCodexCompactHarness({ compactionTimeoutMs: 30 });
    const timers: Array<{ fn: () => void; canceled: boolean }> = [];
    const deliveryErrors: unknown[] = [];
    const busyErrors: AgentTurnBusyError[] = [];
    let forceDispatchRace = true;
    const delivery = createAgentMessageDelivery({
      schedule: (_delayMs, callback) => {
        const entry = { fn: callback, canceled: false };
        timers.push(entry);
        return () => {
          entry.canceled = true;
        };
      },
      isRunning: (id) => (forceDispatchRace ? false : h2.manager.hasInFlightRun(id)),
      subscribe: (onStateChange) =>
        h2.manager.subscribe((event) => {
          if (event.type === "agent_state") onStateChange(event.agent.id);
        }),
      dispatch: async (request) => {
        try {
          return (
            await sendPreparedPromptToAgent({
              agentManager: h2.manager,
              agentStorage: h2.storage,
              agentId: request.recipientId,
              prompt: request.prompt,
              logger: h2.logger,
              idleOnly: request.idleOnly,
              admit: request.admit,
              onDispatch: request.onDispatch,
              activeTurnBehavior: request.activeTurnBehavior,
            })
          ).disposition;
        } catch (error) {
          if (error instanceof AgentTurnBusyError) busyErrors.push(error);
          throw error;
        }
      },
      onError: (error) => deliveryErrors.push(error),
    });
    try {
      const bound = deferred<void>();
      h2.controller.onCompactStart = async () => {
        queueMicrotask(() => {
          h2.controller.emitNotification("turn/started", {
            threadId: "thread-root",
            turn: { id: "compact-slow-1" },
          });
          h2.controller.emitNotification("item/started", {
            threadId: "thread-root",
            turnId: "compact-slow-1",
            item: { id: "comp-slow-item", type: "contextCompaction" },
          });
          bound.resolve();
        });
        return {};
      };
      h2.controller.onTurnStart = async () => {
        queueMicrotask(() => {
          h2.controller.emitNotification("turn/started", {
            threadId: "thread-root",
            turn: { id: "followup-turn-1" },
          });
          h2.controller.emitNotification("turn/completed", {
            threadId: "thread-root",
            turn: { id: "followup-turn-1", status: "completed", error: null },
          });
        });
        return {};
      };

      const compactPromise = h2.manager.compactAgent(h2.agent.id);
      await bound.promise;
      // Wait past compactionTimeoutMs (30ms): compaction must stay active, NOT release!
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(h2.manager.hasInFlightRun(h2.agent.id)).toBe(true);
      expect(h2.controller.killed).toBe(false);
      // Out-of-band /compact must be declined while compaction is active (B3c).
      expect(h2.session.tryHandleOutOfBand("/compact")).toBeNull();
      // Normal turn & queued agent message must hit AgentTurnBusyError and requeue without touching Codex.
      const queuedMsg = delivery.enqueue({
        recipientId: h2.agent.id,
        prompt: "Child report during slow Codex compaction",
        activeTurnBehavior: "steer",
      });
      for (const t of timers.splice(0)) if (!t.canceled) t.fn();
      await vi.waitFor(() => expect(busyErrors).toHaveLength(1));
      expect(deliveryErrors).toEqual([]);
      expect(h2.controller.requests.filter((r) => r.method === "turn/start")).toHaveLength(0);

      // Late correlated completion arrives after timeout -> compaction succeeds and queued message delivers!
      forceDispatchRace = false;
      h2.controller.emitNotification("thread/tokenUsage/updated", {
        threadId: "thread-root",
        turnId: "compact-slow-1",
        tokenUsage: { last: { totalTokens: 19_500 }, modelContextWindow: 828_400 },
      });
      h2.controller.emitNotification("item/completed", {
        threadId: "thread-root",
        turnId: "compact-slow-1",
        item: { id: "comp-slow-item", type: "contextCompaction" },
      });
      h2.controller.emitNotification("turn/completed", {
        threadId: "thread-root",
        turn: { id: "compact-slow-1", status: "completed", error: null },
      });

      const compactResult = await compactPromise;
      expect(compactResult.contextTokensAfter).toBe(19_500);
      for (const t of timers.splice(0)) if (!t.canceled) t.fn();
      await expect(queuedMsg.dispatched).resolves.toBe("turn_started");
      expect(deliveryErrors).toEqual([]);
      await vi.waitFor(() => {
        let turnStarts = 0;
        for (const req of h2.controller.requests) {
          if (req.method === "turn/start") turnStarts += 1;
        }
        expect(turnStarts).toBe(1);
      });
    } finally {
      await delivery.close();
      await h2.cleanup();
    }

    // 3. Uncorrelated timeout (turn/started never arrives) or RPC timeout -> tears down app-server process.
    const h3 = await createCodexCompactHarness({ compactionTimeoutMs: 40 });
    try {
      h3.controller.onCompactStart = async () => ({});
      await expect(h3.manager.compactAgent(h3.agent.id)).rejects.toThrow("timed out");
      expect(h3.controller.killed).toBe(true);
    } finally {
      await h3.cleanup();
    }

    const h4 = await createCodexCompactHarness({
      compactionTimeoutMs: 5_000,
      compactionRpcTimeoutMs: 40,
    });
    try {
      h4.controller.onCompactStart = () => new Promise(() => {});
      await expect(h4.manager.compactAgent(h4.agent.id)).rejects.toThrow("timed out");
      expect(h4.controller.killed).toBe(true);
    } finally {
      await h4.cleanup();
    }
  });

  test("refuses compaction on non-idle thread, active goal, background terminals, or flip before dispatch; binds only on turn/started and supports interrupt before turn/started", async () => {
    const { manager, agent, session, controller, cleanup } = await createCodexCompactHarness();
    try {
      // Non-idle thread/read status refuses compaction (B3a).
      controller.setThreadStatus({ type: "active", activeFlags: [] });
      await expect(manager.compactAgent(agent.id)).rejects.toBeInstanceOf(
        AgentCompactionRefusedError,
      );
      controller.setThreadStatus({ type: "idle" });

      // Active goal refuses compaction (B3a); paused goal is allowed.
      controller.setGoal({ objective: "Ship it", status: "active" });
      await expect(manager.compactAgent(agent.id)).rejects.toBeInstanceOf(
        AgentCompactionRefusedError,
      );
      controller.setGoal({ objective: "Ship it", status: "paused" });

      // Background terminals refuse compaction.
      controller.setBackgroundTerminals([{ processId: "proc-1", command: "sleep 60" }]);
      await expect(manager.compactAgent(agent.id)).rejects.toBeInstanceOf(
        AgentCompactionRefusedError,
      );
      expect(controller.requests.filter((r) => r.method === "thread/compact/start")).toHaveLength(
        0,
      );

      // Flip admitBeforeDispatch right before dispatch refuses cleanly.
      controller.setBackgroundTerminals([]);
      let admit = true;
      let calls = 0;
      controller.onBackgroundTerminalsList = async () => {
        calls += 1;
        if (calls === 2) admit = false;
        return { data: [], nextCursor: null };
      };
      await expect(manager.compactAgent(agent.id, { admit: () => admit })).rejects.toBeInstanceOf(
        AgentCompactionRefusedError,
      );
      controller.onBackgroundTerminalsList = null;
      expect(controller.requests.filter((r) => r.method === "thread/compact/start")).toHaveLength(
        0,
      );

      // Events before turn/started cannot bind nativeTurnId (B3b), and interrupt() called
      // before turn/started waits for turn/started and then sends turn/interrupt (S3).
      const compactSent = deferred<void>();
      controller.onCompactStart = async () => {
        compactSent.resolve();
        return {};
      };
      const interruptSent = deferred<unknown>();
      controller.onTurnInterrupt = async (params) => {
        interruptSent.resolve(params);
        queueMicrotask(() => {
          controller.emitNotification("turn/completed", {
            threadId: "thread-root",
            turn: { id: "compact-turn-bound", status: "interrupted", error: null },
          });
        });
        return {};
      };

      const compactPromise = manager.compactAgent(agent.id);
      await compactSent.promise;

      // Item and turn/completed before turn/started must NOT bind or settle compaction.
      controller.emitNotification("item/completed", {
        threadId: "thread-root",
        turnId: "stray-goal-turn",
        item: { id: "comp-stray", type: "contextCompaction" },
      });
      controller.emitNotification("turn/completed", {
        threadId: "thread-root",
        turn: { id: "stray-goal-turn", status: "completed", error: null },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(manager.hasInFlightRun(agent.id)).toBe(true);

      // Call interrupt() BEFORE turn/started arrives; it must wait for turn/started instead of throwing.
      const interruptPromise = session.interrupt();
      controller.emitNotification("turn/started", {
        threadId: "thread-root",
        turn: { id: "compact-turn-bound" },
      });
      await expect(interruptSent.promise).resolves.toEqual({
        threadId: "thread-root",
        turnId: "compact-turn-bound",
      });
      await interruptPromise;
      await expect(compactPromise).rejects.toThrow("interrupted");
    } finally {
      await cleanup();
    }
  });

  test("preserves provider-level AgentTurnBusyError through ForegroundPromptStart when manager force-cancels a still-active Codex compaction", async () => {
    const { manager, storage, logger, agent, controller, cleanup } =
      await createCodexCompactHarness();
    const deliveryErrors: unknown[] = [];
    const busyErrors: AgentTurnBusyError[] = [];
    const timers: Array<{ fn: () => void; canceled: boolean }> = [];
    const delivery = createAgentMessageDelivery({
      schedule: (_delayMs, callback) => {
        const entry = { fn: callback, canceled: false };
        timers.push(entry);
        return () => {
          entry.canceled = true;
        };
      },
      isRunning: (id) => manager.hasInFlightRun(id),
      subscribe: (onStateChange) =>
        manager.subscribe((event) => {
          if (event.type === "agent_state") onStateChange(event.agent.id);
        }),
      dispatch: async (request) => {
        try {
          const result = await sendPreparedPromptToAgent({
            agentManager: manager,
            agentStorage: storage,
            agentId: request.recipientId,
            prompt: request.prompt,
            logger,
            idleOnly: request.idleOnly,
            admit: request.admit,
            onDispatch: request.onDispatch,
            activeTurnBehavior: request.activeTurnBehavior,
          });
          if (result.disposition === "turn_started") {
            await waitForAgentRunStartWithTimeout(manager, request.recipientId, result.started);
          }
          return result.disposition;
        } catch (error) {
          if (error instanceof AgentTurnBusyError) busyErrors.push(error);
          throw error;
        }
      },
      onError: (error) => deliveryErrors.push(error),
    });

    try {
      const compactBound = deferred<void>();
      controller.onCompactStart = async () => {
        queueMicrotask(() => {
          controller.emitNotification("turn/started", {
            threadId: "thread-root",
            turn: { id: "compact-desync-1" },
          });
          compactBound.resolve();
        });
        return {};
      };
      // Acknowledge turn/interrupt without emitting turn/completed yet, so cancelAgentRun
      // hits its settlement timeout and force-cancels the manager run while Codex compaction stays live.
      controller.onTurnInterrupt = async () => ({});

      const compactPromise = manager.compactAgent(agent.id);
      const compactRejection = compactPromise.catch((error: unknown) => error);
      await compactBound.promise;

      await manager.cancelAgentRun(agent.id);
      expect(await compactRejection).toBeInstanceOf(Error);
      expect(manager.hasInFlightRun(agent.id)).toBe(false);
      expect(manager.getAgent(agent.id)?.lifecycle).toBe("idle");

      // Manager thinks the agent is idle, while Codex still holds activeCompaction.
      // Enqueue an agent message; session.startTurn throws AgentTurnBusyError inside the stream
      // forwarder and ForegroundPromptStart must reject with AgentTurnBusyError so delivery requeues.
      const queuedMsg = delivery.enqueue({
        recipientId: agent.id,
        prompt: "Child report during desynced compaction",
        activeTurnBehavior: "steer",
      });
      for (const t of timers.splice(0)) if (!t.canceled) t.fn();
      await vi.waitFor(() => expect(busyErrors).toHaveLength(1));
      expect(deliveryErrors).toEqual([]);
      expect(delivery.hasPending(agent.id)).toBe(true);
      let turnStartsBefore = 0;
      for (const req of controller.requests) {
        if (req.method === "turn/start") turnStartsBefore += 1;
      }
      expect(turnStartsBefore).toBe(0);

      // Now the late correlated turn/completed settles Codex's compaction turn.
      controller.emitNotification("turn/completed", {
        threadId: "thread-root",
        turn: { id: "compact-desync-1", status: "interrupted", error: null },
      });

      // Fire the requeued delivery timer -> message now dispatches cleanly to Codex!
      for (const t of timers.splice(0)) if (!t.canceled) t.fn();
      await expect(queuedMsg.dispatched).resolves.toBe("turn_started");
      expect(deliveryErrors).toEqual([]);
      await vi.waitFor(() => {
        let turnStartsAfter = 0;
        for (const req of controller.requests) {
          if (req.method === "turn/start") turnStartsAfter += 1;
        }
        expect(turnStartsAfter).toBe(1);
      });
    } finally {
      await delivery.close();
      await cleanup();
    }
  });
});

describe("OpenCodeV2Session compaction", () => {
  async function createOpenCodeCompactHarness(options?: {
    compactionTimeoutMs?: number;
    initialSequence?: number;
  }) {
    const root = await createTempDir("paseo-compact-opencode-");
    const logger = createTestLogger();
    const harness = new V2Harness(options?.initialSequence ?? 0);
    const client = new OpenCodeV2AgentClient({
      logger,
      runtime: harness.runtime,
      compactionTimeoutMs: options?.compactionTimeoutMs,
    });
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const manager = new AgentManager({
      clients: { opencode: client },
      registry: storage,
      logger,
    });
    const agent = await manager.createAgent({ provider: "opencode", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    return {
      root,
      logger,
      storage,
      manager,
      agent,
      harness,
      client,
      cleanup: async () => {
        await manager.closeAgent(agent.id).catch(() => undefined);
        await manager.flush();
        await storage.flush();
      },
    };
  }

  test("compacts with strict ID correlation and does not settle prematurely on historical or unrelated execution terminals", async () => {
    const { manager, agent, harness, cleanup } = await createOpenCodeCompactHarness();
    try {
      // Simulate historical execution already present in durable log before compaction.
      harness.finishExecution("succeeded", false);

      let compactCalls = 0;
      const enqueuedReady = deferred<void>();
      harness.api.session.compact = async () => {
        compactCalls += 1;
        enqueuedReady.resolve();
        return {
          id: "comp-msg-1",
          sessionID: harness.info.id,
          time: { created: Date.now() },
          type: "compaction",
          payload: {},
          delivery: "steer",
        };
      };

      const compactPromise = manager.compactAgent(agent.id);
      await enqueuedReady.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Unrelated execution terminals and uncorrelated compaction.failed events while record is
      // still missing (queued in inbox) or "running" must NOT settle compaction (B2).
      harness.finishExecution("failed", true);
      harness.finishExecution("interrupted", true);
      harness.push({
        id: "ev-wrong-comp-fail",
        created: Date.now(),
        type: "session.compaction.failed",
        data: {
          sessionID: harness.info.id,
          inputID: "wrong-compaction-id",
          error: { name: "Error", message: "other compaction failed" },
        },
      } as never);
      harness.push({
        id: "ev-missing-id-comp-fail",
        created: Date.now(),
        type: "session.compaction.failed",
        data: {
          sessionID: harness.info.id,
          error: { name: "Error", message: "unattributed compaction failed" },
        },
      } as never);
      harness.history.push({
        type: "compaction",
        id: "comp-msg-1",
        time: { created: Date.now() },
        status: "running",
        reason: "manual",
        summary: "",
      });
      harness.finishExecution("succeeded", true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(manager.hasInFlightRun(agent.id)).toBe(true);

      // Now the correlated record reaches status === "completed" -> settles cleanly!
      harness.history[0] = {
        type: "compaction",
        id: "comp-msg-1",
        time: { created: Date.now() },
        status: "completed",
        reason: "manual",
        summary: "Compacted summary",
        recent: "",
      };
      harness.finishExecution("succeeded", true);

      const result = await compactPromise;
      expect(compactCalls).toBe(1);
      expect(result).toEqual({
        agentId: agent.id,
        provider: "opencode",
        contextTokensBefore: null,
        contextTokensAfter: null,
        contextWindowMaxTokens: null,
        status: "idle",
      });
    } finally {
      await cleanup();
    }
  });

  test("fails closed when correlated compaction record fails", async () => {
    const h1 = await createOpenCodeCompactHarness();
    try {
      h1.harness.api.session.compact = async () => {
        const id = "comp-msg-fail";
        setTimeout(() => {
          h1.harness.history.push({
            type: "compaction",
            id,
            time: { created: Date.now() },
            status: "failed",
            reason: "manual",
            error: { name: "CompactionError", message: "Upstream model rejected summary" },
          });
          h1.harness.finishExecution("succeeded", true);
        }, 10);
        return {
          id,
          sessionID: h1.harness.info.id,
          time: { created: Date.now() },
          type: "compaction",
          payload: {},
          delivery: "steer",
        };
      };

      await expect(h1.manager.compactAgent(h1.agent.id)).rejects.toThrow(
        "Upstream model rejected summary",
      );
    } finally {
      await h1.cleanup();
    }
  });

  test("refuses compaction when OpenCode remote runtime has pending permissions, forms, active sessions, or running compaction", async () => {
    const { manager, agent, harness, cleanup } = await createOpenCodeCompactHarness();
    let compactCalls = 0;
    harness.api.session.compact = async () => {
      compactCalls += 1;
      throw new Error("should not dispatch");
    };
    try {
      // Pending remote permission blocks canStopRuntime / compaction
      harness.api.permission.list = async () => [
        { id: "perm-1", sessionID: harness.info.id, action: "shell", resources: ["ls"] },
      ];
      await expect(manager.compactAgent(agent.id)).rejects.toBeInstanceOf(
        AgentCompactionRefusedError,
      );
      harness.api.permission.list = async () => [];

      // Pending remote form blocks compaction
      harness.api.session.form.list = async () => [
        {
          id: "form-1",
          sessionID: harness.info.id,
          title: "Confirm",
          fields: [{ key: "ok", type: "boolean" }],
        },
      ];
      await expect(manager.compactAgent(agent.id)).rejects.toBeInstanceOf(
        AgentCompactionRefusedError,
      );
      harness.api.session.form.list = async () => [];

      // Running compaction in remote message history blocks dispatch inside startTurn
      harness.history.push({
        type: "compaction",
        id: "comp-in-flight",
        time: { created: Date.now() },
        status: "running",
        reason: "auto",
        summary: "",
      });
      await expect(manager.compactAgent(agent.id)).rejects.toBeInstanceOf(
        AgentCompactionRefusedError,
      );
      expect(compactCalls).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("handles HTTP 4xx cleanly, keeps acknowledged timeout active until late completion, and quarantines uncorrelated ambiguity with AgentTurnBusyError requeue", async () => {
    // 1. Deterministic HTTP 409 rejection -> fails without quarantining.
    const h1 = await createOpenCodeCompactHarness({ compactionTimeoutMs: 40 });
    try {
      h1.harness.api.session.compact = async () => {
        throw new OpenCodeHttpError("/api/session/session/compact", 409, false);
      };
      await expect(h1.manager.compactAgent(h1.agent.id)).rejects.toThrow("409");
      expect(h1.manager.getAgent(h1.agent.id)!.session.isCompactionQuarantined?.()).toBe(false);
      expect(await h1.manager.getAgent(h1.agent.id)!.session.canStopRuntime?.()).toBe(true);
    } finally {
      await h1.cleanup();
    }

    // 2. Acknowledged compaction (inputId returned) exceeds timeout -> stays active;
    //    agent message gets AgentTurnBusyError and requeues; late completion succeeds and message delivers.
    const h2 = await createOpenCodeCompactHarness({ compactionTimeoutMs: 30 });
    const timers2: Array<{ fn: () => void; canceled: boolean }> = [];
    const busyErrors2: AgentTurnBusyError[] = [];
    const deliveryErrors2: unknown[] = [];
    let forceRace2 = true;
    const delivery2 = createAgentMessageDelivery({
      schedule: (_delayMs, callback) => {
        const entry = { fn: callback, canceled: false };
        timers2.push(entry);
        return () => {
          entry.canceled = true;
        };
      },
      isRunning: (id) => (forceRace2 ? false : h2.manager.hasInFlightRun(id)),
      subscribe: (onStateChange) =>
        h2.manager.subscribe((event) => {
          if (event.type === "agent_state") onStateChange(event.agent.id);
        }),
      dispatch: async (request) => {
        try {
          return (
            await sendPreparedPromptToAgent({
              agentManager: h2.manager,
              agentStorage: h2.storage,
              agentId: request.recipientId,
              prompt: request.prompt,
              logger: h2.logger,
              idleOnly: request.idleOnly,
              admit: request.admit,
              onDispatch: request.onDispatch,
              activeTurnBehavior: request.activeTurnBehavior,
            })
          ).disposition;
        } catch (error) {
          if (error instanceof AgentTurnBusyError) busyErrors2.push(error);
          throw error;
        }
      },
      onError: (error) => deliveryErrors2.push(error),
    });
    try {
      const acked = deferred<void>();
      let promptCalls = 0;
      const origPrompt = h2.harness.api.session.prompt;
      h2.harness.api.session.prompt = async (params) => {
        promptCalls += 1;
        const res = await origPrompt(params);
        setTimeout(() => h2.harness.finishExecution("succeeded", true), 5);
        return res;
      };
      h2.harness.api.session.compact = async () => {
        acked.resolve();
        return {
          id: "comp-slow-oc",
          sessionID: h2.harness.info.id,
          time: { created: Date.now() },
          type: "compaction",
          payload: {},
          delivery: "steer",
        };
      };

      const compactPromise = h2.manager.compactAgent(h2.agent.id);
      await acked.promise;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(h2.manager.hasInFlightRun(h2.agent.id)).toBe(true);

      const queued2 = delivery2.enqueue({
        recipientId: h2.agent.id,
        prompt: "Child report during slow OpenCode compaction",
        activeTurnBehavior: "steer",
      });
      for (const t of timers2.splice(0)) if (!t.canceled) t.fn();
      await vi.waitFor(() => expect(busyErrors2).toHaveLength(1));
      expect(deliveryErrors2).toEqual([]);
      expect(promptCalls).toBe(0);

      // Late correlated completion settles compaction -> requeued message delivers!
      forceRace2 = false;
      h2.harness.history.push({
        type: "compaction",
        id: "comp-slow-oc",
        time: { created: Date.now() },
        status: "completed",
        reason: "manual",
        summary: "Late summary",
        recent: "",
      });
      h2.harness.finishExecution("succeeded", true);
      await expect(compactPromise).resolves.toMatchObject({ provider: "opencode", status: "idle" });

      for (const t of timers2.splice(0)) if (!t.canceled) t.fn();
      await expect(queued2.dispatched).resolves.toBe("turn_started");
      expect(deliveryErrors2).toEqual([]);
      expect(promptCalls).toBe(1);
    } finally {
      await delivery2.close();
      await h2.cleanup();
    }

    // 3. Uncorrelated ambiguity (POST /compact times out before returning id) -> quarantines session;
    //    normal turns never reach OpenCode and agent messages hit AgentTurnBusyError and requeue!
    const h3 = await createOpenCodeCompactHarness({ compactionTimeoutMs: 40 });
    const timers3: Array<{ fn: () => void; canceled: boolean }> = [];
    const busyErrors3: AgentTurnBusyError[] = [];
    const deliveryErrors3: unknown[] = [];
    const delivery3 = createAgentMessageDelivery({
      schedule: (_delayMs, callback) => {
        const entry = { fn: callback, canceled: false };
        timers3.push(entry);
        return () => {
          entry.canceled = true;
        };
      },
      isRunning: (id) => h3.manager.hasInFlightRun(id),
      subscribe: (onStateChange) =>
        h3.manager.subscribe((event) => {
          if (event.type === "agent_state") onStateChange(event.agent.id);
        }),
      dispatch: async (request) => {
        try {
          return (
            await sendPreparedPromptToAgent({
              agentManager: h3.manager,
              agentStorage: h3.storage,
              agentId: request.recipientId,
              prompt: request.prompt,
              logger: h3.logger,
              idleOnly: request.idleOnly,
              admit: request.admit,
              onDispatch: request.onDispatch,
              activeTurnBehavior: request.activeTurnBehavior,
            })
          ).disposition;
        } catch (error) {
          if (error instanceof AgentTurnBusyError) busyErrors3.push(error);
          throw error;
        }
      },
      onError: (error) => deliveryErrors3.push(error),
    });
    try {
      let promptCalls3 = 0;
      h3.harness.api.session.prompt = async () => {
        promptCalls3 += 1;
        throw new Error("should never reach OpenCode while quarantined");
      };
      h3.harness.api.session.compact = () => new Promise(() => {});

      await expect(h3.manager.compactAgent(h3.agent.id)).rejects.toThrow("timed out");
      expect(h3.manager.getAgent(h3.agent.id)!.session.isCompactionQuarantined?.()).toBe(true);
      expect(await h3.manager.getAgent(h3.agent.id)!.session.canStopRuntime?.()).toBe(false);
      expect(() => h3.manager.streamAgent(h3.agent.id, "human prompt")).toThrow(AgentTurnBusyError);

      delivery3.enqueue({
        recipientId: h3.agent.id,
        prompt: "Report during quarantine",
        activeTurnBehavior: "steer",
      });
      for (const t of timers3.splice(0)) if (!t.canceled) t.fn();
      await vi.waitFor(() => expect(busyErrors3).toHaveLength(1));
      expect(deliveryErrors3).toEqual([]);
      expect(delivery3.hasPending(h3.agent.id)).toBe(true);
      expect(promptCalls3).toBe(0);
    } finally {
      await delivery3.close();
      await h3.cleanup();
    }
  });

  test("releases a queued OpenCode compaction cleanly on interrupt via correlated session.inbox.cancelled (live SSE and durable log) without wedging or quarantining", async () => {
    // 1. Live SSE session.inbox.cancelled when interrupt() cancels a queued compaction.
    const h1 = await createOpenCodeCompactHarness();
    try {
      const compactQueued = deferred<void>();
      h1.harness.api.session.compact = async () => {
        queueMicrotask(() => compactQueued.resolve());
        return {
          id: "comp-queued-sse",
          sessionID: h1.harness.info.id,
          time: { created: Date.now() },
          type: "compaction",
          payload: {},
          delivery: "steer",
        };
      };
      h1.harness.interrupt = async () => {
        h1.harness.push({
          id: "ev-inbox-cancelled-1",
          created: Date.now(),
          type: "session.inbox.cancelled",
          durable: { aggregateID: h1.harness.info.id, seq: 10, version: 1 },
          data: { sessionID: h1.harness.info.id, inboxID: "comp-queued-sse" },
        } as never);
        return { interrupted: true };
      };

      const compactPromise = h1.manager.compactAgent(h1.agent.id);
      const compactRejection = compactPromise.catch((error: unknown) => error);
      await compactQueued.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Unrelated inbox cancellation must NOT release the queued compaction.
      h1.harness.push({
        id: "ev-inbox-cancelled-other",
        created: Date.now(),
        type: "session.inbox.cancelled",
        durable: { aggregateID: h1.harness.info.id, seq: 9, version: 1 },
        data: { sessionID: h1.harness.info.id, inboxID: "other-inbox-id" },
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(h1.manager.hasInFlightRun(h1.agent.id)).toBe(true);

      // Interrupt cancels the queued inbox item -> settles cleanly without wedging or quarantining.
      const session = h1.manager.getAgent(h1.agent.id)!.session;
      await session.interrupt();
      const err1 = await compactRejection;
      expect(err1).toBeInstanceOf(Error);
      expect((err1 as Error).message).toContain("canceled");
      expect(session.isCompactionQuarantined?.()).toBe(false);
      expect(h1.manager.hasInFlightRun(h1.agent.id)).toBe(false);

      // Subsequent normal turn must succeed cleanly (session not wedged or quarantined).
      let followUpPrompts = 0;
      h1.harness.prompt = async () => {
        followUpPrompts += 1;
      };
      for await (const _ of h1.manager.streamAgent(h1.agent.id, "Follow-up after cancel")) {
        // drain
      }
      expect(followUpPrompts).toBe(1);
    } finally {
      await h1.cleanup();
    }

    // 2. Durable log-only session.inbox.cancelled (SSE event missed) recovered during reconcile.
    const h2 = await createOpenCodeCompactHarness();
    try {
      const compactQueued = deferred<void>();
      const durableLogEvents: unknown[] = [];
      const baseLog = h2.harness.api.session.log;
      h2.harness.api.session.log = async function* (input, options) {
        for await (const event of baseLog(input, options)) {
          yield event;
        }
        const after = input.after ?? 0;
        for (const event of durableLogEvents) {
          const seq = (event as { durable?: { seq?: number } }).durable?.seq ?? 0;
          if (seq > after) yield event as never;
        }
      };
      h2.harness.api.session.compact = async () => {
        queueMicrotask(() => compactQueued.resolve());
        return {
          id: "comp-queued-log",
          sessionID: h2.harness.info.id,
          time: { created: Date.now() },
          type: "compaction",
          payload: {},
          delivery: "steer",
        };
      };
      h2.harness.interrupt = async () => {
        // Record only in durable log (no SSE push) to verify reconcile recovers it.
        durableLogEvents.push({
          id: "ev-inbox-cancelled-log",
          created: Date.now(),
          type: "session.inbox.cancelled",
          durable: { aggregateID: h2.harness.info.id, seq: 20, version: 1 },
          data: { sessionID: h2.harness.info.id, inboxID: "comp-queued-log" },
        });
        return { interrupted: true };
      };

      const compactPromise = h2.manager.compactAgent(h2.agent.id);
      const compactRejection = compactPromise.catch((error: unknown) => error);
      await compactQueued.promise;
      await new Promise((resolve) => setTimeout(resolve, 10));

      const session = h2.manager.getAgent(h2.agent.id)!.session;
      await session.interrupt();
      const err2 = await compactRejection;
      expect(err2).toBeInstanceOf(Error);
      expect((err2 as Error).message).toContain("canceled");
      expect(session.isCompactionQuarantined?.()).toBe(false);
      expect(h2.manager.hasInFlightRun(h2.agent.id)).toBe(false);
    } finally {
      await h2.cleanup();
    }
  });
});

describe("Manual compaction with live child sessions", () => {
  test("allows manual compact_agent with live children and grandchildren without interrupting them, while auto stays conservative", async () => {
    const root = await createTempDir("paseo-compact-live-children-");
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

    // Mirror bootstrap.ts: auto checks finishSubscriptions + agentMessages, manual checks agentMessages only.
    const pendingFinishCallers = new Set<string>();
    const pendingMessages = new Set<string>();
    manager.setCompactionProtectionCheck((agentId, trigger) =>
      trigger === "auto"
        ? pendingFinishCallers.has(agentId) || pendingMessages.has(agentId)
        : pendingMessages.has(agentId),
    );

    try {
      const lead = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
        workspaceId: "ws-1",
      });
      const child = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
        workspaceId: "ws-1",
        labels: { [PARENT_AGENT_ID_LABEL]: lead.id },
      });
      const grandchild = await manager.createAgent(
        { provider: "claude", cwd: root },
        randomUUID(),
        {
          workspaceId: "ws-1",
          labels: { [PARENT_AGENT_ID_LABEL]: child.id },
        },
      );
      const leadSession = sessions[0]!;
      const childSession = sessions[1]!;
      pendingFinishCallers.add(lead.id);

      // Keep the child actively running a turn while the lead compacts manually.
      const childStream = manager.streamAgent(child.id, "HOLD_TURN");
      const childDraining = (async () => {
        for await (const _ of childStream) {
          // drain
        }
      })();
      await vi.waitFor(() => {
        expect(manager.getAgent(child.id)?.lifecycle).toBe("running");
      });

      // Idle auto-compaction stays conservative and refuses while descendants are live.
      await expect(manager.compactAgent(lead.id, { trigger: "auto" })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError &&
          error.reason === "not_eligible" &&
          error.message.includes("live descendant agent"),
      );
      expect(leadSession.prompts).toEqual([]);

      // Manual compaction succeeds on the idle lead without disturbing child or grandchild.
      const result = await manager.compactAgent(lead.id, { trigger: "manual" });
      expect(result.contextTokensAfter).toBe(18_400);
      expect(result.status).toBe("idle");
      expect(leadSession.prompts).toEqual(["/compact"]);
      expect(manager.getAgent(child.id)?.lifecycle).toBe("running");
      expect(manager.getAgent(grandchild.id)?.lifecycle).toBe("idle");

      // Every other manual safeguard remains enforced even when children are live:
      // 1) Already-queued messages on the lead refuse manual compaction.
      pendingMessages.add(lead.id);
      await expect(manager.compactAgent(lead.id, { trigger: "manual" })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError &&
          error.reason === "not_eligible" &&
          error.message.includes("queued messages"),
      );
      pendingMessages.clear();

      // 2) Pending permissions on the lead refuse manual compaction.
      leadSession.addPendingPermission({
        id: "perm-lead-1",
        provider: "claude",
        name: "Bash",
        kind: "tool",
      });
      await vi.waitFor(() => {
        expect(manager.getPendingPermissions(lead.id)).toHaveLength(1);
      });
      await expect(manager.compactAgent(lead.id, { trigger: "manual" })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError && error.reason === "pending_permissions",
      );
      await manager.respondToPermission(lead.id, "perm-lead-1", { behavior: "allow" });
      await vi.waitFor(() => {
        expect(manager.getPendingPermissions(lead.id)).toHaveLength(0);
      });

      // 3) Root mid-turn refuses manual compaction.
      const leadStream = manager.streamAgent(lead.id, "HOLD_TURN");
      const leadDraining = (async () => {
        for await (const _ of leadStream) {
          // drain
        }
      })();
      await vi.waitFor(() => {
        expect(manager.getAgent(lead.id)?.lifecycle).toBe("running");
      });
      await expect(manager.compactAgent(lead.id, { trigger: "manual" })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError && error.reason === "mid_turn",
      );
      leadSession.finishHeldTurn();
      await leadDraining;

      childSession.finishHeldTurn();
      await childDraining;
    } finally {
      await manager.flush();
      await storage.flush();
    }
  });

  test("requeues a live child's report arriving mid-compaction via typed AgentTurnBusyError and delivers it after compaction", async () => {
    const root = await createTempDir("paseo-compact-child-report-");
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const compactHold = deferred<void>();
    const compactStarted = deferred<void>();
    const sessions: CompactTestSession[] = [];
    const manager = new AgentManager({
      clients: {
        claude: makeClient("claude", () => {
          const isLead = sessions.length === 0;
          const s = new CompactTestSession("claude", {
            supportsCompaction: true,
            onPrompt: isLead
              ? async (prompt, emit, turnId) => {
                  if (prompt === "/compact") {
                    emit({
                      type: "timeline",
                      provider: "claude",
                      turnId,
                      item: { type: "compaction", status: "loading" },
                    });
                    compactStarted.resolve();
                    await compactHold.promise;
                    emit({
                      type: "timeline",
                      provider: "claude",
                      turnId,
                      item: {
                        type: "compaction",
                        status: "completed",
                        trigger: "manual",
                        preTokens: 215_000,
                      },
                    });
                    emit({
                      type: "usage_updated",
                      provider: "claude",
                      turnId,
                      usage: { contextWindowUsedTokens: 18_400, contextWindowMaxTokens: 200_000 },
                    });
                    emit({
                      type: "turn_completed",
                      provider: "claude",
                      turnId,
                      usage: { contextWindowUsedTokens: 18_400, contextWindowMaxTokens: 200_000 },
                    });
                    return;
                  }
                  emit({ type: "turn_completed", provider: "claude", turnId });
                }
              : undefined,
          }).configureSupport();
          sessions.push(s);
          return s;
        }),
      },
      registry: storage,
      logger,
    });

    const lead = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    const child = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
      labels: { [PARENT_AGENT_ID_LABEL]: lead.id },
    });
    const leadSession = sessions[0]!;
    const childSession = sessions[1]!;

    const deliveryErrors: unknown[] = [];
    const busyErrorsObserved: AgentTurnBusyError[] = [];
    const timers: Array<{ fn: () => void; canceled: boolean }> = [];
    let forceDispatchRace = true;
    const delivery = createAgentMessageDelivery({
      schedule: (_delayMs, callback) => {
        const entry = { fn: callback, canceled: false };
        timers.push(entry);
        return () => {
          entry.canceled = true;
        };
      },
      isRunning: (id) => (forceDispatchRace ? false : manager.hasInFlightRun(id)),
      subscribe: (onStateChange) =>
        manager.subscribe((event) => {
          if (event.type === "agent_state") {
            onStateChange(event.agent.id);
          }
        }),
      dispatch: async (request) => {
        try {
          return (
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
          ).disposition;
        } catch (error) {
          if (error instanceof AgentTurnBusyError) {
            busyErrorsObserved.push(error);
          }
          throw error;
        }
      },
      onError: (error) => {
        deliveryErrors.push(error);
      },
    });

    try {
      // Child is actively running a turn.
      const childStream = manager.streamAgent(child.id, "HOLD_TURN");
      const childDraining = (async () => {
        for await (const _ of childStream) {
          // drain
        }
      })();
      await vi.waitFor(() => {
        expect(manager.getAgent(child.id)?.lifecycle).toBe("running");
      });

      // Start manual compaction on the lead while the child is live and running.
      const compactPromise = manager.compactAgent(lead.id, { trigger: "manual" });
      await compactStarted.promise;

      // A concurrent second compact_agent on the lead must be refused as mid_turn.
      await expect(manager.compactAgent(lead.id, { trigger: "manual" })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AgentCompactionRefusedError && error.reason === "mid_turn",
      );

      // Mid-compaction, the live child sends a report back to the lead.
      const childReportPrompt = `Report from live child ${child.id}: worker completed phase 1`;
      const reportDelivery = delivery.enqueue({
        recipientId: lead.id,
        prompt: childReportPrompt,
        activeTurnBehavior: "steer",
      });

      // Fire quiet-window timer while compaction holds the foreground run slot.
      for (const t of timers.splice(0)) {
        if (!t.canceled) t.fn();
      }
      await vi.waitFor(() => {
        expect(busyErrorsObserved).toHaveLength(1);
      });
      // Typed AgentTurnBusyError was caught and requeued (not reported as a fatal delivery error or dropped).
      expect(deliveryErrors).toEqual([]);
      expect(delivery.hasPending(lead.id)).toBe(true);
      expect(leadSession.prompts).toEqual(["/compact"]);

      // Complete compaction; the requeued child report must deliver immediately afterward.
      forceDispatchRace = false;
      compactHold.resolve();
      const compactResult = await compactPromise;
      expect(compactResult.contextTokensAfter).toBe(18_400);

      for (const t of timers.splice(0)) {
        if (!t.canceled) t.fn();
      }
      await vi.waitFor(() => {
        expect(leadSession.prompts).toEqual(["/compact", childReportPrompt]);
      });
      await expect(reportDelivery.dispatched).resolves.toBe("turn_started");
      expect(deliveryErrors).toEqual([]);
      expect(manager.getAgent(child.id)?.lifecycle).toBe("running");

      childSession.finishHeldTurn();
      await childDraining;
    } finally {
      await delivery.close();
      await manager.flush();
      await storage.flush();
    }
  });

  test("delivers a real createFinishSubscriptions child-finish notification after manual compaction via AgentTurnBusyError requeue", async () => {
    const root = await createTempDir("paseo-compact-finish-sub-");
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const compactStarted = deferred<void>();
    const compactHold = deferred<void>();
    const sessions: CompactTestSession[] = [];
    const manager = new AgentManager({
      clients: {
        claude: makeClient("claude", () => {
          const isLead = sessions.length === 0;
          const s = new CompactTestSession("claude", {
            supportsCompaction: true,
            onPrompt: isLead
              ? async (prompt, emit, turnId) => {
                  if (prompt === "/compact") {
                    emit({
                      type: "timeline",
                      provider: "claude",
                      turnId,
                      item: { type: "compaction", status: "loading" },
                    });
                    compactStarted.resolve();
                    await compactHold.promise;
                    emit({
                      type: "timeline",
                      provider: "claude",
                      turnId,
                      item: {
                        type: "compaction",
                        status: "completed",
                        trigger: "manual",
                        preTokens: 215_000,
                      },
                    });
                    emit({
                      type: "usage_updated",
                      provider: "claude",
                      turnId,
                      usage: { contextWindowUsedTokens: 18_400, contextWindowMaxTokens: 200_000 },
                    });
                    emit({
                      type: "turn_completed",
                      provider: "claude",
                      turnId,
                      usage: { contextWindowUsedTokens: 18_400, contextWindowMaxTokens: 200_000 },
                    });
                    return;
                  }
                  emit({ type: "turn_completed", provider: "claude", turnId });
                }
              : undefined,
          }).configureSupport();
          sessions.push(s);
          return s;
        }),
      },
      registry: storage,
      logger,
    });

    const lead = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
    });
    const child = await manager.createAgent({ provider: "claude", cwd: root }, randomUUID(), {
      workspaceId: "ws-1",
      labels: { [PARENT_AGENT_ID_LABEL]: lead.id },
    });
    const leadSession = sessions[0]!;

    const deliveryErrors: unknown[] = [];
    const busyErrorsObserved: AgentTurnBusyError[] = [];
    const timers: Array<{ fn: () => void; canceled: boolean }> = [];
    let forceDispatchRace = true;
    const delivery = createAgentMessageDelivery({
      schedule: (_delayMs, callback) => {
        const entry = { fn: callback, canceled: false };
        timers.push(entry);
        return () => {
          entry.canceled = true;
        };
      },
      isRunning: (id) => (forceDispatchRace ? false : manager.hasInFlightRun(id)),
      subscribe: (onStateChange) =>
        manager.subscribe((event) => {
          if (event.type === "agent_state") onStateChange(event.agent.id);
        }),
      dispatch: async (request) => {
        try {
          return (
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
          ).disposition;
        } catch (error) {
          if (error instanceof AgentTurnBusyError) busyErrorsObserved.push(error);
          throw error;
        }
      },
      onError: (error) => deliveryErrors.push(error),
    });

    const records = new Map<string, FinishSubscription>();
    const childFinished = deferred<{
      status: "idle";
      final: null;
      lastMessage: string;
      error: null;
    }>();
    const finishSubscriptions = createFinishSubscriptions({
      store: {
        list: async () => Array.from(records.values()),
        put: async (record) => {
          records.set(record.id, record);
        },
        remove: async (id) => {
          records.delete(id);
        },
      },
      messages: () => delivery,
      callerIsActive: async (agentId) => manager.getAgent(agentId) !== null,
      serverId: "srv-test",
      logger,
      open: async () => ({
        next: () => childFinished.promise,
        close: async () => {},
      }),
    });

    manager.setCompactionProtectionCheck((agentId, trigger) =>
      trigger === "auto"
        ? finishSubscriptions.hasPendingForCaller(agentId) || delivery.hasPending(agentId)
        : delivery.hasPending(agentId),
    );

    try {
      await finishSubscriptions.start();
      const registration = await finishSubscriptions.register({
        callerAgentId: lead.id,
        childAgentId: child.id,
      });
      registration.accept();
      expect(finishSubscriptions.hasPendingForCaller(lead.id)).toBe(true);

      // Start manual compaction on lead despite live child + real pending finish subscription.
      const compactPromise = manager.compactAgent(lead.id, { trigger: "manual" });
      await compactStarted.promise;

      // Child finishes mid-compaction -> real finishSubscriptions enqueues finish notification.
      childFinished.resolve({
        status: "idle",
        final: null,
        lastMessage: "Worker finished phase 1",
        error: null,
      });
      await vi.waitFor(() => {
        expect(delivery.hasPending(lead.id)).toBe(true);
      });

      // Fire delivery timer while compaction holds the foreground run slot -> hits AgentTurnBusyError & requeues.
      for (const t of timers.splice(0)) if (!t.canceled) t.fn();
      await vi.waitFor(() => {
        expect(busyErrorsObserved).toHaveLength(1);
      });
      expect(deliveryErrors).toEqual([]);
      expect(leadSession.prompts).toEqual(["/compact"]);

      // Release compaction -> requeued real finish notification delivers to lead!
      forceDispatchRace = false;
      compactHold.resolve();
      const compactResult = await compactPromise;
      expect(compactResult.contextTokensAfter).toBe(18_400);

      for (const t of timers.splice(0)) if (!t.canceled) t.fn();
      await vi.waitFor(() => {
        expect(leadSession.prompts).toHaveLength(2);
      });
      expect(leadSession.prompts[0]).toBe("/compact");
      expect(String(leadSession.prompts[1])).toContain("Worker finished phase 1");
      expect(String(leadSession.prompts[1])).toContain(child.id);
      await vi.waitFor(() => {
        expect(finishSubscriptions.hasPendingForCaller(lead.id)).toBe(false);
      });
      expect(deliveryErrors).toEqual([]);
    } finally {
      await finishSubscriptions.close();
      await delivery.close();
      await manager.flush();
      await storage.flush();
    }
  });
});
