import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import ClassDetailView from "../src/views/ClassDetailView.vue";
import StudentDetailView from "../src/views/StudentDetailView.vue";
import ImportRosterDialog from "../src/components/ImportRosterDialog.vue";
import StudentFormDialog from "../src/components/StudentFormDialog.vue";
import AppButton from "../src/components/ui/AppButton.vue";
import { deleteStudent, listStudents } from "../src/lib/db";

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

  it("header renders class name, breadcrumb link to 班级管理, and all action buttons use AppButton", async () => {
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

    // Check action buttons in header all use AppButton
    const appButtons = header.findAllComponents(AppButton);
    expect(appButtons.length).toBeGreaterThanOrEqual(3);

    const importBtn = appButtons.find((btn) => btn.text().includes("导入本班花名册"));
    const photoBtn = appButtons.find((btn) => btn.text().includes("添加班级照片"));
    const createBtn = appButtons.find((btn) => btn.text().includes("新建学生"));

    expect(importBtn).toBeDefined();
    expect(photoBtn).toBeDefined();
    expect(createBtn).toBeDefined();

    expect(importBtn?.props("variant")).toBe("secondary");
    expect(photoBtn?.props("variant")).toBe("secondary");
    expect(createBtn?.props("variant")).toBe("primary");
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

  it("has tabs for 学生条目 and 班级相册 and switches content when toggled", async () => {
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

    expect(studentsTab).toBeDefined();
    expect(photosTab).toBeDefined();

    // Default tab is students: table / student list should be present
    expect(wrapper.text()).toContain("林知远");

    // Click photos tab
    await photosTab!.trigger("click");
    await flushPromises();

    // In photos tab, photo filter pills or photo cards should be visible
    expect(wrapper.text()).toContain("班级公共");
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

    // Open roster dialog
    const importBtn = wrapper.findAllComponents(AppButton).find((b) => b.text().includes("导入本班花名册"));
    await importBtn?.trigger("click");
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
});
