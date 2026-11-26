import { useEffect, useRef, useState } from "react";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

/**
 * How often the sidebar re-reads `activityAt` for ordering. With many agents running, live
 * activity reshuffles the "activity" sort and the "date" sections several times a second, so
 * rows move under the pointer. Rows, status, additions and removals stay live; only the order
 * waits for the next tick.
 */
export const STEADY_ORDER_TICK_MS = 30_000;

/** Each workspace's `activityAt`; returns `previous` when nothing changed, so memos hold. */
export function snapshotActivityAt(
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  previous?: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  for (const [key, entry] of entries) next.set(key, entry.activityAt ?? 0);
  if (previous && previous.size === next.size) {
    let same = true;
    for (const [key, value] of next) {
      if (previous.get(key) !== value) {
        same = false;
        break;
      }
    }
    if (same) return previous;
  }
  return next;
}

/** The `orderActivityAt` snapshot for `buildSidebarProjection`; undefined while disabled. */
export function useSteadyActivityAt(
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  enabled: boolean,
): ReadonlyMap<string, number> | undefined {
  const latest = useRef(entries);
  useEffect(() => {
    latest.current = entries;
  }, [entries]);
  const [snapshot, setSnapshot] = useState(() => snapshotActivityAt(entries));
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => setSnapshot((previous) => snapshotActivityAt(latest.current, previous));
    refresh();
    const timer = setInterval(refresh, STEADY_ORDER_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return enabled ? snapshot : undefined;
}
