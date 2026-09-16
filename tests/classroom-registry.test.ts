import { describe, expect, it } from "vitest";
import type { Component } from "vue";
import {
  createActivityRegistry,
  getActivityRegistry,
  resolveActivityEntries,
  scanActivities,
} from "../src/classroom/registry";
import type { LessonActivityDef } from "../src/classroom/types";

/**
 * 活动注册表（放文件即接入）：
 * - import.meta.glob 扫描 activities/*.activity.ts → 四个内建活动自动装配
 * - 重复 type fail-fast；未注册 type 组合里跳过并回报（不阻断开课）
 */

const stubDef = (type: string): LessonActivityDef<unknown> => ({
  type,
  title: `测试活动 ${type}`,
  icon: "sparkles",
  requires: [],
  settle: "session",
  reduce: (state) => state,
  component: { render: () => null } as unknown as Component,
});

const BUILTIN_TYPES = ["digest", "group-race", "picker", "seating"];

describe("classroom activity registry", () => {
  it("scans activity modules from activities/*.activity.ts", () => {
    const defs = scanActivities();
    expect(defs.map((d) => d.type).sort()).toEqual(BUILTIN_TYPES);
    for (const def of defs) {
      expect(def.title).toBeTruthy();
      expect(Array.isArray(def.requires)).toBe(true);
      expect(["behavior", "session"]).toContain(def.settle);
      expect(typeof def.reduce).toBe("function");
      expect(def.component).toBeTruthy();
    }
  });

  it("lazily assembles a shared registry singleton", () => {
    const registry = getActivityRegistry();
    expect(getActivityRegistry()).toBe(registry);
    expect([...registry.keys()].sort()).toEqual(BUILTIN_TYPES);
  });

  it("fails fast on duplicate or empty activity type", () => {
    expect(() => createActivityRegistry([stubDef("dupe"), stubDef("dupe")])).toThrow(
      "活动 type 重复注册：dupe",
    );
    expect(() => createActivityRegistry([stubDef("  ")])).toThrow("活动定义的 type 不能为空");
    // 合法定义（含前后空格）会被 trim 后注册
    const registry = createActivityRegistry([stubDef(" spaced ")]);
    expect([...registry.keys()]).toEqual(["spaced"]);
  });

  it("resolves entries in order, passes config through, skips unknown types", () => {
    const registry = getActivityRegistry();
    const { activities, skipped } = resolveActivityEntries(
      [
        { type: "picker", config: { mode: "weighted" } },
        { type: "countdown" },
        { type: "seating" },
      ],
      registry,
    );

    expect(activities.map((a) => a.def.type)).toEqual(["picker", "seating"]);
    expect(activities[0].config).toEqual({ mode: "weighted" });
    // 未配 config → 空对象（活动自行取缺省）
    expect(activities[1].config).toEqual({});
    expect(skipped).toEqual(["countdown"]);
  });

  it("tolerates empty and all-unknown sets without blocking", () => {
    const registry = getActivityRegistry();
    expect(resolveActivityEntries([], registry)).toEqual({ activities: [], skipped: [] });

    const { activities, skipped } = resolveActivityEntries(
      [{ type: "countdown" }, { type: "lottery-draw" }],
      registry,
    );
    expect(activities).toEqual([]);
    expect(skipped).toEqual(["countdown", "lottery-draw"]);
  });
});