import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it, vi } from "vitest";
import ClassDetailView from "../src/views/ClassDetailView.vue";
import StudentDetailView from "../src/views/StudentDetailView.vue";
import ImportRosterDialog from "../src/components/ImportRosterDialog.vue";
import StudentFormDialog from "../src/components/StudentFormDialog.vue";
import QuickBehaviorPopover from "../src/components/QuickBehaviorPopover.vue";
import AppButton from "../src/components/ui/AppButton.vue";
import { deleteStudent, listBehaviorDimensions, addBehaviorRecord, listBehaviorRecordsByClass, listStudents } from "../src/lib/db";
import { localDateStr } from "../src/lib/format";
import { DEFAULT_PROFILE } from "../src/types";

// 课表背景解析打桩：非 Tauri 环境拿不到缓存目录，把 bg_ 文件解析成可断言的地址
vi.mock("../src/lib/backgrounds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backgrounds")>();
  return {
    ...actual,
    backgroundCacheUrl: (file: string) => `cached://${file}`,
    backgroundsFileUrl: (file: string) => `cached://${file}`,
  };
});

describe("ClassDetailView.vue", () => {
  function createTestRouter() {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/classes", name: "classes", component: { template: "<div>Classes</div>" } },
        {
          path: "/classes/:name",
          name: "class-detail",
          component: ClassDetailView,
          props: true,
        },
        {
          path: "/students",
          name: "students",
          component: { template: "<div>Students</div>" },
        },
        {
          path: "/students/:id",
          name: "student-detail",
          component: StudentDetailView,
          props: true,
        },
      ],
    });
  }

  it("header keeps only 新建学生 AppButton; import and photo actions become icon buttons on tab tops", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    // Check title renders 三年级二班
    const header = wrapper.get("header");
    expect(header.text()).toContain("三年级二班");

    // Check back breadcrumb link to 班级管理
    const backLink = header.findComponent({ name: "RouterLink" });
    expect(backLink.exists()).toBe(true);
    expect(backLink.text()).toContain("班级管理");
    const to = backLink.props("to");
    if (typeof to === "string") {
      expect(to).toBe("/classes");
    } else {
      expect(to.name === "classes" || to.path === "/classes").toBe(true);
    }

    // Header 只保留「新建学生」主按钮
    const appButtons = header.findAllComponents(AppButton);
    expect(appButtons.length).toBe(1);
    expect(appButtons[0].text()).toContain("新建学生");
    expect(appButtons[0].props("variant")).toBe("primary");

    // 学生条目 tab 顶部：导入花名册语义图标按钮紧贴搜索栏右侧，且不在 header 内
    const importIconBtn = wrapper.find("button[aria-label='导入本班花名册']");
    expect(importIconBtn.exists()).toBe(true);
    expect(importIconBtn.element.closest("header")).toBeNull();
    // 悬浮说明文案（自绘 tooltip，WebView 中原生 title 不可靠）
    expect(importIconBtn.find("span[role='tooltip']").text()).toContain("导入本班花名册");

    // 班级相册 tab 顶部：添加照片语义图标按钮紧贴筛选胶囊右侧
    const photosTab = wrapper.findAll("button").find((b) => b.text().includes("班级相册"));
    await photosTab!.trigger("click");
    await flushPromises();
    const addPhotoIconBtn = wrapper.find("button[aria-label='添加班级照片']");
    expect(addPhotoIconBtn.exists()).toBe(true);
    expect(addPhotoIconBtn.element.closest("header")).toBeNull();
    expect(addPhotoIconBtn.find("span[role='tooltip']").text()).toContain("添加班级照片");
  });

  it("switches to another class from the class-name dropdown", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    // 默认收起，触发器带 aria-expanded 状态
    const trigger = wrapper.get('[data-test="class-switch-trigger"]');
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find('[data-test="class-switch-menu"]').exists()).toBe(false);

    // 点班级名展开：列出全部班级，当前班级唯一高亮打勾（选择器语义，而非一串链接）
    await trigger.trigger("click");
    expect(trigger.attributes("aria-expanded")).toBe("true");
    const menu = wrapper.get('[data-test="class-switch-menu"]');
    const options = menu.findAll('[data-test="class-switch-option"]');
    expect(options.length).toBeGreaterThan(1);
    const current = menu.findAll('[data-test="class-switch-option"][aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]!.text()).toContain("三年级二班");
    const target = options.find((o) => o.text().includes("三年级一班"));
    expect(target).toBeDefined();

    // 选中即跳转到该班详情
    await target!.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("class-detail");
    expect(router.currentRoute.value.params.name).toBe("三年级一班");

    // Esc 收起（测试未 attachTo，document 监听需直接派发）
    await wrapper.get('[data-test="class-switch-trigger"]').trigger("click");
    expect(wrapper.find('[data-test="class-switch-menu"]').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.find('[data-test="class-switch-menu"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("displays students belonging to 三年级二班 and excludes students from other classes", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    const text = wrapper.text();
    // 三年级二班 has 林知远 and 苏晚
    expect(text).toContain("林知远");
    expect(text).toContain("苏晚");
    // Other classes e.g. 陈嘉树 should NOT be displayed
    expect(text).not.toContain("陈嘉树");
  });

  it("renders 3 overview metric cards with correct information", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain("本班学生");
    expect(text).toContain("班级照片");
    expect(text).toContain("档案动态");
    expect(text).toContain("已归档");
  });

  it("has tabs for 学生条目, 班级相册 and 日常表现 and switches to ClassBehaviorTimeline when toggled", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    // Find tab buttons
    const buttons = wrapper.findAll("button");
    const studentsTab = buttons.find((b) => b.text().includes("学生条目"));
    const photosTab = buttons.find((b) => b.text().includes("班级相册"));
    const behaviorsTab = buttons.find((b) => b.text().includes("日常表现"));

    expect(studentsTab).toBeDefined();
    expect(photosTab).toBeDefined();
    expect(behaviorsTab).toBeDefined();

    // Default tab is students: table / student list should be present
    expect(wrapper.text()).toContain("林知远");

    // Click photos tab
    await photosTab!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("班级公共");

    // Click behaviors tab
    await behaviorsTab!.trigger("click");
    await flushPromises();
    expect(wrapper.findComponent({ name: "ClassBehaviorTimeline" }).exists()).toBe(true);
  });

  it("integrates ImportRosterDialog and StudentFormDialog with preset class", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    // Find dialog components
    const rosterDialog = wrapper.findComponent(ImportRosterDialog);
    expect(rosterDialog.exists()).toBe(true);
    expect(rosterDialog.props("presetClass")).toBe("三年级二班");
    expect(rosterDialog.props("open")).toBe(false);

    const studentDialog = wrapper.findComponent(StudentFormDialog);
    expect(studentDialog.exists()).toBe(true);
    expect(studentDialog.props("initial")).toEqual({ grade_class: "三年级二班" });
    expect(studentDialog.props("open")).toBe(false);

    // Open roster dialog via the icon button on the students tab top
    const importBtn = wrapper.find("button[aria-label='导入本班花名册']");
    expect(importBtn.exists()).toBe(true);
    await importBtn.trigger("click");
    expect(rosterDialog.props("open")).toBe(true);

    // Open student dialog
    const createBtn = wrapper.findAllComponents(AppButton).find((b) => b.text().includes("新建学生"));
    await createBtn?.trigger("click");
    expect(studentDialog.props("open")).toBe(true);
  });

  it("ImportRosterDialog falls back to presetClass when rows have no grade_class", async () => {
    const TEST_NO = "PRESET_CLS_01";
    for (const s of await listStudents()) {
      if (s.student_no === TEST_NO) await deleteStudent(s.id);
    }

    try {
      const wrapper = mount(ImportRosterDialog, {
        props: { open: true, presetClass: "三年级二班" },
      });

      // Load text without grade_class column
      type Loader = { loadText: (text: string, label?: string) => Promise<void> };
      await (wrapper.vm as unknown as Loader).loadText("姓名,学号\n测试生," + TEST_NO);
      await flushPromises();

      const importBtn = wrapper.findAll("button").find((b) => b.text().includes("开始导入"));
      expect(importBtn?.attributes("disabled")).toBeUndefined();
      await importBtn?.trigger("click");
      await flushPromises();

      const students = await listStudents(TEST_NO);
      expect(students.length).toBe(1);
      expect(students[0].grade_class).toBe("三年级二班");
    } finally {
      for (const s of await listStudents()) {
        if (s.student_no === TEST_NO) await deleteStudent(s.id);
      }
    }
  });

  it("StudentDetailView back button navigates back to class detail when student has grade_class", async () => {
    const router = createTestRouter();
    // Student 1 is 林知远 in 三年级二班
    await router.push("/students/1");
    await router.isReady();

    const wrapper = mount(StudentDetailView, {
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    const backBtn = wrapper.find("header button[title='返回列表']");
    expect(backBtn.exists()).toBe(true);
    await backBtn.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.path).toBe(`/classes/${encodeURIComponent("三年级二班")}`);
  });

  it("integrates ClassBehaviorTimeline and QuickBehaviorPopover with student navigation", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router] },
    });
    await flushPromises();

    // Switch to behaviors tab
    const behaviorsTab = wrapper.findAll("button").find((b) => b.text().includes("日常表现"));
    await behaviorsTab!.trigger("click");
    await flushPromises();

    const timeline = wrapper.findComponent({ name: "ClassBehaviorTimeline" });
    expect(timeline.exists()).toBe(true);

    // Test select-student navigates to student-detail
    timeline.vm.$emit("selectStudent", 1);
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/students/1");
  });

  it("removes a behavior record via timeline delete event", async () => {
    const dims = await listBehaviorDimensions();
    const recId = await addBehaviorRecord({
      student_id: 1,
      dimension_id: dims[0].id,
      dimension_name_snap: dims[0].name,
      category_snap: dims[0].category,
      type: "praise",
      comment: "视图集成删除评语测试",
      recorded_date: localDateStr(),
    });

    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router] },
    });
    await flushPromises();

    const behaviorsTab = wrapper.findAll("button").find((b) => b.text().includes("日常表现"));
    await behaviorsTab!.trigger("click");
    await flushPromises();

    const timeline = wrapper.findComponent({ name: "ClassBehaviorTimeline" });
    expect(timeline.exists()).toBe(true);
    timeline.vm.$emit("remove", recId);
    await flushPromises();

    const records = await listBehaviorRecordsByClass("三年级二班");
    expect(records.some((r) => r.id === recId)).toBe(false);
  });

  it("opens quick behavior popover with the first student in the class", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router], stubs: { teleport: true } },
    });
    await flushPromises();

    const behaviorsTab = wrapper.findAll("button").find((b) => b.text().includes("日常表现"));
    await behaviorsTab!.trigger("click");
    await flushPromises();

    const timeline = wrapper.findComponent({ name: "ClassBehaviorTimeline" });
    const popover = wrapper.findComponent(QuickBehaviorPopover);
    timeline.vm.$emit("add");
    await flushPromises();

    expect(popover.props("open")).toBe(true);
    expect((popover.props("student") as StudentRow).grade_class).toBe("三年级二班");
    expect((popover.props("students") as StudentRow[]).length).toBeGreaterThanOrEqual(1);
  });

  it("opens the timetable tab on the editable week grid and toggles to the calendar", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router] },
    });
    await flushPromises();

    await wrapper.get('[data-test="tab-timetable"]').trigger("click");
    await flushPromises();

    expect(wrapper.findAll('[data-test="timetable-cell"]').length).toBeGreaterThan(0);
    expect(wrapper.get('[data-test="timetable-import-btn"]').text()).toContain("导入课表");
    expect(wrapper.text()).toContain("换课 / 停课 / 日程在日历视图维护");
    // 导入课表紧贴「课表 / 日历」切换组右侧（同一个工具行，切换组里含「日历」）
    const importBtn = wrapper.get('[data-test="timetable-import-btn"]');
    const switcher = importBtn.element.previousElementSibling as HTMLElement;
    expect(switcher.contains(wrapper.get('[data-test="timetable-view-calendar"]').element)).toBe(true);

    await wrapper.get('[data-test="timetable-view-calendar"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="calendar-title"]').exists()).toBe(true);
    expect(wrapper.find('button[data-test="edit-timetable-btn"]').exists()).toBe(true);

    await wrapper.get('[data-test="timetable-view-grid"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-test="timetable-cell"]').length).toBeGreaterThan(0);
  });

  it("shows a memo recorded from the week-grid header immediately (real db)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0)); // 周三：本周一 = 2026-09-07
    try {
      const router = createTestRouter();
      await router.push("/classes/三年级二班");
      await router.isReady();

      const wrapper = mount(ClassDetailView, {
        props: { name: "三年级二班" },
        global: { plugins: [router] },
      });
      await flushPromises();

      await wrapper.get('[data-test="tab-timetable"]').trigger("click");
      await flushPromises();

      await wrapper.findAll('[data-test="grid-day-header"]')[0]!.trigger("click");
      await wrapper.get('[data-test="grid-day-memo-input"]').setValue("端到端备忘");
      await wrapper.get('[data-test="grid-memo-save"]').trigger("click");
      await flushPromises();

      expect(wrapper.findAll('[data-test="grid-day-header"]')[0]!.text()).toContain("端到端备忘");
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a memo recorded in the calendar view on the week-grid header (real db)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0)); // 周三：本周一 = 2026-09-07
    try {
      const router = createTestRouter();
      await router.push("/classes/三年级二班");
      await router.isReady();

      const wrapper = mount(ClassDetailView, {
        props: { name: "三年级二班" },
        global: { plugins: [router] },
      });
      await flushPromises();

      await wrapper.get('[data-test="tab-timetable"]').trigger("click");
      await flushPromises();

      // 切到日历视图：默认选中今天（周三，本周）
      await wrapper.get('[data-test="timetable-view-calendar"]').trigger("click");
      await flushPromises();

      await wrapper.get('[data-test="event-input"]').setValue("跨视图备忘");
      await wrapper.findAll("button").find((b) => b.text() === "添加")!.trigger("click");
      await flushPromises();
      expect(wrapper.text()).toContain("跨视图备忘");

      // 切回课表视图：这条备忘应出现在周三列头
      await wrapper.get('[data-test="timetable-view-grid"]').trigger("click");
      await flushPromises();

      const headers = wrapper.findAll('[data-test="grid-day-header"]');
      expect(headers[2]!.text()).toContain("跨视图备忘");
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the timetable when switching class while staying on the timetable tab", async () => {
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router] },
    });
    await flushPromises();

    await wrapper.get('[data-test="tab-timetable"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-test="timetable-cell"]').length).toBeGreaterThan(0);

    // 直接切换班级（等同班级下拉里选另一个班）：课程表 Tab 必须重新加载，而不是整块空白
    await wrapper.setProps({ name: "三年级一班" });
    await flushPromises();
    await flushPromises();
    expect(wrapper.findAll('[data-test="timetable-cell"]').length).toBeGreaterThan(0);
    expect(wrapper.text()).not.toContain("正在载入课表");
  });

  it("paints the profile timetable background behind the class timetable surfaces", async () => {
    const { profile } = await import("../src/lib/profile");
    profile.value = { ...DEFAULT_PROFILE, timetable_bg: "bg_class.png" };
    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router] },
    });
    await flushPromises();

    await wrapper.get('[data-test="tab-timetable"]').trigger("click");
    await flushPromises();

    // 周网格表面：背景 + 16:9 比例（与裁剪窗口一致）
    const gridSurface = wrapper.get('[data-test="class-timetable-surface"]');
    expect(gridSurface.attributes("style") ?? "").toContain("cached://bg_class.png");
    expect(gridSurface.classes()).toContain("aspect-[16/9]");

    // 切到日历视图：万年历卡片同一份背景与比例
    await wrapper.get('[data-test="timetable-view-calendar"]').trigger("click");
    await flushPromises();
    const calendarCard = wrapper.get("div.rounded-lg.border.bg-canvas");
    expect(calendarCard.attributes("style") ?? "").toContain("cached://bg_class.png");
    expect(calendarCard.classes()).toContain("aspect-[16/9]");

    profile.value = { ...DEFAULT_PROFILE };
    wrapper.unmount();
  });
});
