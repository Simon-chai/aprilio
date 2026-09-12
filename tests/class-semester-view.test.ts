import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, describe, expect, it } from "vitest";
import ClassesView from "../src/views/ClassesView.vue";
import ClassFormDialog from "../src/components/ClassFormDialog.vue";
import { createClass, deleteClass, getClassMeta } from "../src/lib/db";

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

describe("ClassFormDialog 班级名提交", () => {
  it("submits the trimmed class name", async () => {
    const wrapper = mount(ClassFormDialog, { props: { open: true } });
    await wrapper.get("[data-test='class-name-input'] input").setValue("  三年级二班  ");
    await wrapper.get("form").trigger("submit");

    expect(wrapper.emitted("submit")?.[0]?.[0]).toEqual({ name: "三年级二班" });
  });
});

describe("ClassesView 归档与历史班", () => {
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
