import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  /** Newest updatedAt, attentionTimestamp or lastUserMessageAt (ms) of any agent in the workspace. */
  activityAt: number;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  const latestActivityAtByWorkspaceId = new Map<string, Date>();
  const newestAgentActivityByWorkspaceId = newestAgentActivityByWorkspace(agents);

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestActivityAt = latestActivityAtByWorkspaceId.get(agent.workspaceId);
    if (latestActivityAt && enteredAt <= latestActivityAt) {
      continue;
    }
    latestActivityAtByWorkspaceId.set(agent.workspaceId, enteredAt);

    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
      activityAt: 0,
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    activity.activityAt = newestAgentActivityByWorkspaceId.get(workspaceId) ?? 0;
    const previousActivity = previous?.get(workspaceId);
    if (previousActivity) {
      activityByWorkspaceId.set(workspaceId, keepUnchangedStatus(previousActivity, activity));
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

/** Newest updatedAt, attentionTimestamp or lastUserMessageAt of any non-archived agent. */
function newestAgentActivityByWorkspace(agents: ReadonlyMap<string, Agent>): Map<string, number> {
  const newest = new Map<string, number>();
  for (const agent of agents.values()) {
    if (agent.archivedAt || !agent.workspaceId) continue;
    const activityAt = Math.max(
      agent.updatedAt.getTime(),
      agent.attentionTimestamp?.getTime() ?? 0,
      agent.lastUserMessageAt?.getTime() ?? 0,
    );
    if (activityAt > (newest.get(agent.workspaceId) ?? 0)) {
      newest.set(agent.workspaceId, activityAt);
    }
  }
  return newest;
}

/** An unchanged agent and status keeps its enteredAt (and identity); only activityAt moves. */
function keepUnchangedStatus(
  previous: WorkspaceAgentActivity,
  next: WorkspaceAgentActivity,
): WorkspaceAgentActivity {
  if (previous.agentId !== next.agentId || previous.status !== next.status) return next;
  if (previous.activityAt === next.activityAt) return previous;
  return { ...previous, activityAt: next.activityAt };
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
