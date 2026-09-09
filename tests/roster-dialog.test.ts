import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ImportRosterDialog from "../src/components/ImportRosterDialog.vue";
import { deleteClass, deleteStudent, listStudents } from "../src/lib/db";

const TEMPLATE_TEXT = "姓名,性别,学号\n张小三,男,9000091\n李小红,女,9000092";
const TEST_NOS = ["9000091", "9000092"];

type Loader = { loadText: (text: string, label?: string) => Promise<void> };

function findImportButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.findAll("button").find((b) => b.text().includes("开始导入"));
  expect(button, "导入按钮应存在").toBeDefined();
  return button!;
}

async function cleanupByNos(nos: string[]) {
  const set = new Set(nos);
  for (const s of await listStudents()) {
    if (set.has(s.student_no)) await deleteStudent(s.id);
  }
}

describe("ImportRosterDialog", () => {
  it("renders both modes and keeps import disabled before a file is loaded", () => {
    const wrapper = mount(ImportRosterDialog, { props: { open: true } });
    expect(wrapper.text()).toContain("导入花名册");
    const texts = wrapper.findAll("button").map((b) => b.text());
    expect(texts).toContain("智能导入");
    expect(texts).toContain("指定格式导入");
    expect(findImportButton(wrapper).attributes("disabled")).toBeDefined();
  });

  it("detects the name column and enables import after loading a table (smart mode)", async () => {
    const wrapper = mount(ImportRosterDialog, { props: { open: true } });
    await (wrapper.vm as unknown as Loader).loadText(TEMPLATE_TEXT);

    expect(wrapper.text()).toContain("共 2 行数据");
    expect(wrapper.text()).toContain("已识别表头");
    expect(wrapper.text()).toContain("规则识别");
    expect(wrapper.text()).toContain("姓名 ← 第1列「姓名」");
    expect(wrapper.text()).toContain("性别 ← 第2列「性别」");
    expect(wrapper.text()).toContain("其余列将忽略");
    expect(findImportButton(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("imports students and emits imported", async () => {
    await cleanupByNos(TEST_NOS);
    try {
      const wrapper = mount(ImportRosterDialog, { props: { open: true } });
      await (wrapper.vm as unknown as Loader).loadText(TEMPLATE_TEXT);
      await findImportButton(wrapper).trigger("click");
      await flushPromises();

      expect(wrapper.text()).toContain("导入完成：成功 2");
      expect(wrapper.emitted("imported")).toHaveLength(1);
    } finally {
      await cleanupByNos(TEST_NOS);
    }
  });

  it("blocks files without the 姓名 column in template mode", async () => {
    const wrapper = mount(ImportRosterDialog, {
      props: { open: true, initialMode: "template" as const },
    });
    expect(wrapper.text()).toContain("指定格式导入");

    await (wrapper.vm as unknown as Loader).loadText("学号,性别\n1,男");
    expect(wrapper.text()).toContain("缺少「姓名」列");
    expect(findImportButton(wrapper).attributes("disabled")).toBeDefined();
  });

  it("asks for manual name column selection when detection is not confident", async () => {
    const wrapper = mount(ImportRosterDialog, { props: { open: true } });
    await (wrapper.vm as unknown as Loader).loadText("编号,金额\n1,100\n2,200");

    expect(wrapper.text()).toContain("请选择姓名列");
    expect(wrapper.text()).toContain("未能可靠识别姓名列");
    expect(findImportButton(wrapper).attributes("disabled")).toBeDefined();
  });

  it("hints auto-split and navigates to the auto class for unnamed batches", async () => {
    const nos = ["9000093", "9000094"];
    await cleanupByNos(nos);
    let autoClass: string | null = null;
    try {
      const wrapper = mount(ImportRosterDialog, { props: { open: true } });
      await (wrapper.vm as unknown as Loader).loadText("姓名,学号\n无名甲,9000093\n无名乙,9000094");

      expect(wrapper.text()).toContain("自动新建一个班级");
      await findImportButton(wrapper).trigger("click");
      await flushPromises();

      expect(wrapper.text()).toContain("导入完成：成功 2");
      const emitted = wrapper.emitted("imported")?.[0]?.[0] as {
        result: { autoClass?: string | null };
        targetClass: string | null;
      };
      expect(emitted).toBeDefined();
      autoClass = emitted.result.autoClass ?? emitted.targetClass;
      expect(autoClass).toMatch(/^未命名班级\d+$/);
      expect(emitted.targetClass).toBe(autoClass);
      expect(wrapper.text()).toContain(`已进入「${autoClass}」`);
    } finally {
      await cleanupByNos(nos);
      if (autoClass) {
        try {
          await deleteClass(autoClass);
        } catch {
          /* 忽略 */
        }
      }
    }
  });

  it("imports multiple files at once and aggregates the result", async () => {
    const nos = ["9000101", "9000102", "9000103", "9000104"];
    await cleanupByNos(nos);
    try {
      const wrapper = mount(ImportRosterDialog, { props: { open: true } });
      const loader = wrapper.vm as unknown as Loader;
      await loader.loadText("姓名,学号,年级班级\n多文件甲,9000101,多文件测试班\n多文件乙,9000102,多文件测试班", "一班.csv");
      await loader.loadText("姓名,学号,年级班级\n多文件丙,9000103,多文件测试班\n多文件丁,9000104,多文件测试班", "二班.csv");

      expect(wrapper.text()).toContain("已选择 2 个文件");
      await findImportButton(wrapper).trigger("click");
      await flushPromises();

      // 聚合结果：4 人全部成功，只触发一次 imported（父视图无需改动）
      expect(wrapper.text()).toContain("批量导入完成（2/2 个文件）：成功 4");
      const emitted = wrapper.emitted("imported");
      expect(emitted).toHaveLength(1);
      const payload = emitted?.[0]?.[0] as { result: { imported: number }; targetClass: string | null };
      expect(payload.result.imported).toBe(4);
      expect(payload.targetClass).toBe("多文件测试班");
      for (const no of nos) {
        expect((await listStudents()).some((s) => s.student_no === no)).toBe(true);
      }
    } finally {
      await cleanupByNos(nos);
    }
  });
});
