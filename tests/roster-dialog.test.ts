import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ImportRosterDialog from "../src/components/ImportRosterDialog.vue";
import { deleteStudent, listStudents } from "../src/lib/db";

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
});
