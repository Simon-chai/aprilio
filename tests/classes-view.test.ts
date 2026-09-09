import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import ClassesView from "../src/views/ClassesView.vue";
import AppButton from "../src/components/ui/AppButton.vue";
import StudentFormDialog from "../src/components/StudentFormDialog.vue";
import { deleteStudent, listRecycleItems, listStudents } from "../src/lib/db";
describe("ClassesView.vue", () => {
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

  it("header action buttons all use AppButton and no raw unstyled button exists in header", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    const header = wrapper.get("header");
    const appButtons = header.findAllComponents(AppButton);
    const rawButtons = header.findAll("button");

    // Every button in the header must be managed by AppButton
    expect(appButtons.length).toBeGreaterThanOrEqual(2);
    expect(appButtons.length).toBe(rawButtons.length);

    // Specifically check import roster button and new class button
    const secondaryBtn = appButtons.find((btn) => btn.props("variant") === "secondary");
    const primaryBtn = appButtons.find((btn) => btn.props("variant") === "primary");
    expect(secondaryBtn).toBeDefined();
    expect(secondaryBtn?.text()).toContain("导入花名册");
    expect(primaryBtn).toBeDefined();
    expect(primaryBtn?.text()).toContain("新建班级");

    // Verify there are no raw unstyled buttons anywhere on the page
    const unstyledButtons = wrapper.findAll("button:not(.inline-flex)");
    expect(unstyledButtons.length).toBe(0);
  });

  it("renders class cards with RouterLink pointing to class-detail route and displays correct summary stats", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    // Find cards by looking for class card links
    const classLinks = wrapper.findAllComponents({ name: "RouterLink" }).filter((link) => {
      const to = link.props("to");
      if (typeof to === "string") {
        return to.startsWith("/classes/");
      }
      return typeof to === "object" && to !== null && (to.name === "class-detail" || to.path?.startsWith("/classes/"));
    });

    expect(classLinks.length).toBeGreaterThan(0);

    // Check link target for first card
    const firstLink = classLinks[0];
    const toProp = firstLink.props("to");
    if (typeof toProp === "object") {
      expect(toProp.name).toBe("class-detail");
      expect(toProp.params).toBeDefined();
      expect(toProp.params.name).toBeTruthy();
    } else {
      expect(toProp).toMatch(/^\/classes\/.+/);
    }

    // Check card details
    const text = wrapper.text();
    expect(text).toContain("男");
    expect(text).toContain("女");
    expect(text).toMatch(/照片 \d+ 张 \(公共 \d+ · 个人 \d+\)/);
    expect(text).toContain("进入班级");
  });

  it("renders class rename button right after class name with hover opacity classes", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    const renameButtons = wrapper.findAll('button[title="修改班级名称"]');
    expect(renameButtons.length).toBeGreaterThan(0);

    const firstRenameBtn = renameButtons[0];
    expect(firstRenameBtn.classes()).toContain("opacity-0");
    expect(firstRenameBtn.classes()).toContain("group-hover:opacity-100");
    expect(firstRenameBtn.classes()).toContain("inline-flex");

    // The rename button is inside the title row right next to the class name span
    const parentRow = firstRenameBtn.element.parentElement;
    expect(parentRow).not.toBeNull();
    expect(parentRow?.className).toContain("flex items-center gap-1.5");
    const nameSpan = parentRow?.querySelector("span");
    expect(nameSpan).not.toBeNull();
    expect(nameSpan?.className).toContain("truncate");
  });

  it("renders a delete button on each class card next to the rename button", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    const deleteBtns = wrapper.findAll('button[title="删除班级"]');
    const renameBtns = wrapper.findAll('button[title="修改班级名称"]');
    expect(deleteBtns.length).toBe(renameBtns.length);
    expect(deleteBtns.length).toBeGreaterThan(0);
    // 与改名按钮同款 hover 显隐样式
    expect(deleteBtns[0].classes()).toContain("inline-flex");
    expect(deleteBtns[0].classes()).toContain("group-hover:opacity-100");
  });

  it("delete button opens confirm dialog and moves the class to recycle bin", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    const beforeCount = wrapper.findAll('button[title="删除班级"]').length;
    const firstName = wrapper.get("span.truncate").text();

    await wrapper.get('button[title="删除班级"]').trigger("click");
    const dialog = wrapper.get("[data-test='delete-class-dialog']");
    expect(dialog.text()).toContain(`删除班级「${firstName}」`);
    expect(dialog.text()).toContain("回收站");

    await wrapper.get("[data-test='confirm-delete-btn']").trigger("click");
    await flushPromises();

    // 对话框关闭，班级卡片减少一张
    expect(wrapper.find("[data-test='delete-class-dialog']").exists()).toBe(false);
    expect(wrapper.findAll('button[title="删除班级"]').length).toBe(beforeCount - 1);

    // 被删班级进了回收站
    const binItems = await listRecycleItems();
    expect(binItems.find((i) => i.entity_type === "class" && i.label === firstName)).toBeDefined();
  });

  it("delete-and-recreate keeps the class as an empty group ready for rebuild", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    const firstName = wrapper.get("span.truncate").text();
    await wrapper.get('button[title="删除班级"]').trigger("click");
    await wrapper.get("[data-test='delete-recreate-btn']").trigger("click");
    await flushPromises();

    // 班级总数不变，同名班级变成空班等待重建
    const cardTexts = wrapper.findAll("span.truncate").map((n) => n.text());
    expect(cardTexts).toContain(firstName);
    const cardText = wrapper
      .findAll("span.truncate")
      .find((n) => n.text() === firstName)!
      .element.closest("a")?.textContent;
    expect(cardText).toContain("0 名学生");
  });

  it("add-student button opens the student form dialog titled 添加学生", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    const addBtn = wrapper.get("[data-test='add-student-btn']");
    expect(addBtn.text()).toContain("添加学生");
    expect(wrapper.findComponent(StudentFormDialog).props("open")).toBe(false);

    await addBtn.trigger("click");
    const dialog = wrapper.findComponent(StudentFormDialog);
    expect(dialog.exists()).toBe(true);
    expect(dialog.props("open")).toBe(true);
    expect(dialog.props("title")).toBe("添加学生");
  });

  it("submitting the add-student dialog creates the student and refreshes the page", async () => {
    const no = "CV_ADD_001";
    for (const s of await listStudents()) {
      if (s.student_no === no) await deleteStudent(s.id);
    }

    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    await wrapper.get("[data-test='add-student-btn']").trigger("click");
    const dialog = wrapper.findComponent(StudentFormDialog);
    // 表单前两个输入框依次为姓名、学号
    const inputs = dialog.findAll("input");
    await inputs[0].setValue("班级页添加生");
    await inputs[1].setValue(no);
    await dialog.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    await flushPromises();

    // 学生已建档，对话框关闭
    const created = (await listStudents()).find((s) => s.student_no === no);
    expect(created?.name).toBe("班级页添加生");
    expect(wrapper.findComponent(StudentFormDialog).props("open")).toBe(false);

    if (created) await deleteStudent(created.id);
  });
});
