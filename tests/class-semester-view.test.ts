import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, describe, expect, it } from "vitest";
import ClassesView from "../src/views/ClassesView.vue";
import ClassFormDialog from "../src/components/ClassFormDialog.vue";
import {
  createClass,
  deleteClass,
  getClassMeta,
  saveClassMeta,
} from "../src/lib/db";

const CLASS = "学期视图测试班";
const ARCHIVED = "学期视图归档班";

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/home", name: "home", component: { template: "<div>Home</div>" } },
      { path: "/classes", name: "classes", component: ClassesView },
      {
        path: "/classes/:name",
        name: "class-detail",
        component: { template: "<div>ClassDetail</div>" },
        props: true,
      },
      { path: "/students", name: "students", component: { template: "<div>Students</div>" } },
      { path: "/photos", name: "photos", component: { template: "<div>Photos</div>" } },
    ],
  });
}

async function mountView() {
  const router = createTestRouter();
  await router.push("/classes");
  await router.isReady();
  const wrapper = mount(ClassesView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

afterEach(async () => {
  await deleteClass(CLASS);
  await deleteClass(ARCHIVED);
});

describe("ClassFormDialog 年级识别与提交", () => {
  it("infers grade from the class name and submits grade/semester", async () => {
    const wrapper = mount(ClassFormDialog, { props: { open: true } });
    await wrapper.get("[data-test='class-name-input'] input").setValue("三年级二班");
    await flushPromises();

    // 规则识别出三年级 → 下拉自动预选
    expect(wrapper.get("[data-test='class-grade-select']").element).toHaveProperty("value", "3");

    await wrapper.get("form").trigger("submit");
    const emitted = wrapper.emitted("submit")?.[0]?.[0] as {
      name: string;
      entry_grade: number | null;
      entry_semester: string | null;
    };
    expect(emitted).toMatchObject({ name: "三年级二班", entry_grade: 3 });
    expect(emitted.entry_semester).toBeTruthy();
  });
});

describe("ClassesView 归档与历史班", () => {
  it("shows current grade badge for a registered class", async () => {
    await createClass(CLASS);
    await saveClassMeta(CLASS, { entry_grade: 3, entry_semester: "2025-2026-1" });

    const wrapper = await mountView();
    const badge = wrapper.get("[data-test='class-grade-badge']");
    // 未指定时间时按当前系统时间推导：至少显示「年级 · 学期」
    expect(badge.text()).toMatch(/(一|二|三|四|五|六)年级 · (上|下)学期/);
  });

  it("archives a class and lists it under 历史带过的班", async () => {
    await createClass(ARCHIVED);
    const wrapper = await mountView();

    // 定位目标班级卡片，点它的归档按钮
    const card = wrapper
      .findAll("div.group")
      .find((c) => c.text().includes(ARCHIVED))!;
    expect(card).toBeTruthy();
    await card.get("[data-test='archive-class-btn']").trigger("click");
    expect(wrapper.find("[data-test='archive-class-dialog']").exists()).toBe(true);
    await wrapper.get("[data-test='confirm-archive-btn']").trigger("click");
    await flushPromises();

    expect((await getClassMeta(ARCHIVED)).archived_at).toBeTruthy();

    // 切到历史班标签页，能看到恢复按钮
    await wrapper.get("[data-test='class-tab-archived']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-test='restore-class-btn']").exists()).toBe(true);
    expect(wrapper.text()).toContain(ARCHIVED);

    await wrapper.get("[data-test='restore-class-btn']").trigger("click");
    await flushPromises();
    expect((await getClassMeta(ARCHIVED)).archived_at).toBeNull();
  });
});

describe("ClassesView 升级提醒", () => {
  it("点过「知道了」后重新进入班级管理不再提示（按学期记忆）", async () => {
    sessionStorage.clear();
    await createClass(CLASS);
    await saveClassMeta(CLASS, { entry_grade: 3, entry_semester: "2025-2026-1" });

    const first = await mountView();
    expect(first.find("[data-test='upgrade-notice']").exists()).toBe(true);
    await first.get("[data-test='upgrade-notice'] button").trigger("click");
    expect(first.find("[data-test='upgrade-notice']").exists()).toBe(false);

    // 重新挂载（等价于离开再回到班级管理页）：同一学期内不再提示
    const second = await mountView();
    expect(second.find("[data-test='upgrade-notice']").exists()).toBe(false);
  });
});
