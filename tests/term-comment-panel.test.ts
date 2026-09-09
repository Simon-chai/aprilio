import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import TermCommentPanel from "../src/components/TermCommentPanel.vue";
import { createStudent, deleteStudent, getTermComment, listTermComments } from "../src/lib/db";
import type { StudentInput } from "../src/types";

const SEM = "2026-2027-1";

function input(name: string, no: string): StudentInput {
  return {
    name,
    gender: "男",
    birth_date: null,
    student_no: no,
    grade_class: "评语测试班",
    id_card: null,
    address: null,
    status: "active",
    note: null,
  };
}

let sid = 0;
afterEach(async () => {
  if (sid) await deleteStudent(sid);
  sid = 0;
});

describe("TermCommentPanel", () => {
  it("saves a comment and shows it in history when switching semester", async () => {
    sid = await createStudent(input("评语面板生", "TCP_001"));
    const wrapper = mount(TermCommentPanel, {
      props: {
        studentId: sid,
        studentName: "评语面板生",
        gradeClass: "评语测试班",
        semester: SEM,
        behaviors: [],
        examScores: [],
      },
    });
    await flushPromises();

    // 未配置 AI 时明确提示可手动填写
    expect(wrapper.get("[data-test='ai-unavailable']").text()).toContain("手动");

    await wrapper.get("[data-test='term-comment-input']").setValue("本学期进步明显");
    await wrapper.get("[data-test='save-comment-btn']").trigger("click");
    await flushPromises();

    expect((await getTermComment(sid, SEM))?.content).toBe("本学期进步明显");

    // 切到另一学期：本学期输入清空，历史里能看到旧评语
    await wrapper.setProps({ semester: "2025-2026-2" });
    await flushPromises();
    expect((await listTermComments(sid)).length).toBe(1);
    expect(wrapper.get("[data-test='term-comment-history']").text()).toContain("本学期进步明显");
    expect((wrapper.get("[data-test='term-comment-input']").element as HTMLTextAreaElement).value).toBe("");
  });
});
