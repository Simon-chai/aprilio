import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClassDetailView from "../src/views/ClassDetailView.vue";
import StudentDetailView from "../src/views/StudentDetailView.vue";
import ExamScorePanel from "../src/components/ExamScorePanel.vue";
import ImportRosterDialog from "../src/components/ImportRosterDialog.vue";
import StudentFormDialog from "../src/components/StudentFormDialog.vue";
import QuickBehaviorPopover from "../src/components/QuickBehaviorPopover.vue";
import AppButton from "../src/components/ui/AppButton.vue";
import {
  deleteStudent,
  listBehaviorDimensions,
  addBehaviorRecord,
  listBehaviorRecordsByClass,
  listStudents,
  createClass,
  deleteClass,
  getClassMeta,
  listClasses,
} from "../src/lib/db";
import { confirmAction } from "../src/composables/useConfirm";
import { localDateStr } from "../src/lib/format";

// 班级详情页的归档/删除确认已迁移为 confirmAction 命令式弹层：
// mock 掉以控制确认分支，断言调用参数（与 ClassesView 同一文案模板）
vi.mock("../src/composables/useConfirm", () => ({
  confirmAction: vi.fn(),
}));

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
          path: "/students/:id",
          name: "student-detail",
          component: StudentDetailView,
          props: true,
        },
      ],
    });
  }

  it("header keeps no create button; roster import and create-student live on the students tab top", async () => {
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

    // Header 不再承载「新建学生」主按钮：写入口统一收进学生条目 tab 的搜索栏右侧
    expect(header.findAllComponents(AppButton)).toHaveLength(0);

    // 学生条目 tab 顶部：搜索栏右侧并列「导入本班花名册」与「新建学生」两个图标按钮，且都不在 header 内
    const importIconBtn = wrapper.find("button[aria-label='导入本班花名册']");
    expect(importIconBtn.exists()).toBe(true);
    expect(importIconBtn.element.closest("header")).toBeNull();
    // 悬浮说明文案（自绘 tooltip，WebView 中原生 title 不可靠）
    expect(importIconBtn.find("span[role='tooltip']").text()).toContain("导入本班花名册");

    const createIconBtn = wrapper.find("button[aria-label='新建学生']");
    expect(createIconBtn.exists()).toBe(true);
    expect(createIconBtn.element.closest("header")).toBeNull();
    expect(createIconBtn.find("span[role='tooltip']").text()).toContain("新建学生");

    // 同一行：搜索框 + 两个图标按钮，且图标按钮与班级管理页同款渐变描边皮肤
    const toolbar = importIconBtn.element.parentElement as HTMLElement;
    expect(toolbar.contains(createIconBtn.element)).toBe(true);
    expect(toolbar.querySelector("input")).not.toBeNull();
    [importIconBtn, createIconBtn].forEach((btn) => {
      expect(btn.classes()).toContain("grad-border");
      expect(btn.classes()).toContain("text-primary");
    });

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

  it("renders 4 overview metric cards that jump to the matching tab when clicked", async () => {
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
    expect(text).toContain("考试成绩");
    expect(text).toContain("已归档");

    // 四张概览卡整卡都是按钮，右上角带跳转箭头
    const cards = wrapper.findAll("button[data-test^='metric-card-']");
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.element.tagName).toBe("BUTTON");
      expect(card.find("[data-test='metric-card-arrow']").exists()).toBe(true);
    }

    // 学生卡 → 学生条目
    await wrapper.get("[data-test='metric-card-students']").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("林知远");

    // 照片卡 → 班级相册
    await wrapper.get("[data-test='metric-card-photos']").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("班级公共");

    // 档案动态卡 → 日常表现
    await wrapper.get("[data-test='metric-card-behaviors']").trigger("click");
    await flushPromises();
    expect(wrapper.findComponent({ name: "ClassBehaviorTimeline" }).exists()).toBe(true);

    // 成绩卡 → 考试成绩面板
    await wrapper.get("[data-test='metric-card-scores']").trigger("click");
    await flushPromises();
    expect(wrapper.findComponent(ExamScorePanel).exists()).toBe(true);
  });

  it("shows the class score trend sparkline on the scores metric card", async () => {
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

    const card = wrapper.get("[data-test='metric-card-scores']");
    const spark = card.find("[data-test='score-trend-sparkline']");
    expect(spark.exists()).toBe(true);
    // 演示数据 3 次考试 → 一条连续折线 + 末端高亮点，全部成绩参与均分计算
    expect(spark.findAll("polyline[data-test='spark-line']")).toHaveLength(1);
    expect(spark.find("[data-test='spark-last-point']").exists()).toBe(true);
    expect(card.text()).toContain("共 3 次考试");
    expect(card.text()).toContain("最近均分");
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

    // Open student dialog from the create icon button right of the search box
    const createBtn = wrapper.get("[data-test='create-student-btn']");
    await createBtn.trigger("click");
    expect(studentDialog.props("open")).toBe(true);
  });

  it("creates a student from the students-tab create button with the class preset", async () => {
    const no = "CD_ADD_001";
    for (const s of await listStudents()) {
      if (s.student_no === no) await deleteStudent(s.id);
    }

    const router = createTestRouter();
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(ClassDetailView, {
      props: { name: "三年级二班" },
      global: { plugins: [router] },
    });
    await flushPromises();

    await wrapper.get("[data-test='create-student-btn']").trigger("click");
    const dialog = wrapper.findComponent(StudentFormDialog);
    expect(dialog.props("open")).toBe(true);
    // 表单前两个输入框依次为姓名、学号
    const inputs = dialog.findAll("input");
    await inputs[0].setValue("详情页添加生");
    await inputs[1].setValue(no);
    await dialog.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    await flushPromises();

    const created = (await listStudents()).find((s) => s.student_no === no);
    expect(created?.name).toBe("详情页添加生");
    expect(created?.grade_class).toBe("三年级二班");
    expect(wrapper.findComponent(StudentFormDialog).props("open")).toBe(false);

    if (created) await deleteStudent(created.id);
    wrapper.unmount();
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
});

describe("ClassDetailView 归档 / 删除班级确认（confirmAction 统一模板）", () => {
  const CONFIRM_CLASS = "详情页确认测试班";

  function createConfirmRouter() {
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
          path: "/students/:id",
          name: "student-detail",
          component: StudentDetailView,
          props: true,
        },
      ],
    });
  }

  beforeEach(() => {
    vi.mocked(confirmAction).mockReset();
  });

  afterEach(async () => {
    await deleteClass(CONFIRM_CLASS);
  });

  async function mountConfirmView() {
    const router = createConfirmRouter();
    await router.push(`/classes/${CONFIRM_CLASS}`);
    await router.isReady();
    const wrapper = mount(ClassDetailView, {
      props: { name: CONFIRM_CLASS },
      global: { plugins: [router] },
    });
    await flushPromises();
    return { router, wrapper };
  }

  it("归档班级走 confirmAction，文案与 ClassesView 归档入口同一模板", async () => {
    await createClass(CONFIRM_CLASS);
    vi.mocked(confirmAction).mockResolvedValue(true);
    const { router, wrapper } = await mountConfirmView();

    await wrapper.get("[data-test='archive-class-btn']").trigger("click");
    await flushPromises();

    expect(vi.mocked(confirmAction)).toHaveBeenCalledWith({
      title: `归档班级「${CONFIRM_CLASS}」`,
      message:
        "归档后，班级会从「在用班级」移出，进入「历史带过的班」；学生、成绩、表现、照片、评语与课表全部保留，只读可查，随时可以恢复。",
      confirmText: "归档",
    });
    expect((await getClassMeta(CONFIRM_CLASS)).archived_at).toBeTruthy();
    // 归档成功后回到班级管理页
    expect(router.currentRoute.value.name).toBe("classes");
    wrapper.unmount();
  });

  it("取消归档不落库，停留在班级详情", async () => {
    await createClass(CONFIRM_CLASS);
    vi.mocked(confirmAction).mockResolvedValue(false);
    const { router, wrapper } = await mountConfirmView();

    await wrapper.get("[data-test='archive-class-btn']").trigger("click");
    await flushPromises();

    expect((await getClassMeta(CONFIRM_CLASS)).archived_at).toBeNull();
    expect(router.currentRoute.value.name).toBe("class-detail");
    wrapper.unmount();
  });

  it("删除班级走 confirmAction danger 文案，确认后进回收站并回班级管理", async () => {
    await createClass(CONFIRM_CLASS);
    vi.mocked(confirmAction).mockResolvedValue(true);
    const { router, wrapper } = await mountConfirmView();

    await wrapper.get("[data-test='delete-class-btn']").trigger("click");
    await flushPromises();

    expect(vi.mocked(confirmAction)).toHaveBeenCalledWith({
      title: `删除班级「${CONFIRM_CLASS}」`,
      message:
        "班级下的学生档案、照片与表现记录将一并移入回收站，保留 7 天，期间可随时恢复；超过 7 天将彻底删除。",
      confirmText: "删除",
      tone: "danger",
    });
    // 删除后进回收站，不再出现在班级列表
    expect((await listClasses()).some((c) => c.name === CONFIRM_CLASS)).toBe(false);
    expect(router.currentRoute.value.name).toBe("classes");
    wrapper.unmount();
  });

  it("取消删除不落库", async () => {
    await createClass(CONFIRM_CLASS);
    vi.mocked(confirmAction).mockResolvedValue(false);
    const { wrapper } = await mountConfirmView();

    await wrapper.get("[data-test='delete-class-btn']").trigger("click");
    await flushPromises();

    expect((await listClasses()).some((c) => c.name === CONFIRM_CLASS)).toBe(true);
    wrapper.unmount();
  });
});
