import { structuredOutput } from "./structured-output.js";
import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client";

import { randomUUID } from "node:crypto";

import {
  AgentCompactionAdmitError,
  AgentTurnBusyError,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentStreamEvent,
  type SteerActiveTurnOptions,
  type SteerResult,
} from "../../../agent-sdk-types.js";
import { OpenCodeHttpError } from "../http-error.js";

import { toDiagnosticErrorMessage } from "../../diagnostic-utils.js";

import { renderPromptAttachmentAsText } from "../../../prompt-attachments.js";

import { usageFromV2 } from "./mapping.js";

import { commands } from "./commands.js";

import type { V2Api } from "./api.js";
type ExecutionEvent = Extract<
  OpenCodeEvent,
  {
    type:
      | "session.execution.started"
      | "session.execution.succeeded"
      | "session.execution.failed"
      | "session.execution.interrupted";
  }
>;
function isExecutionEvent(event: { type: string }): event is ExecutionEvent {
  return (
    event.type === "session.execution.started" ||
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  );
}

interface TurnSnapshot {
  info: SessionInfo;
  history: SessionMessageInfo[];
}
const OPENCODE_COMPACTION_TIMEOUT_MS = 180_000;

interface TurnOptions {
  client(): V2Api;
  id: string;
  cwd: string;
  signal: AbortSignal;
  emit(event: AgentStreamEvent): void;
  reconcile(): Promise<TurnSnapshot>;
  clearPermissions(): Promise<void>;
  reportReconciliationError(error: unknown): void;
  compactionTimeoutMs?: number;
}
interface CompactionTurnState {
  inputId: string | null;
  baselineSeq: number;
  failedError: string | null;
  cancelled: boolean;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}
interface Turn {
  output?: ReturnType<typeof structuredOutput>;
  compaction?: CompactionTurnState;
  id: string;
  submitted: Promise<void>;
  completion: Promise<void>;
  settle(): void;
  accepted: boolean;
  requestDenied: boolean;
}

export class SessionTurns {
  private turn: Turn | null = null;
  private stopping: Promise<void> | null = null;
  private stopFailed = false;
  private compactionQuarantined = false;
  private revision = 0;
  private execution: ExecutionEvent | null = null;
  private sequence = 0;
  private refresh: Promise<void> | null = null;
  private dirty = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly options: TurnOptions) {}
  get id() {
    return this.turn?.id;
  }
  get isBusy() {
    return Boolean(this.turn || this.stopping || this.compactionQuarantined);
  }
  get isCompactionQuarantined() {
    return this.compactionQuarantined;
  }
  get lastSequence() {
    return this.sequence;
  }
  clearQuarantine() {
    this.compactionQuarantined = false;
  }
  get hasStructuredOutput() {
    return Boolean(this.turn?.output);
  }
  fail(error: Error) {
    const turn = this.turn;
    if (!turn) return;
    this.release(turn);
    this.options.emit({
      type: "turn_failed",
      provider: "opencode",
      turnId: turn.id,
      error: toDiagnosticErrorMessage(error),
    });
  }
  private release(turn: Turn) {
    if (turn.compaction?.timer) {
      clearTimeout(turn.compaction.timer);
      turn.compaction.timer = null;
    }
    this.turn = null;
    this.revision += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    turn.settle();
  }
  close() {
    this.compactionQuarantined = false;
    if (this.turn) this.release(this.turn);
  }
  private createTurn(
    submitted: Promise<void>,
    accepted: boolean,
    output?: Turn["output"],
    compaction?: CompactionTurnState,
  ): Turn {
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const turn: Turn = {
      id: randomUUID(),
      submitted,
      completion,
      settle,
      accepted,
      output,
      compaction,
      requestDenied: false,
    };
    this.turn = turn;
    this.execution = null;
    this.revision += 1;
    this.options.emit({ type: "turn_started", provider: "opencode", turnId: turn.id });
    this.scheduleRecovery();
    return turn;
  }
  startCompactionTurn(admitBeforeDispatch: () => boolean, baselineSeq: number): { turnId: string } {
    if (
      this.options.signal.aborted ||
      this.turn ||
      this.stopping ||
      this.compactionQuarantined ||
      admitBeforeDispatch() !== true
    ) {
      throw new AgentCompactionAdmitError("OpenCode session is no longer idle for compaction");
    }
    // Zero awaits between the final admission check above and dispatching session.compact.
    let accept!: () => void;
    const submitted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const compaction: CompactionTurnState = {
      inputId: null,
      baselineSeq: Math.max(this.sequence, baselineSeq),
      failedError: null,
      cancelled: false,
      timedOut: false,
      timer: null,
    };
    const turn = this.createTurn(submitted, false, undefined, compaction);
    const timeoutMs = this.options.compactionTimeoutMs ?? OPENCODE_COMPACTION_TIMEOUT_MS;
    compaction.timer = setTimeout(() => {
      if (this.turn !== turn) return;
      compaction.timer = null;
      compaction.timedOut = true;
      if (compaction.inputId !== null) {
        // The provider acknowledged the compaction request with an inputId. Keep the
        // foreground turn active until the correlated compaction record reaches a
        // terminal status so normal turns and agent messages see AgentTurnBusyError
        // and requeue cleanly rather than racing an in-flight compaction.
        this.requestReconciliation();
        return;
      }
      if (!this.options.signal.aborted) {
        this.compactionQuarantined = true;
      }
      this.fail(new Error("OpenCode compaction timed out before provider acknowledged request"));
    }, timeoutMs);
    compaction.timer.unref();
    let compactPromise: ReturnType<V2Api["session"]["compact"]>;
    try {
      compactPromise = this.options.client().session.compact({ sessionID: this.options.id });
    } catch (error) {
      if (this.turn === turn) {
        if (!this.isDeterministicReject(error) && !this.options.signal.aborted) {
          this.compactionQuarantined = true;
        }
        this.release(turn);
      }
      accept();
      throw error;
    }
    void this.submitCompaction(turn, compaction, compactPromise, accept);
    return { turnId: turn.id };
  }
  private isDeterministicReject(error: unknown): boolean {
    return (
      error instanceof OpenCodeHttpError &&
      typeof error.status === "number" &&
      error.status >= 400 &&
      error.status < 500
    );
  }
  private async submitCompaction(
    turn: Turn,
    compaction: CompactionTurnState,
    compactPromise: ReturnType<V2Api["session"]["compact"]>,
    accept: () => void,
  ) {
    try {
      const enqueued = await compactPromise;
      if (this.turn !== turn) return;
      if (typeof enqueued?.id !== "string" || enqueued.id.length === 0) {
        if (!this.options.signal.aborted) {
          this.compactionQuarantined = true;
        }
        this.fail(new Error("OpenCode compaction did not return a correlation id"));
        return;
      }
      compaction.inputId = enqueued.id;
      turn.accepted = true;
      this.revision += 1;
      this.requestReconciliation();
    } catch (error) {
      if (this.turn === turn) {
        if (!this.isDeterministicReject(error) && !this.options.signal.aborted) {
          this.compactionQuarantined = true;
        }
        this.fail(new Error(toDiagnosticErrorMessage(error)));
      }
    } finally {
      accept();
    }
  }
  async startTurn(prompt: AgentPromptInput, options?: AgentRunOptions) {
    await this.stopping;
    if (this.options.signal.aborted) throw new Error("OpenCode session is closed");
    if (this.compactionQuarantined) {
      throw new AgentTurnBusyError(
        "OpenCode session is quarantined after an ambiguous compaction outcome",
      );
    }
    if (this.turn) throw new AgentTurnBusyError("OpenCode session already has an active turn");
    const input = this.promptInput(prompt);
    let accept!: () => void;
    const submitted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const output =
      options?.outputSchema === undefined ? undefined : structuredOutput(options.outputSchema);
    const turn = this.createTurn(submitted, false, output);
    void this.submit(turn, input, accept, options);
    return { turnId: turn.id };
  }
  private async submit(
    turn: Turn,
    input: ReturnType<SessionTurns["promptInput"]>,
    accept: () => void,
    options?: AgentRunOptions,
  ) {
    try {
      await this.dispatch(input, options, turn.output);
      if (this.turn !== turn) return;
      turn.accepted = true;
      this.revision += 1;
      // Covers a fast execution whose terminal event preceded the admission response.
      this.requestReconciliation();
    } catch (error) {
      if (this.turn === turn) this.fail(new Error(toDiagnosticErrorMessage(error)));
    } finally {
      accept();
    }
  }
  observe(event: OpenCodeEvent) {
    if (this.turn?.compaction && this.observeCompactionEvent(this.turn.compaction, event)) {
      return;
    }
    if (!isExecutionEvent(event) || event.durable.seq <= this.sequence) return;
    this.revision += 1;
    if (event.type === "session.execution.started") this.observeActiveTurn();
    this.execution = event;
    this.sequence = event.durable.seq;
    this.requestReconciliation();
  }
  private observeCompactionEvent(compaction: CompactionTurnState, event: OpenCodeEvent): boolean {
    if (event.type === "session.compaction.failed") {
      if (compaction.inputId && event.data.inputID === compaction.inputId) {
        compaction.failedError = event.data.error.message;
        this.revision += 1;
        this.requestReconciliation();
      }
      return true;
    }
    if (event.type === "session.inbox.cancelled") {
      if (compaction.inputId && event.data.inboxID === compaction.inputId) {
        compaction.cancelled = true;
        this.revision += 1;
        this.requestReconciliation();
      }
      return true;
    }
    if (event.type === "session.compaction.ended") {
      this.revision += 1;
      this.requestReconciliation();
      return true;
    }
    return false;
  }
  // OpenCode ends the execution when the user denies its permission or dismisses its question,
  // but reports the interruption as "shutdown", the same reason as an execution it will resume.
  requestDenied() {
    if (!this.turn) return;
    this.turn.requestDenied = true;
    this.requestReconciliation();
  }
  private requestReconciliation() {
    void this.reconcile().catch((error: unknown) => this.options.reportReconciliationError(error));
  }
  // Recovery reads state; a quiet stream (including SSE comment heartbeats) is not a reason to reconnect.
  private scheduleRecovery() {
    if (this.retryTimer || !this.turn || this.options.signal.aborted) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.requestReconciliation();
    }, 5_000);
    this.retryTimer.unref();
  }
  reconcile(): Promise<void> {
    this.dirty = true;
    if (this.refresh) return this.refresh;
    this.refresh = Promise.resolve()
      .then(() => this.drainReconciliation())
      .finally(() => {
        this.refresh = null;
        this.scheduleRecovery();
      });
    return this.refresh;
  }
  private async drainReconciliation() {
    while (this.dirty && !this.options.signal.aborted) {
      this.dirty = false;
      await this.reconcileTurn();
    }
  }
  private async reconcileTurn() {
    const revision = this.revision;
    const turn = this.turn;
    const active = await this.options.client().session.active({ signal: this.options.signal });
    if (revision !== this.revision) {
      this.dirty = true;
      return;
    }
    if (active[this.options.id]) {
      this.observeActiveTurn();
      return;
    }
    if (!turn?.accepted) return;
    if (turn.compaction) {
      await this.reconcileCompactionTurn(turn, turn.compaction, revision);
      return;
    }
    // Idle outcome survives shutdown, and /event has no replay. Recover the latest
    // durable execution even when its start or terminal was lost across reconnect.
    const execution = await this.readExecution();
    if (revision !== this.revision) {
      this.dirty = true;
      return;
    }
    if (!execution) return;
    this.execution = execution;
    this.sequence = execution.durable.seq;
    if (
      execution.type === "session.execution.started" ||
      (execution.type === "session.execution.interrupted" &&
        execution.data.reason === "shutdown" &&
        !turn.requestDenied)
    )
      return;
    // Read the final history only after observing idle. Never turn an observation transport error into an execution failure.
    const snapshot = await this.options.reconcile();
    if (revision !== this.revision) {
      this.dirty = true;
      return;
    }
    try {
      this.finish(turn, snapshot, execution);
    } catch (error) {
      if (this.turn === turn) this.fail(new Error(toDiagnosticErrorMessage(error)));
    }
  }
  private async dispatch(
    input: ReturnType<SessionTurns["promptInput"]>,
    options?: AgentRunOptions,
    output?: ReturnType<typeof structuredOutput>,
  ) {
    const command = input.text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (command?.[1] === "compact" || command?.[1] === "summarize") {
      await this.options.client().session.compact({ sessionID: this.options.id });
      return;
    }
    const selected = command
      ? (await commands(this.options.client(), this.options.cwd)).find(
          (item) => item.name === command[1],
        )
      : undefined;
    if (selected && selected.kind !== "skill") {
      await this.options.client().session.command({
        sessionID: this.options.id,
        name: selected.name,
        text: command?.[2] ?? "",
        files: input.files,
      });
      return;
    }
    await this.options.client().session.prompt({
      sessionID: this.options.id,
      ...input,
      ...(selected?.kind === "skill"
        ? {
            skills: [{ id: selected.name }],
            text: command?.[2] ?? `Use the ${selected.name} skill.`,
          }
        : {}),
      metadata: {
        ...(options?.clientMessageId ? { paseoClientMessageId: options.clientMessageId } : {}),
        ...(output ? { paseoOutputSchema: output.schema } : {}),
      },
    });
  }
  private async reconcileCompactionTurn(
    turn: Turn,
    compaction: CompactionTurnState,
    revision: number,
  ) {
    // Advance sequence/execution cursor and scan durable session log after baselineSeq
    // for correlated compaction failure or inbox cancellation, then inspect durable history
    // for the correlated compaction record. Only a terminal correlated record, a strictly
    // correlated compaction.failed event, or a correlated session.inbox.cancelled event can
    // settle the compaction turn.
    const outcome = await this.readCompactionLogOutcome(compaction);
    if (revision !== this.revision) {
      this.dirty = true;
      return;
    }
    if (outcome.execution && outcome.execution.durable.seq > this.sequence) {
      this.execution = outcome.execution;
      this.sequence = outcome.execution.durable.seq;
    }
    if (outcome.failedError && !compaction.failedError) {
      compaction.failedError = outcome.failedError;
    }
    if (outcome.cancelled) {
      compaction.cancelled = true;
    }
    const snapshot = await this.options.reconcile();
    if (revision !== this.revision) {
      this.dirty = true;
      return;
    }
    this.finishCompaction(turn, snapshot);
  }
  private finishCompaction(turn: Turn, { info, history }: TurnSnapshot) {
    const compaction = turn.compaction;
    if (!compaction || !compaction.inputId) return;
    const record = history.find(
      (message): message is Extract<SessionMessageInfo, { type: "compaction" }> =>
        message.type === "compaction" && message.id === compaction.inputId,
    );
    if (record?.status === "completed") {
      this.release(turn);
      this.options.emit({
        type: "turn_completed",
        provider: "opencode",
        turnId: turn.id,
        usage: usageFromV2(info),
      });
      return;
    }
    if (record?.status === "failed") {
      this.release(turn);
      this.options.emit({
        type: "turn_failed",
        provider: "opencode",
        turnId: turn.id,
        error: record.error?.message || compaction.failedError || "OpenCode compaction failed",
      });
      return;
    }
    if (compaction.failedError) {
      this.release(turn);
      this.options.emit({
        type: "turn_failed",
        provider: "opencode",
        turnId: turn.id,
        error: compaction.failedError,
      });
      return;
    }
    if (compaction.cancelled) {
      this.release(turn);
      this.options.emit({
        type: "turn_canceled",
        provider: "opencode",
        turnId: turn.id,
        reason: "OpenCode compaction was canceled before starting",
      });
    }
    // Record is still missing (queued in inbox) or "running": keep waiting and reconcile again.
  }
  private async readCompactionLogOutcome(compaction: CompactionTurnState): Promise<{
    execution: ExecutionEvent | null;
    failedError: string | null;
    cancelled: boolean;
  }> {
    let execution =
      this.execution && this.execution.durable.seq > compaction.baselineSeq ? this.execution : null;
    let failedError = compaction.failedError;
    let cancelled = compaction.cancelled;
    for await (const event of this.options
      .client()
      .session.log(
        { sessionID: this.options.id, follow: false, after: compaction.baselineSeq },
        { signal: this.options.signal },
      )) {
      if (
        isExecutionEvent(event) &&
        event.durable.seq > (execution?.durable.seq ?? compaction.baselineSeq)
      ) {
        execution = event;
      } else if (
        event.type === "session.inbox.cancelled" &&
        compaction.inputId &&
        event.data.inboxID === compaction.inputId
      ) {
        cancelled = true;
      } else if (
        event.type === "session.compaction.failed" &&
        compaction.inputId &&
        event.data.inputID === compaction.inputId
      ) {
        failedError = event.data.error.message;
      }
    }
    return { execution, failedError, cancelled };
  }
  private finish(turn: Turn, { info, history }: TurnSnapshot, execution: ExecutionEvent) {
    if (execution.type === "session.execution.succeeded") turn.output?.assert(history);
    this.release(turn);
    if (execution.type === "session.execution.interrupted")
      this.options.emit({
        type: "turn_canceled",
        provider: "opencode",
        turnId: turn.id,
        reason: "OpenCode interrupted execution",
      });
    else if (execution.type === "session.execution.failed")
      this.options.emit({
        type: "turn_failed",
        provider: "opencode",
        turnId: turn.id,
        error: execution.data.error.message,
      });
    else
      this.options.emit({
        type: "turn_completed",
        provider: "opencode",
        turnId: turn.id,
        usage: usageFromV2(info),
      });
  }
  private async readExecution(): Promise<ExecutionEvent | null> {
    let execution = this.execution;
    for await (const event of this.options
      .client()
      .session.log(
        { sessionID: this.options.id, follow: false, after: this.sequence },
        { signal: this.options.signal },
      )) {
      if (isExecutionEvent(event) && event.durable.seq > (execution?.durable.seq ?? this.sequence))
        execution = event;
    }
    return execution;
  }
  private promptInput(prompt: AgentPromptInput) {
    if (typeof prompt === "string") return { text: prompt, files: [] };
    const text: string[] = [];
    const files: Array<{ uri: string }> = [];
    for (const part of prompt) {
      if (part.type === "text") text.push(part.text);
      else if (part.type === "image")
        files.push({ uri: `data:${part.mimeType};base64,${part.data}` });
      else text.push(renderPromptAttachmentAsText(part));
    }
    return { text: text.join("\n"), files };
  }
  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    if (
      this.turn?.id !== options.expectedTurnId ||
      this.stopping ||
      this.turn?.compaction ||
      this.compactionQuarantined
    ) {
      return { status: "unavailable" };
    }
    await this.options.client().session.prompt({
      sessionID: this.options.id,
      ...this.promptInput(prompt),
      delivery: "steer",
      metadata: options.clientMessageId
        ? { paseoClientMessageId: options.clientMessageId }
        : undefined,
    });
    if (options.clearPendingPermissions) await this.options.clearPermissions();
    return { status: "accepted" };
  }
  async interrupt() {
    if (!this.stopping || this.stopFailed) {
      this.stopFailed = false;
      const turn = this.turn;
      const stop = (async () => {
        // A stop sent before the queued prompt is accepted would interrupt an idle session.
        await turn?.submitted;
        await this.options.client().session.interrupt({ sessionID: this.options.id });
        await this.reconcile();
        await turn?.completion;
      })();
      this.stopping = stop;
      try {
        await stop;
        this.stopping = null;
      } catch (error) {
        this.stopFailed = true;
        throw error;
      }
    } else await this.stopping;
  }
  private observeActiveTurn() {
    if (this.turn || this.options.signal.aborted) return;
    this.createTurn(Promise.resolve(), true);
  }
}
