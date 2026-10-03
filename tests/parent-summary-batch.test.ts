import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import type { AgentMessage } from "../src/agent/types";

// 每次请求时的线程快照（requestParentSummary 会原地 push 助手回复，活引用会污染断言）
const { summarySnapshots, REPLY_TEXT } = vi.hoisted(() => ({
  summarySnapshots: [] as { messages: { role: string; content: string }[] }[],
  REPLY_TEXT: "本月表现稳定，作业按时完成。",
}));

// AI 视为已配置；db 的 isTauri 仅对「对话框」为真（内部读写仍走内存库）
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

import ParentSummaryBatchDialog from "../src/components/ParentSummaryBatchDialog.vue";
import {
  closeParentSummaryBatch,
  consumeParentSummaryPanel,
  openParentSummaryBatch,
  useParentSummaryBatch,
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

const batchState = useParentSummaryBatch();
const panelPreset = useParentSummaryPanel();
const CLASS = "测试七班";
let wu = 0; // 有表现记录
let bare = 0; // 无表现记录

beforeAll(async () => {
  wu = await createStudent({ ...emptyStudentInput(), name: "吴同学", grade_class: CLASS, student_no: "T4001" });
  bare = await createStudent({ ...emptyStudentInput(), name: "柏同学", grade_class: CLASS, student_no: "T4002" });
  const dim = (await listBehaviorDimensions())[0];
  await addBehaviorRecord({
    student_id: wu,
    dimension_id: dim.id,
    dimension_name_snap: dim.name,
    category_snap: dim.category,
    type: "praise",
    comment: "上课积极发言",
    recorded_date: "2026-09-10",
  });
  await addBehaviorRecord({
    student_id: wu,
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
  closeParentSummaryBatch();
  consumeParentSummaryPanel();
});

/** 已挂载的实例：对话框监听全局单例状态，测试结束必须卸载，否则 watcher 跨测试叠加 */
const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

async function openBatch(preset: { className?: string; range?: ParentSummaryRangePreset; autoStart?: boolean } = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/students/:id", name: "student-detail", component: { render: () => null } }],
  });
  await router.push("/students/0");
  await router.isReady();
  const w = mount(ParentSummaryBatchDialog, { global: { plugins: [router] } });
  mounted.push(w);
  openParentSummaryBatch({ className: CLASS, ...preset });
  await flushPromises();
  await flushPromises();
  return { w, router };
}

/** 在名单里点选指定学生（名单按 updated_at 倒序，不能假设顺序） */
async function selectStudent(w: VueWrapper, name: string) {
  const item = w.findAll("[data-test='summary-student-list'] button").find((b) => b.text().includes(name));
  expect(item, `名单里应有 ${name}`).toBeTruthy();
  await item!.trigger("click");
  await flushPromises();
}

describe("ParentSummaryBatchDialog.vue", () => {
  it("loads the class roster and shows per-student evaluation material", async () => {
    const { w } = await openBatch();
    expect(w.findAll("[data-test='summary-student-list'] button")).toHaveLength(2);
    await selectStudent(w, "吴同学");
    expect(w.find("[data-test='material-line']").text()).toContain("共 2 条");
    expect(w.find("[data-test='material-line']").text()).toContain("表扬 1");
    expect(w.find("[data-test='ai-unavailable']").exists()).toBe(false);
  });

  it("auto-generates the whole class sequentially and applies with the ai source", async () => {
    const { w } = await openBatch({ autoStart: true });
    const items = w.findAll("[data-test='summary-student-list'] button");
    expect(items.map((i) => i.text()).join("")).toContain("已生成");
    expect(summarySnapshots).toHaveLength(2);

    // 逐个查看并应用：AI 生成且未手改 → 落档案记 ai
    await selectStudent(w, "柏同学");
    await w.find("[data-test='apply-summary-btn']").trigger("click");
    await flushPromises();
    const comment = await getTermComment(bare, currentSemester());
    expect(comment?.content).toBe(REPLY_TEXT);
    expect(comment?.source).toBe("ai");
    expect(w.find("[data-test='apply-summary-btn']").text()).toContain("已应用");
  });

  it("applies a manually written summary to the profile term comment", async () => {
    const { w } = await openBatch();
    await selectStudent(w, "吴同学");
    await w.find("[data-test='summary-current']").setValue("这段时间进步明显。");
    await w.find("[data-test='apply-summary-btn']").trigger("click");
    await flushPromises();
    expect(vi.mocked(confirmAction)).toHaveBeenCalledTimes(1);
    const comment = await getTermComment(wu, currentSemester());
    expect(comment?.content).toBe("这段时间进步明显。");
    // 手动填写的总结落档案记 manual
    expect(comment?.source).toBe("manual");
  });

  it("links to the student profile for chat-style refinement", async () => {
    const { w, router } = await openBatch();
    await selectStudent(w, "吴同学");
    await w.find("[data-test='go-profile-btn']").trigger("click");
    await flushPromises();
    // 跳到学生档案并留下「家校沟通」页签定位预设（不自动生成）
    expect(router.currentRoute.value.name).toBe("student-detail");
    expect(router.currentRoute.value.params.id).toBe(String(wu));
    expect(batchState.open).toBe(false);
    expect(panelPreset.studentId).toBe(wu);
    expect(panelPreset.autoStart).toBe(false);
  });

  it("shows a retry for failed students and retries on a clean thread", async () => {
    // mockResolvedValueOnce 完全替换实现（不记快照）：第一个学生失败，第二个走默认实现
    vi.mocked(requestParentSummary).mockResolvedValueOnce(null);
    const { w } = await openBatch({ autoStart: true });
    await flushPromises();
    // 名单里一个失败一个已生成
    const texts = w.findAll("[data-test='summary-student-list'] button").map((i) => i.text()).join("");
    expect(texts).toContain("失败");
    expect(texts).toContain("已生成");

    // 选中失败的学生重试：线程已回滚，按当前素材重建
    const failedItem = w
      .findAll("[data-test='summary-student-list'] button")
      .find((b) => b.text().includes("失败"));
    await failedItem!.trigger("click");
    await flushPromises();
    expect(w.find("[data-test='summary-error']").exists()).toBe(true);
    await w.find("[data-test='retry-btn']").trigger("click");
    await flushPromises();
    expect(summarySnapshots).toHaveLength(2);
    expect(summarySnapshots[1].messages).toHaveLength(1);
    expect((w.find("[data-test='summary-current']").element as HTMLTextAreaElement).value).toBe(REPLY_TEXT);
  });

  it("clears drafts when the time range changes", async () => {
    const { w } = await openBatch();
    await selectStudent(w, "吴同学");
    await w.find("[data-test='summary-current']").setValue("草稿");
    const current = () => w.find("[data-test='summary-current']");
    expect((current().element as HTMLTextAreaElement).value).toBe("草稿");
    const select = w.find("[data-test='summary-semester-select']");
    const options = select.findAll("option");
    expect(options.length).toBeGreaterThan(1);
    await select.setValue(options[1].element.value);
    await flushPromises();
    expect((current().element as HTMLTextAreaElement).value).toBe("");
  });
});
