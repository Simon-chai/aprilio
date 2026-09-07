import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { beforeEach, describe, expect, it } from "vitest";
import StudentDetailView from "../src/views/StudentDetailView.vue";
import { addBehaviorRecord } from "../src/lib/db";

describe("StudentDetailView behavior tab integration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function createTestRouter() {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/students", name: "students", component: { template: "<div>Students</div>" } },
        {
          path: "/students/:id",
          name: "student-detail",
          component: StudentDetailView,
        },
      ],
    });
  }

  it("renders tabs for behaviors and photos, with behaviors as default", async () => {
    // 写入一条模拟数据
    await addBehaviorRecord({
      student_id: 1,
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "praise",
      comment: "课堂专注度高",
      recorded_date: "2026-09-05",
    });

    const router = createTestRouter();
    await router.push("/students/1");
    await router.isReady();

    const wrapper = mount(StudentDetailView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    // 检查顶栏有「+ 记表现」按钮
    const addBtn = wrapper.find("[data-test='quick-behavior-btn']");
    expect(addBtn.exists()).toBe(true);

    // 检查 Tab 标签存在
    const behaviorTab = wrapper.get("[data-test='tab-behaviors']");
    const photosTab = wrapper.get("[data-test='tab-photos']");
    expect(behaviorTab.text()).toContain("日常表现");
    expect(photosTab.text()).toContain("图片记录");

    // 检查概览文案中包含表现记录数
    expect(wrapper.text()).toContain("条表现记录");

    // 默认展示日常表现内容
    expect(wrapper.text()).toContain("课堂专注度高");

    // 切换到图片记录
    await photosTab.trigger("click");
    expect(wrapper.findComponent({ name: "PhotoGrid" }).exists()).toBe(true);

    wrapper.unmount();
  });

  it("opens quick behavior popover when clicking + 记表现 button", async () => {
    const router = createTestRouter();
    await router.push("/students/1");
    await router.isReady();

    const wrapper = mount(StudentDetailView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    const addBtn = wrapper.find("[data-test='quick-behavior-btn']");
    expect(addBtn.exists()).toBe(true);
    await addBtn.trigger("click");
    await flushPromises();

    // Popover is teleported to body
    const card = document.body.querySelector("[data-test='quick-card']");
    expect(card).not.toBeNull();

    wrapper.unmount();
  });

  it("saves a quick behavior record and displays toast", async () => {
    const router = createTestRouter();
    await router.push("/students/1");
    await router.isReady();

    const wrapper = mount(StudentDetailView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    const addBtn = wrapper.find("[data-test='quick-behavior-btn']");
    await addBtn.trigger("click");
    await flushPromises();

    const ta = document.body.querySelector<HTMLTextAreaElement>("[data-test='comment-input']");
    expect(ta).not.toBeNull();
    ta!.value = "积极举手回答问题";
    ta!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();

    document.body.querySelector<HTMLElement>("[data-test='save-btn']")!.click();
    await flushPromises();

    const toast = wrapper.find("[data-test='quick-toast']");
    expect(toast.exists()).toBe(true);
    expect(toast.text()).toContain("已记录 林知远");
    expect(wrapper.text()).toContain("积极举手回答问题");

    wrapper.unmount();
  });

  it("removes a behavior record via timeline delete event and shows toast", async () => {
    const recId = await addBehaviorRecord({
      student_id: 1,
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "praise",
      comment: "待删除的学生档案评语",
      recorded_date: "2026-09-05",
    });

    const router = createTestRouter();
    await router.push("/students/1");
    await router.isReady();

    const wrapper = mount(StudentDetailView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    const timeline = wrapper.findComponent({ name: "StudentBehaviorTimeline" });
    expect(timeline.exists()).toBe(true);
    timeline.vm.$emit("remove", recId);
    await flushPromises();

    // 记录已被删除：界面不再展示该评语，且出现删除 toast
    expect(wrapper.text()).not.toContain("待删除的学生档案评语");
    const toast = wrapper.find("[data-test='quick-toast']");
    expect(toast.exists()).toBe(true);
    expect(toast.text()).toContain("已删除该条表现记录");

    wrapper.unmount();
  });
});
