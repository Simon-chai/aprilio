import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import ClassesView from "../src/views/ClassesView.vue";
import AppIconButton from "../src/components/ui/AppIconButton.vue";
import StudentFormDialog from "../src/components/StudentFormDialog.vue";
import ImportRosterDialog from "../src/components/ImportRosterDialog.vue";
import { listRecycleItems } from "../src/lib/db";
import { emitPageAction } from "../src/agent/page-action-bus";
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
        { path: "/photos", name: "photos", component: { template: "<div>Photos</div>" } },
      ],
    });
  }

  it("快捷操作以「图标 + 悬浮文案」落在历史班标签右侧，且不再占据顶栏", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    // 顶栏只保留「首页」返回，业务操作全部下移到标签行
    const header = wrapper.get("header");
    expect(header.findAll("button").length).toBe(0);

    // 标签行 = 标签组 + 右侧两个快捷图标按钮（新建学生已迁移到班级详情页）
    const tabRow = wrapper.get("[data-test='class-tab-row']");
    expect(tabRow.element.closest("header")).toBeNull();

    const tabGroup = tabRow.get("[data-test='class-tab-group']");
    const quickActions = tabRow.get("[data-test='class-quick-actions']");
    const children = Array.from(tabRow.element.children);
    expect(children.indexOf(tabGroup.element as Element)).toBe(0);
    expect(children.indexOf(quickActions.element as Element)).toBe(1);

    const iconButtons = quickActions.findAllComponents(AppIconButton);
    expect(iconButtons.length).toBe(2);

    // 语义图标：上传表格 / 加号 + 尖顶房子，且都带悬浮文案；新建学生入口已迁往班级详情页
    const labels = iconButtons.map((btn) => btn.props("label"));
    expect(labels).toEqual(["导入花名册", "新建班级"]);
    const tooltips = quickActions.findAll("[role='tooltip']");
    expect(tooltips.map((t) => t.text())).toEqual(["导入花名册", "新建班级"]);
    iconButtons.forEach((btn) => {
      expect(btn.find("svg").exists()).toBe(true);
      // 校园氛围淡渐变底（白 → mint），悬浮时整体收拢到淡绿底
      expect(btn.classes()).toContain("bg-gradient-to-b");
      expect(btn.classes()).toContain("from-white");
      expect(btn.classes()).toContain("to-mint");
      expect(btn.classes()).toContain("hover:from-mint");
    });

    // 页面上不存在裸控件：原生按钮都带统一布局样式
    const nakedButtons = wrapper
      .findAll("button")
      .filter((btn) => {
        const cls = btn.attributes("class") ?? "";
        return !cls.includes("inline-flex") && !cls.includes("group/icon-btn");
      });
    expect(nakedButtons.length).toBe(0);

    // 「导入花名册」图标 → 就地打开导入对话框（学生条目已并入班级管理）
    const rosterDialog = wrapper.findComponent(ImportRosterDialog);
    expect(rosterDialog.props("open")).toBe(false);
    await iconButtons[0].trigger("click");
    await flushPromises();
    expect(rosterDialog.props("open")).toBe(true);
    expect(router.currentRoute.value.path).toBe("/classes");
  });

  it("opens student and roster dialogs from Agent page actions", async () => {
    const router = createTestRouter();
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(ClassesView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    // Agent 的 classes/create-student → 打开添加学生对话框并预填
    emitPageAction("classes/create-student", { name: "动作预填生" });
    await flushPromises();
    const studentDialog = wrapper.findComponent(StudentFormDialog);
    expect(studentDialog.props("open")).toBe(true);
    expect(studentDialog.props("initial")).toMatchObject({ name: "动作预填生" });

    // Agent 的 classes/import-roster → 打开花名册对话框并带上模式
    emitPageAction("classes/import-roster", "template");
    await flushPromises();
    const rosterDialog = wrapper.findComponent(ImportRosterDialog);
    expect(rosterDialog.props("open")).toBe(true);
    expect(rosterDialog.props("initialMode")).toBe("template");

    wrapper.unmount();
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

});
