import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: {
  groupMode?: "project" | "status";
  pinnedCollapsed?: boolean;
}) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
    t: i18n.t,
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: pinned rows, grouped
      // rows, project headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const entry of projection.pinnedGroups.pinnedChats) {
        renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.pinnedGroups.unpinnedProjects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  for (const groupMode of ["project", "status"] as const) {
    it(`orders ${groupMode} rows by newest activity under the activity sort`, () => {
      const older = makeWorkspace("older", "done");
      const newer = makeWorkspace("newer", "done");
      older.entry.activityAt = 1_000;
      newer.entry.activityAt = 2_000;
      const input = {
        ...projectionInput({ groupMode }),
        projects: [makeProject([older.placement, newer.placement])],
        pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
        workspaceEntriesByKey: new Map([
          [older.entry.workspaceKey, older.entry],
          [newer.entry.workspaceKey, newer.entry],
        ]),
      };

      const rows = (projection: ReturnType<typeof buildSidebarProjection>) =>
        groupMode === "project"
          ? projection.pinnedGroups.unpinnedProjects[0]?.workspaces
          : projection.workspaceGroups[0]?.rows;
      const activityOrder = () =>
        rows(buildSidebarProjection({ ...input, workspaceSort: "activity" }))?.map(
          (entry) => entry.workspaceId,
        );
      expect(activityOrder()).toEqual(["newer", "older"]);
      older.entry.activityAt = 3_000;
      expect(activityOrder()).toEqual(["older", "newer"]);
    });
  }

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats above status groups and removes them from those groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["needs_input"]);
    expect(projection.workspaceGroups[0]?.rows.map((entry) => entry.workspaceId)).toEqual([
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(
      projectionInput({ groupMode: "status", pinnedCollapsed: true }),
    );

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
// Two projects; "b-old" has the newest creation time but no recent activity.
function dateInput(workspaceSort: "activity" | "created" | "manual") {
  const a1 = makeWorkspace("a-recent", "done", [], "project");
  const a2 = makeWorkspace("a-old", "attention", [], "project");
  const b1 = makeWorkspace("b-recent", "running", [], "other-project");
  const b2 = makeWorkspace("b-old", "done", [], "other-project");
  a1.entry.activityAt = NOW - 1 * DAY;
  a1.entry.createdAtMs = 10 * DAY;
  a2.entry.activityAt = NOW - 30 * DAY;
  a2.entry.createdAtMs = 20 * DAY;
  b1.entry.activityAt = NOW - 2 * DAY;
  b1.entry.createdAtMs = 30 * DAY;
  b2.entry.activityAt = NOW - 7 * DAY - 1;
  b2.entry.createdAtMs = 40 * DAY;
  const entries = [a1, a2, b1, b2].map((w) => w.entry);
  return {
    ...projectionInput({ groupMode: "status" }),
    groupMode: "date" as const,
    workspaceSort,
    now: NOW,
    projects: [
      makeProject([a2.placement, a1.placement]),
      makeProject([b2.placement, b1.placement], "other-project"),
    ],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map(entries.map((e) => [e.workspaceKey, e])),
  };
}
const sections = (input: Parameters<typeof buildSidebarProjection>[0]) =>
  buildSidebarProjection(input).workspaceGroups.map((group) => [
    group.label,
    group.rows.map((row) => row.workspaceId),
  ]);

describe("buildSidebarProjection date grouping", () => {
  it("splits every status into Last 7 days and Older than 7 days by activity", () => {
    expect(sections(dateInput("activity"))).toEqual([
      ["Last 7 days", ["a-recent", "b-recent"]],
      ["Older than 7 days", ["b-old", "a-old"]],
    ]);
  });

  it("orders each section by the chosen sort across projects", () => {
    expect(sections(dateInput("created"))).toEqual([
      ["Last 7 days", ["b-recent", "a-recent"]],
      ["Older than 7 days", ["b-old", "a-old"]],
    ]);
    expect(sections(dateInput("manual"))).toEqual([
      ["Last 7 days", ["a-recent", "b-recent"]],
      ["Older than 7 days", ["a-old", "b-old"]],
    ]);
  });

  it("orders and cuts by the steady activity snapshot, falling back to live activity", () => {
    const input = dateInput("activity");
    const live = [...input.workspaceEntriesByKey.values()];
    const byId = (id: string) => live.find((entry) => entry.workspaceId === id)!;
    // b-recent just had activity; the snapshot from the last tick has it behind a-recent.
    byId("b-recent").activityAt = NOW;
    const orderActivityAt = new Map(
      [byId("a-recent"), byId("b-old"), byId("a-old")].map((entry) => [
        entry.workspaceKey,
        entry.activityAt ?? 0,
      ]),
    );
    orderActivityAt.set(byId("b-recent").workspaceKey, NOW - 2 * DAY);
    expect(sections({ ...input, orderActivityAt })).toEqual([
      ["Last 7 days", ["a-recent", "b-recent"]],
      ["Older than 7 days", ["b-old", "a-old"]],
    ]);
    // A workspace the snapshot hasn't seen yet sorts by its live activity.
    orderActivityAt.delete(byId("b-recent").workspaceKey);
    expect(sections({ ...input, orderActivityAt })).toEqual([
      ["Last 7 days", ["b-recent", "a-recent"]],
      ["Older than 7 days", ["b-old", "a-old"]],
    ]);
  });

  it("drops an empty section and numbers rows in section order", () => {
    const input = dateInput("activity");
    const projection = buildSidebarProjection({ ...input, now: 10 * DAY });
    expect(projection.workspaceGroups.map((group) => group.key)).toEqual(["date:recent"]);
    expect(projection.shortcutModel.shortcutTargets.map((t) => t.workspaceId)).toEqual([
      "a-recent",
      "b-recent",
      "b-old",
      "a-old",
    ]);
  });
});
