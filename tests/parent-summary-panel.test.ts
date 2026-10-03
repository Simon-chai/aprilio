import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { AgentMessage } from "../src/agent/types";

// 每次请求时的线程快照（requestParentSummary 会原地 push 助手回复，活引用会污染断言）
const { summarySnapshots, REPLY_TEXT } = vi.hoisted(() => ({
  summarySnapshots: [] as { messages: { role: string; content: string }[] }[],
  REPLY_TEXT: "本月表现稳定，作业按时完成。",
}));

// AI 视为已配置；db 的 isTauri 仅对「面板」为真（内部读写仍走内存库）
vi.mock("../src/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai")>();
  return { ...actual, isAiConfigured: () => true, loadAiConfig: (() => ({})) as never };
});
vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { ...actual, isTauri: () => true };
});
vi.mock("../src/composables/useConfirm", () => ({
  confirmAction: vi.fn(async () => true),
}));
// 只替换模型请求：buildSummaryMessages 等保持真实实现
vi.mock("../src/lib/parent-summary-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/parent-summary-ai")>();
  return {
    ...actual,
    requestParentSummary: vi.fn(async (messages: AgentMessage[]) => {
      summarySnapshots.push({ messages: messages.map((m) => ({ role: m.role, content: m.content })) });
      messages.push({ role: "assistant", content: REPLY_TEXT });
      return REPLY_TEXT;
    }),
  };
});

import ParentSummaryPanel from "../src/components/ParentSummaryPanel.vue";
import {
  consumeParentSummaryPanel,
  openParentSummaryPanel,
  useParentSummaryPanel,
} from "../src/composables/useParentSummary";
import type { ParentSummaryRangePreset } from "../src/composables/useParentSummary";
import { confirmAction } from "../src/composables/useConfirm";
import {
  addBehaviorRecord,
  createStudent,
  getTermComment,
  listBehaviorDimensions,
} from "../src/lib/db";
import { requestParentSummary } from "../src/lib/parent-summary-ai";
import { currentSemester } from "../src/lib/timetable";
import { emptyStudentInput } from "../src/types";

const panelPreset = useParentSummaryPanel();
const CLASS = "测试六班";
let ding = 0; // 有表现记录
let bare = 0; // 无表现记录

beforeAll(async () => {
  ding = await createStudent({ ...emptyStudentInput(), name: "丁同学", grade_class: CLASS, student_no: "T3001" });
  bare = await createStudent({ ...emptyStudentInput(), name: "白同学", grade_class: CLASS, student_no: "T3002" });
  const dim = (await listBehaviorDimensions())[0];
  await addBehaviorRecord({
    student_id: ding,
    dimension_id: dim.id,
    dimension_name_snap: dim.name,
    category_snap: dim.category,
    type: "praise",
    comment: "上课积极发言",
    recorded_date: "2026-09-10",
  });
  await addBehaviorRecord({
    student_id: ding,
    dimension_id: dim.id,
    dimension_name_snap: dim.name,
    category_snap: dim.category,
    type: "improve",
    comment: "作业偶有潦草",
    recorded_date: "2026-09-20",
  });
});

beforeEach(() => {
  // mockReset 会清掉 mockResolvedValueOnce 等一次性队列并恢复出厂实现，防跨测试泄漏
  vi.mocked(requestParentSummary).mockReset();
  vi.mocked(confirmAction).mockClear();
  summarySnapshots.length = 0;
  consumeParentSummaryPanel();
});

/** 已挂载的实例：面板监听全局单例预设，测试结束必须卸载 */
const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

async function mountPanel(
  studentId: number,
  studentName: string,
  opts: { range?: ParentSummaryRangePreset; autoStart?: boolean; requirement?: string } = {}
) {
  if (opts.range || opts.autoStart || opts.requirement) {
    openParentSummaryPanel({
      studentId,
      range: opts.range,
      autoStart: opts.autoStart ?? false,
      requirement: opts.requirement,
    });
  }
  const w = mount(ParentSummaryPanel, {
    props: { studentId, studentName, gradeClass: CLASS, semester: currentSemester() },
  });
  mounted.push(w);
  await flushPromises();
  await flushPromises();
  return w;
}

describe("ParentSummaryPanel.vue", () => {
  it("shows per-student material and the empty state", async () => {
    const w = await mountPanel(ding, "丁同学");
    expect(w.find("[data-test='material-line']").text()).toContain("共 2 条");
    expect(w.find("[data-test='material-line']").text()).toContain("表扬 1");
    expect(w.find("[data-test='thread-empty']").exists()).toBe(true);
    expect(w.find("[data-test='summary-manual-input']").exists()).toBe(true);
  });

  it("consumes the agent preset and auto-generates with the preset semester", async () => {
    const w = await mountPanel(ding, "丁同学", {
      range: { mode: "semester", semester: "2025-2026-2" },
      autoStart: true,
    });
    // 预设没带要求：只有助手首版（可编辑），无要求气泡
    expect(w.find("[data-test='requirement-bubble-0']").exists()).toBe(false);
    expect(w.find("[data-test='summary-current']").exists()).toBe(true);
    // 预设里的学期覆盖了视图传入的当前学期
    const select = w.find("[data-test='summary-semester-select']");
    expect((select.element as HTMLSelectElement).value).toBe("2025-2026-2");
    // 预设已消费：不会在下次进入时重复生成
    expect(panelPreset.studentId).toBeNull();
  });

  it("auto-generates with the requirement as the first turn", async () => {
    const w = await mountPanel(ding, "丁同学", { autoStart: true, requirement: "多鼓励" });
    expect(w.find("[data-test='requirement-bubble-0']").text()).toBe("多鼓励");
    expect((w.find("[data-test='summary-current']").element as HTMLTextAreaElement).value).toBe(REPLY_TEXT);
    expect(summarySnapshots).toHaveLength(1);
    const first = summarySnapshots[0].messages[0].content;
    expect(first).toContain("【学生】丁同学");
    expect(first).toContain("【个性化要求】多鼓励");
  });

  it("regenerates on the same thread when a follow-up requirement is added", async () => {
    const w = await mountPanel(ding, "丁同学");
    await w.find("[data-test='generate-btn']").trigger("click");
    await flushPromises();
    await w.find("[data-test='requirement-input']").setValue("语气再温和一些");
    await w.find("[data-test='regenerate-btn']").trigger("click");
    await flushPromises();
    expect(summarySnapshots).toHaveLength(2);
    // 第二次请求携带完整线程：素材消息 + 第一版回复 + 新要求
    const lastThread = summarySnapshots[1].messages;
    expect(lastThread).toHaveLength(3);
    expect(lastThread[1].content).toBe(REPLY_TEXT);
    expect(lastThread[2].content).toBe("语气再温和一些");
    expect(w.find("[data-test='requirement-bubble-1']").text()).toBe("语气再温和一些");
  });

  it("applies a manually written summary to the profile term comment", async () => {
    const w = await mountPanel(ding, "丁同学");
    await w.find("[data-test='summary-manual-input']").setValue("这段时间进步明显。");
    await w.find("[data-test='apply-summary-btn']").trigger("click");
    await flushPromises();
    expect(vi.mocked(confirmAction)).toHaveBeenCalledTimes(1);
    const comment = await getTermComment(ding, currentSemester());
    expect(comment?.content).toBe("这段时间进步明显。");
    // 手动填写的总结落档案记 manual
    expect(comment?.source).toBe("manual");
    expect(w.find("[data-test='apply-summary-btn']").text()).toContain("已应用");
  });

  it("applies an unedited AI version with the ai source", async () => {
    const w = await mountPanel(bare, "白同学");
    await w.find("[data-test='generate-btn']").trigger("click");
    await flushPromises();
    await w.find("[data-test='apply-summary-btn']").trigger("click");
    await flushPromises();
    const comment = await getTermComment(bare, currentSemester());
    expect(comment?.content).toBe(REPLY_TEXT);
    expect(comment?.source).toBe("ai");
  });

  it("falls back to manual input when generation fails and retries on a clean thread", async () => {
    // mockResolvedValueOnce 完全替换实现（不记快照）：失败的那次调用不会进入 summarySnapshots
    vi.mocked(requestParentSummary).mockResolvedValueOnce(null);
    const w = await mountPanel(bare, "白同学", { autoStart: true });
    expect(w.find("[data-test='summary-error']").exists()).toBe(true);
    expect(w.find("[data-test='summary-manual-input']").exists()).toBe(true);

    await w.find("[data-test='requirement-input']").setValue("再来一版");
    await w.find("[data-test='regenerate-btn']").trigger("click");
    await flushPromises();
    // 失败已回滚线程为空 → 重试按当前素材 + 新要求重建，不残留半截对话
    expect(summarySnapshots).toHaveLength(1);
    const retryThread = summarySnapshots[0].messages;
    expect(retryThread).toHaveLength(1);
    expect(retryThread[0].content).toContain("再来一版");
    expect((w.find("[data-test='summary-current']").element as HTMLTextAreaElement).value).toBe(REPLY_TEXT);
  });

  it("resets the draft when the student changes", async () => {
    const w = await mountPanel(ding, "丁同学");
    await w.find("[data-test='generate-btn']").trigger("click");
    await flushPromises();
    expect(w.find("[data-test='summary-current']").exists()).toBe(true);

    await w.setProps({ studentId: bare, studentName: "白同学" });
    await flushPromises();
    expect(w.find("[data-test='thread-empty']").exists()).toBe(true);
    expect(w.find("[data-test='material-line']").text()).toContain("共 0 条");
    expect((w.find("[data-test='summary-manual-input']").element as HTMLTextAreaElement).value).toBe("");
  });
});
