import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

/** 假模型：按提示词分流回答——姓名列识别 / 文件名班级推断 */
const fakeLlm = vi.hoisted(() => ({
  async chat(req: { system: string }) {
    if (req.system.includes("班级")) {
      return {
        content: '{"class_name": "四8班", "confidence": 0.9, "reason": "文件名含班级"}',
        toolCalls: [],
      };
    }
    return { content: '{"column": 1, "confidence": 0.9, "reason": "表头为姓名"}', toolCalls: [] };
  },
}));

vi.mock("../src/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai")>();
  return {
    ...actual,
    loadAiConfig: () => ({
      provider: "openai",
      model: "test",
      apiKey: "test-key",
      baseUrl: "",
      temperature: 0,
      systemPrompt: "",
    }),
  };
});

vi.mock("../src/agent/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent/providers")>();
  return { ...actual, createLlm: () => fakeLlm };
});

import ImportRosterDialog from "../src/components/ImportRosterDialog.vue";
import { deleteClass, deleteStudent, listStudents } from "../src/lib/db";

type Loader = { loadText: (text: string, label?: string) => Promise<void> };

const CLASS = "四8班";
const TEST_NOS = ["9000097", "9000098"];

async function cleanup() {
  const set = new Set(TEST_NOS);
  for (const s of await listStudents()) {
    if (set.has(s.student_no)) await deleteStudent(s.id);
  }
  try {
    await deleteClass(CLASS);
  } catch {
    /* 班级可能不存在 */
  }
}

describe("ImportRosterDialog 文件名班级识别", () => {
  it("无班级列时按文件名识别班级并归入该班（不再自动建未命名班级）", async () => {
    await cleanup();
    try {
      const wrapper = mount(ImportRosterDialog, { props: { open: true } });
      await (wrapper.vm as unknown as Loader).loadText(
        "姓名,学号\n文件甲,9000097\n文件乙,9000098",
        "四8班学生详细信息_模拟数据.csv",
      );

      expect(wrapper.text()).toContain("已按文件名识别班级");
      expect(wrapper.text()).toContain(CLASS);
      expect(wrapper.text()).not.toContain("自动新建一个班级");

      const button = wrapper.findAll("button").find((b) => b.text().includes("开始导入"));
      expect(button, "导入按钮应存在").toBeDefined();
      await button!.trigger("click");
      await flushPromises();

      expect(wrapper.text()).toContain("导入完成：成功 2");
      const students = (await listStudents()).filter((s) => TEST_NOS.includes(s.student_no));
      expect(students.map((s) => s.grade_class)).toEqual([CLASS, CLASS]);
    } finally {
      await cleanup();
    }
  });
});
