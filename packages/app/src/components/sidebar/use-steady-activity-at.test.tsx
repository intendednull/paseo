/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import {
  STEADY_ORDER_TICK_MS,
  snapshotActivityAt,
  useSteadyActivityAt,
} from "./use-steady-activity-at";

function entries(activity: Record<string, number>): ReadonlyMap<string, SidebarWorkspaceEntry> {
  return new Map(
    Object.entries(activity).map(([key, activityAt]) => [
      key,
      { workspaceKey: key, activityAt } as SidebarWorkspaceEntry,
    ]),
  );
}

describe("useSteadyActivityAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds activity until the next tick", () => {
    const { result, rerender } = renderHook(({ list }) => useSteadyActivityAt(list, true), {
      initialProps: { list: entries({ a: 1, b: 2 }) },
    });
    expect(result.current?.get("a")).toBe(1);

    rerender({ list: entries({ a: 3, b: 2 }) });
    expect(result.current?.get("a")).toBe(1);

    act(() => {
      vi.advanceTimersByTime(STEADY_ORDER_TICK_MS);
    });
    expect(result.current?.get("a")).toBe(3);
  });

  it("returns nothing while disabled", () => {
    const { result } = renderHook(() => useSteadyActivityAt(entries({ a: 1 }), false));
    expect(result.current).toBeUndefined();
  });
});

describe("snapshotActivityAt", () => {
  it("keeps the previous snapshot when nothing changed", () => {
    const previous = snapshotActivityAt(entries({ a: 1, b: 2 }));
    expect(snapshotActivityAt(entries({ a: 1, b: 2 }), previous)).toBe(previous);
    expect(snapshotActivityAt(entries({ a: 1 }), previous)).not.toBe(previous);
    expect(snapshotActivityAt(entries({ a: 1, b: 5 }), previous).get("b")).toBe(5);
  });
});
