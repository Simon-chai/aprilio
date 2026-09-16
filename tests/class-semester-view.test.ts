import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClassesView from "../src/views/ClassesView.vue";
import ClassFormDialog from "../src/components/ClassFormDialog.vue";
import { createClass, deleteClass, getClassMeta } from "../src/lib/db";
import { confirmAction } from "../src/composables/useConfirm";

const CLASS = "学期视图测试班";
const ARCHIVED = "学期视图归档班";

// 归档确认已迁移为 confirmAction 命令式弹层（ConfirmHost 渲染）：
// 这里 mock 掉以控制确认分支，断言调用参数而非弹层 DOM
vi.mock("../src/composables/useConfirm", () => ({
  confirmAction: vi.fn(),
}));

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
  vi.mocked(confirmAction).mockReset();
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

    // 定位目标班级卡片，通过「⋯」菜单触发归档；确认走 confirmAction（mock 为确认）
    const card = wrapper
      .findAll("div.group")
      .find((c) => c.text().includes(ARCHIVED))!;
    expect(card).toBeTruthy();
    vi.mocked(confirmAction).mockResolvedValue(true);
    await card.get("[data-test='card-menu-btn']").trigger("click");
    await card.get("[data-test='card-menu-archive']").trigger("click");
    await flushPromises();

    // 归档确认参数与班级详情页同一文案模板
    expect(vi.mocked(confirmAction)).toHaveBeenCalledWith({
      title: `归档班级「${ARCHIVED}」`,
      message:
        "归档后，班级会从「在用班级」移出，进入「历史带过的班」；学生、成绩、表现、照片、评语与课表全部保留，只读可查，随时可以恢复。",
      confirmText: "归档",
    });
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

  it("cancelling the archive confirm keeps the class in the active list", async () => {
    await createClass(CLASS);
    const wrapper = await mountView();

    const card = wrapper
      .findAll("div.group")
      .find((c) => c.text().includes(CLASS))!;
    expect(card).toBeTruthy();
    vi.mocked(confirmAction).mockResolvedValue(false);
    await card.get("[data-test='card-menu-btn']").trigger("click");
    await card.get("[data-test='card-menu-archive']").trigger("click");
    await flushPromises();

    // 取消确认：不归档，班级仍在在用列表
    expect(vi.mocked(confirmAction)).toHaveBeenCalledTimes(1);
    expect((await getClassMeta(CLASS)).archived_at).toBeNull();
  });
});
