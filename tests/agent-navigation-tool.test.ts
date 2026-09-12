import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import navTool, { NAV_TARGETS, normalizeClassName } from "../src/agent/tools/navigation";

const Blank = defineComponent({ render: () => null });

async function makeRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", redirect: "/home" },
      { path: "/home", name: "home", component: Blank },
      { path: "/classes", name: "classes", component: Blank },
      { path: "/classes/:name", name: "class-detail", component: Blank, props: true },
      { path: "/students/:id", name: "student-detail", component: Blank, props: true },
      { path: "/photos", name: "photos", component: Blank },
      { path: "/timetable", name: "timetable", component: Blank },
      { path: "/recycle-bin", name: "recycle-bin", component: Blank },
      { path: "/profile", name: "profile", component: Blank },
      { path: "/settings", name: "settings", component: Blank },
    ],
  });
  await router.push("/home");
  await router.isReady();
  return router;
}

const tool = navTool;

describe("navigate tool", () => {
  it("covers all registered routes", () => {
    for (const target of NAV_TARGETS) {
      expect(tool.definition.parameters.properties.target.enum).toContain(target.key);
    }
  });

  it("exposes entity params of resolver targets in the schema", () => {
    expect(tool.definition.parameters.properties.class_name).toBeTruthy();
    expect(tool.definition.parameters.properties.student_id).toBeTruthy();
  });

  it("pushes the router to the requested page", async () => {
    const router = await makeRouter();
    const result = await tool.execute({ target: "classes" }, { router });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("班级管理");
    expect(router.currentRoute.value.name).toBe("classes");
  });

  it("navigates page-level targets by their registered route", async () => {
    const router = await makeRouter();
    for (const target of NAV_TARGETS.filter((t) => !t.resolve)) {
      const result = await tool.execute({ target: target.key }, { router });
      expect(result.ok, `${target.key} 应可跳转`).toBe(true);
      expect(router.currentRoute.value.name).toBe(target.routeName);
    }
  });

  it("rejects unknown targets with the available list", async () => {
    const router = await makeRouter();
    const result = await tool.execute({ target: "moon" }, { router });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未知页面");
    expect(result.error).toContain("classes");
  });

  it("requires a student id for the detail page", async () => {
    const router = await makeRouter();
    const missing = await tool.execute({ target: "student-detail" }, { router });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("student_id");
  });

  it("verifies the student exists before navigating", async () => {
    const router = await makeRouter();
    const ok = await tool.execute({ target: "student-detail", student_id: 1 }, { router });
    expect(ok.ok).toBe(true);
    expect(ok.summary).toContain("林知远");
    expect(router.currentRoute.value.name).toBe("student-detail");
    expect(router.currentRoute.value.params.id).toBe("1");

    const missing = await tool.execute({ target: "student-detail", student_id: 9999 }, { router });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("9999");
  });

  it("requires a class name for the class detail page", async () => {
    const router = await makeRouter();
    const missing = await tool.execute({ target: "class-detail" }, { router });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("class_name");
  });

  it("opens class detail by a colloquial class name", async () => {
    const router = await makeRouter();
    const ok = await tool.execute({ target: "class-detail", class_name: "三年二班" }, { router });
    expect(ok.ok).toBe(true);
    expect(ok.summary).toContain("三年级二班");
    expect(router.currentRoute.value.name).toBe("class-detail");
    expect(router.currentRoute.value.params.name).toBe("三年级二班");
  });

  it("reports ambiguity instead of guessing between matching classes", async () => {
    const router = await makeRouter();
    const result = await tool.execute({ target: "class-detail", class_name: "二班" }, { router });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("匹配到多个班级");
    expect(result.error).toContain("三年级二班");
    expect(result.error).toContain("五年级二班");
  });

  it("fails clearly when the class does not exist", async () => {
    const router = await makeRouter();
    const result = await tool.execute({ target: "class-detail", class_name: "六年级八班" }, { router });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("找不到班级");
  });
});

describe("normalizeClassName", () => {
  it("unifies colloquial class name variants", () => {
    expect(normalizeClassName("三年级二班")).toBe("3年2班");
    expect(normalizeClassName("三年二班")).toBe("3年2班");
    expect(normalizeClassName("3 年 2 班")).toBe("3年2班");
    expect(normalizeClassName("三年级2班")).toBe("3年2班");
  });
});
