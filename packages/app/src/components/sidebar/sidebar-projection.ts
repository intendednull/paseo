import type { TFunction } from "i18next";
import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceSort } from "@/projects/workspace-structure";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  /**
   * The project icons this projection needs fetched, keyed by `projectViewKey` — one per project,
   * whatever the mode groups by. It sits here rather than beside `useProjectIcons` in the list
   * because it is the same `projects` the rows above are projected from: a mode that renders a
   * row can only ever ask for an icon this list already covers. It used to be derived in the
   * list, under a `groupMode === "status"` gate written when status was the only mode that put
   * icons on rows.
   */
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  workspaceSort?: WorkspaceSort;
  /**
   * The `activityAt` each workspace is ordered and date-grouped by, refreshed on a timer so busy
   * workspaces don't swap places on every update (`useSteadyActivityAt`). A workspace missing from
   * it uses its live `activityAt`. Rows still render the live entry.
   */
  orderActivityAt?: ReadonlyMap<string, number>;
  /** Ms; the clock the "date" grouping cuts against (defaults to Date.now()). */
  now?: number;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  t: TFunction;
}

export function buildSidebarProjection(rawInput: SidebarProjectionInput): SidebarProjection {
  const input = rawInput.workspaceSort === "activity" ? sortProjectsByActivity(rawInput) : rawInput;
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  const pinnedWorkspaceKeys = new Set(input.pinnedKeys.pinnedWorkspaceKeys);
  const unpinnedWorkspaces = Array.from(input.workspaceEntriesByKey.values()).filter(
    (workspace) => !pinnedWorkspaceKeys.has(workspace.workspaceKey),
  );
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  const workspaceGroups = buildWorkspaceGroups(input, unpinnedWorkspaces);

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "project") {
    sections.push(
      ...pinnedGroups.unpinnedProjects.map((project) => ({
        workspaces: project.workspaces,
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }

  return {
    pinnedGroups,
    workspaceGroups,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

/**
 * Project mode keeps its project headers and groups nothing; status mode groups the rows by
 * state, date mode into "Last 7 days" and "Older than 7 days".
 */
function buildWorkspaceGroups(
  input: SidebarProjectionInput,
  unpinnedWorkspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  switch (input.groupMode) {
    case "project":
      return [];
    case "status": {
      const groups = buildStatusGroups(unpinnedWorkspaces, input.projectNamesByViewKey, input.t);
      if (input.workspaceSort === "activity") {
        // buildStatusGroups returns fresh row arrays, so sorting them in place is safe.
        const activityOf = orderingActivity(input);
        for (const group of groups) {
          group.rows.sort((left, right) => activityOf(right) - activityOf(left));
        }
      }
      return statusWorkspaceGroups(groups);
    }
    case "date":
      return dateWorkspaceGroups(input, unpinnedWorkspaces);
  }
}

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Two sections cut on `activityAt`, the activity sort's key, so a workspace is recent exactly
 * when its activity is. Rows keep the chosen sort across projects; manual keeps project order
 * with each project's manual order.
 */
function dateWorkspaceGroups(
  input: SidebarProjectionInput,
  unpinnedWorkspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  const cutoff = (input.now ?? Date.now()) - RECENT_WINDOW_MS;
  const activityOf = orderingActivity(input);
  const rows = orderAcrossProjects(input, unpinnedWorkspaces);
  const sections = [
    { recent: true, key: "date:recent", label: input.t("sidebar.display.grouping.lastSevenDays") },
    {
      recent: false,
      key: "date:older",
      label: input.t("sidebar.display.grouping.olderThanSevenDays"),
    },
  ];
  return sections
    .map((section) => ({
      key: section.key,
      label: section.label,
      rows: rows.filter((row) => activityOf(row) >= cutoff === section.recent),
      leading: { kind: "date" as const, recent: section.recent },
    }))
    .filter((group) => group.rows.length > 0);
}

function orderAcrossProjects(
  input: SidebarProjectionInput,
  workspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceEntry[] {
  const position = new Map<string, number>();
  for (const project of input.projects) {
    for (const placement of project.workspaces) position.set(placement.workspaceKey, position.size);
  }
  const byProjectOrder = (left: SidebarWorkspaceEntry, right: SidebarWorkspaceEntry) =>
    (position.get(left.workspaceKey) ?? Infinity) - (position.get(right.workspaceKey) ?? Infinity);
  const key = sortKey(input.workspaceSort, orderingActivity(input));
  return [...workspaces].sort(
    (left, right) => (key ? key(right) - key(left) : 0) || byProjectOrder(left, right),
  );
}

function sortKey(
  sort: WorkspaceSort | undefined,
  activityOf: (entry: SidebarWorkspaceEntry) => number,
): ((entry: SidebarWorkspaceEntry) => number) | null {
  switch (sort) {
    case "activity":
      return activityOf;
    case "created":
      return (entry) => entry.createdAtMs ?? 0;
    case "lastPrompt":
      return (entry) => entry.lastPromptAtMs ?? entry.createdAtMs ?? 0;
    case "manual":
    case undefined:
      return null;
  }
}

function orderingActivity(input: SidebarProjectionInput): (entry: SidebarWorkspaceEntry) => number {
  return (entry) => input.orderActivityAt?.get(entry.workspaceKey) ?? entry.activityAt ?? 0;
}

/** Orders each project's workspaces newest activity first; project and pinned order stay. */
function sortProjectsByActivity(input: SidebarProjectionInput): SidebarProjectionInput {
  const activityOf = orderingActivity(input);
  const activityAt = (workspaceKey: string) => {
    const entry = input.workspaceEntriesByKey.get(workspaceKey);
    return entry ? activityOf(entry) : 0;
  };
  return {
    ...input,
    projects: input.projects.map((project) => ({
      ...project,
      workspaces: [...project.workspaces].sort(
        (left, right) => activityAt(right.workspaceKey) - activityAt(left.workspaceKey),
      ),
    })),
  };
}
