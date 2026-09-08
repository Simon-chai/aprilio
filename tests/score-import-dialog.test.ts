import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ImportScoreDialog from "../src/components/ImportScoreDialog.vue";
import { deleteExam, deleteStudent, listExamsByClass, listStudents } from "../src/lib/db";

const SCORE_TEXT =
  "春晖小学2024级三年级（2）班2026年秋季期中考试成绩单\n" +
  "姓名,学号,语文,数学,总分\n" +
  "张小三,96001,90,85,175\n" +
  "李小红,96002,88,92,180";

const TEST_CLASS = "成绩导入对话框测试班";
const TEST_NOS = ["96001", "96002"];

type Loader = { loadText: (text: string, label?: string) => Promise<void> };

async function cleanupTestData() {
  for (const s of await listStudents()) {
    if (TEST_NOS.includes(s.student_no)) await deleteStudent(s.id);
  }
  for (const e of await listExamsByClass(TEST_CLASS)) await deleteExam(e.id);
}

describe("ImportScoreDialog", () => {
  it("识别成绩单后展示科目列与提取的考试名", async () => {
    const wrapper = mount(ImportScoreDialog, { props: { open: true } });
    await (wrapper.vm as unknown as Loader).loadText(SCORE_TEXT, "期中成绩单.csv");

    expect(wrapper.text()).toContain("共 2 行数据");
    expect(wrapper.text()).toContain("语文 ← 第3列「语文」");
    expect(wrapper.text()).toContain("数学 ← 第4列「数学」");
    expect(wrapper.text()).toContain("总分/排名等汇总列已忽略");
    // 考试名提取自标题行（剥掉「成绩单」后缀），回填到考试名输入框
    const examInput = wrapper.get('[data-test="exam-name-input"]').element as HTMLInputElement;
    expect(examInput.value).toBe("春晖小学2024级三年级（2）班2026年秋季期中考试");
  });

  it("姓名在第 1 列时点「开始导入」能正常导入（回归：0 起下标误当 1 起列号报「找不到姓名列「0」」）", async () => {
    await cleanupTestData();
    try {
      const wrapper = mount(ImportScoreDialog, {
        props: { open: true, presetClass: TEST_CLASS },
      });
      await (wrapper.vm as unknown as Loader).loadText(SCORE_TEXT, "期中成绩单.csv");

      const importBtn = wrapper.get('[data-test="score-import-btn"]');
      expect(importBtn.attributes("disabled")).toBeUndefined();
      await importBtn.trigger("click");
      await flushPromises();

      // 回归前：姓名列下标 0 被 resolveColumn 当 1 起列号 → -1 → 报「找不到姓名列「0」」
      expect(wrapper.text()).not.toContain("找不到姓名列");
      expect(wrapper.get('[data-test="score-import-result"]').text()).toContain(
        "导入完成：写入 4 条成绩",
      );
      expect(wrapper.emitted("imported")).toHaveLength(1);
    } finally {
      await cleanupTestData();
    }
  });
});
