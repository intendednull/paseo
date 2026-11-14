# Paseo cross-host finish notifications lost after remote restart: debug notes

2026-11-14. The local (calling) daemon ran 0.15.2 (patched); the remote host ran 0.15.4.
`file:line` refs are to getpaseo/paseo at v0.15.2 unless noted.
Investigation was read-only: nothing restarted, no agents created or killed.

## Root cause

**A prompt sent to a *closed* remote agent gets a spurious "was closed" notification. That
notification consumes the finish subscription before the resumed turn runs, so "finished"
never arrives.** The bug is on the **caller's** (local) daemon. It is a known upstream bug,
fixed in v0.16.0-beta.1 (`5062d5ee9`, #8575).

The chain:

1. `send_agent_prompt(serverId=remote)` registers a pending subscription on the caller
   (`agent/tools/paseo-tools.ts:667-682`). The caller accepts it as soon as the remote
   *acknowledges* the prompt (`paseo-tools.ts:773` / `:787`).
2. The remote doesn't dispatch an agent-sourced prompt right away. It enqueues it
   (`session.ts:8341`), and the queue flushes after 2 quiet seconds
   (`agent/agent-messages/delivery.ts:161`). Until then the remote agent still reports `status: "closed"`.
3. The accepted watch opens a remote observation at once. Its first `refresh()` (`agent/host-operations/index.ts:433`)
   fetches the snapshot (`closed`) and calls `waitForFinish(agentId, 100)`
   (`host-operations/index.ts:401`). The remote's `handleWaitForFinish` first waits for queued dispatch
   (`session.ts:8463`), so it times out at 100 ms. On timeout the code **re-fetches the same
   closed snapshot and hands it to the handler** (`host-operations/index.ts:402-403`).
4. `isTerminal()` treats `closed` as terminal (`finish-subscriptions/internal/observation-stream.ts:15`). The
   buffer gets a terminal result, `reasonFor` maps it to "was closed" (`finish-subscriptions/index.ts:165`), it is
   delivered, and the record is removed (`index.ts:280`).
5. The prompt then dispatches, the agent resumes, and it runs and finishes. No subscription is left.

The local path doesn't have this bug: the local `wait` calls `waitForDispatch` first
(`finish-subscriptions/internal/observation.ts:30`), and the local `send_agent_prompt` accepts only in `onDispatch`
(`paseo-tools.ts:1981`). The remote path accepts on acknowledgment and reads state before dispatch.

### Evidence (times are PST; from the calling agent's session and the remote `daemon.log`)

| send_agent_prompt to agent A | agent state | notification | remote log |
|---|---|---|---|
| 03:39:17 (after reboot 1) | closed | **"closed"** immediately | 03:39:20 "Agent resumed from persistence" |
| 03:39:42, 03:40:21 | live | "finished" 03:44:58 ✅ | – |
| 03:49:39 (after reboot 2) | closed | **"closed"** 03:49:45 | 03:49:45 "Agent resumed from persistence" |
| 04:02:07 (after reboot 3) | – | none yet; record still in local store | – |

- A second agent (B) follows the same pattern. The 03:46:38 prompt went to a live agent and got "finished".
  The 03:49:42 prompt went to a closed agent and drew "closed" (its resume is logged at 03:49:44), with no "finished".
- The "closed" notification arrives in the same second as the remote's resume log line. The
  observer read the snapshot just before dispatch.
- Every lost "finished" follows a prompt to a closed agent. Every prompt to a live agent got its
  "finished", including across reboots.
- The remote has no `~/.paseo/finish-subscriptions.json`; subscriptions live only on the caller. The local file
  held agent A's 04:02 record, still pending.
- The local daemon log has nothing useful: finish subscriptions log only on failure, and none failed.

### Ruled out

- **The remote restart dropping in-memory subscriptions.** Subscriptions persist on the caller and are recovered in `start()`
  (`index.ts:314-324`). The remote holds none.
- **send_agent_prompt not re-arming.** It does re-arm (`paseo-tools.ts:667`). The re-armed subscription is the one the false "closed" consumes.
- **"closed" from the restart itself consuming the subscription.** That notification is legitimate: the agent really was closed.
  The bug is the *next* subscription getting a stale "closed".

## Operator hypothesis: version mismatch. Refuted

- `git diff v0.15.2..v0.15.4` over finish-subscriptions, host-operations, agent-messages, paseo-tools and the client
  is **empty**. 0.15.3 and 0.15.4 only touched the iOS chat and the Claude model catalog (Fable/Mythos 5.2).
- The buggy code runs on the **caller** daemon, so the remote's version doesn't matter here.
- **Updating local to 0.15.4 would not fix this.** The fix is `5062d5ee9` in **v0.16.0-beta.1** and beta.2,
  and no 0.15.x release has it. Its regression test is in `connected-hosts/hosts.e2e.test.ts`: "remote prompt to a closed
  agent (archived=%s) reports its new turn instead of stale closure".
- It is the only notification-relevant change between 0.15.4 and 0.16.0-beta.1. The other diffs in these files are
  plugin and workspace plumbing.

## Proposed fix (backport of 5062d5ee9)

`paseo-notify-debug-0007-remote-finish-after-wake.patch` (next to this file) is the first
version, a diff against the shipped 0.15.2 dist JS
(`node_modules/@getpaseo/server/dist/server/server/agent/host-operations/index.js`). On a
timed-out `waitForFinish(agentId, 100)` it reports nothing, except forwarding a
`permission_resolved` event; the outcome then comes from the dispatch-aware `wait()`
(`pushInitial`) or a later `turn_completed` event. Only the calling daemon needs it. This fork
carries the upstream commit itself, with its `hosts.e2e.test.ts` case ("remote prompt to a
closed agent (archived=%s) reports its new turn instead of stale closure"), which fails without
the fix.

## Workarounds until then

- **Wake ping:** after a remote restart, first send each closed agent a throwaway prompt ("reply ok").
  It eats the spurious "closed". Once the agent shows live or idle in `get_agent_status`, send the real prompt,
  which notifies normally.
- **Treat a fast "closed" as spurious:** a "closed" within about 10 s of a send to a remote agent means the
  subscription is gone. Poll with `get_agent_status` or `get_agent_activity`.
- Upgrading only the remote, or moving to 0.15.4, does nothing. 0.16.0 fixes it, but upgrading Paseo also means
  rebasing the local patches.
