import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { navigateTool, NAV_TARGETS } from "../src/agent/tools/navigation";

const Blank = defineComponent({ render: () => null });

async function makeRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", redirect: "/home" },
      { path: "/home", name: "home", component: Blank },
      { path: "/classes", name: "classes", component: Blank },
      { path: "/students", name: "students", component: Blank },
      { path: "/students/:id", name: "student-detail", component: Blank, props: true },
      { path: "/photos", name: "photos", component: Blank },
      { path: "/profile", name: "profile", component: Blank },
      { path: "/design", name: "design", component: Blank },
      { path: "/settings", name: "settings", component: Blank },
    ],
  });
  await router.push("/home");
  await router.isReady();
  return router;
}

const tool = navigateTool();

describe("navigate tool", () => {
  it("covers all registered routes", () => {
    for (const target of NAV_TARGETS) {
      expect(tool.definition.parameters.properties.target.enum).toContain(target.key);
    }
  });

  it("pushes the router to the requested page", async () => {
    const router = await makeRouter();
    const result = await tool.execute({ target: "students" }, { router });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("学生档案");
    expect(router.currentRoute.value.name).toBe("students");
  });

  it("rejects unknown targets with the available list", async () => {
    const router = await makeRouter();
    const result = await tool.execute({ target: "moon" }, { router });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未知页面");
    expect(result.error).toContain("students");
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
});
