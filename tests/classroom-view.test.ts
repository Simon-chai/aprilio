import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import ClassroomView from "../src/views/ClassroomView.vue";
import { confirmAction } from "../src/composables/useConfirm";
import { emitPageAction } from "../src/agent/page-action-bus";
import { startLesson } from "../src/classroom/session";
import {
  clearAll,
  createClass,
  createStudent,
  getLessonSession,
  getProfile,
  listLessonSessions,
  saveProfile,
} from "../src/lib/db";
import { localDateStr } from "../src/lib/format";
import { emptyStudentInput } from "../src/types";
import type { Profile } from "../src/types";

/**
 * 课堂模式（/classroom）三态一页的视图契约：
 * - 启动页：恢复横幅 / 节次命中卡 / 手动开临时课堂（period = null）
 * - 舞台：活动 Tab 来自会话组合快照 + 动态面板组件
 * - 下课：confirmAction 确认门 → finishLesson 落库 → 小结弹层（AI 版/数据版）
 * - Agent 页面动作 classroom/end-lesson 直达小结弹层
 * vitest 下 isTauri() = false → db 走内存演示态（项目既有双态模式），断言点全部落在 data-test 契约上。
 */

// 下课确认走全局命令式弹层：mock 掉宿主交互，用例内控制确认/取消分支
vi.mock("../src/composables/useConfirm", () => ({ confirmAction: vi.fn() }));

enableAutoUnmount(afterEach);

const CLASS = "课堂视图测试班";
const SUBJECT = "数学";
const confirmMock = vi.mocked(confirmAction);

let originalProfile: Profile;

/** 挂载视图：memory history；query 带 session 时模拟 Agent / 入口带参直达 */
async function mountView(query: Record<string, string> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: { template: "<div>home</div>" } },
      { path: "/classroom", name: "classroom", component: ClassroomView },
    ],
  });
  await router.push({ name: "classroom", query });
  await router.isReady();
  const wrapper = mount(ClassroomView, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(async () => {
  await clearAll();
  originalProfile = await getProfile();
  confirmMock.mockReset();
  await createClass(CLASS);
  await createStudent({ ...emptyStudentInput(), name: "张三", grade_class: CLASS });
});

afterEach(async () => {
  await clearAll();
  // clearAll 不重置内存态 profile（memProfile 在 store 之外），手工还原
  await saveProfile(originalProfile);
});

describe("ClassroomView 启动页", () => {
  it("无课表命中 / 无 live 会话：给出节次命中说明与手动开课入口，班级预选第一个班", async () => {
    const { wrapper } = await mountView();

    expect(wrapper.find('[data-test="classroom-start"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="classroom-stage"]').exists()).toBe(false);
    // 未排课 → 无节次命中卡；无 live 会话 → 无恢复横幅
    expect(wrapper.find('[data-test="detected-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="resume-banner"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("当前时间不在你的课表时段内");
    // 手动开课：班级下拉预选第一个班
    expect((wrapper.get('[data-test="manual-class"]').element as HTMLSelectElement).value).toBe(
      CLASS,
    );
  });

  it("手动开临时课堂（period = null）：进舞台渲染活动 Tab 与面板，会话按今天落库", async () => {
    const { wrapper } = await mountView();

    await wrapper.get('[data-test="manual-subject"]').setValue(SUBJECT);
    await wrapper.get('[data-test="start-manual"]').trigger("click");
    await flushPromises();

    const stage = wrapper.get('[data-test="classroom-stage"]');
    expect(stage.text()).toContain(CLASS);
    expect(stage.text()).toContain("临时课堂");
    // 活动 Tab 来自默认组合快照（picker / seating / group-race / digest）
    expect(wrapper.get('[data-test="activity-tabs"]').findAll("button").length).toBe(4);
    expect(wrapper.find('[data-test="activity-tab-picker"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="activity-panel"]').exists()).toBe(true);

    const sessions = await listLessonSessions({ class_name: CLASS });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].period).toBeNull();
    expect(sessions[0].subject).toBe(SUBJECT);
    expect(sessions[0].lesson_date).toBe(localDateStr());
    expect(sessions[0].status).toBe("live");
  });
});

describe("ClassroomView 恢复与直达", () => {
  it("崩溃恢复：live 会话挂在恢复横幅上，点恢复进舞台且不新建会话", async () => {
    const started = await startLesson({
      class_name: CLASS,
      subject: SUBJECT,
      lesson_date: localDateStr(),
      period: 3,
    });
    const { wrapper } = await mountView();

    expect(wrapper.find('[data-test="resume-banner"]').exists()).toBe(true);
    const items = wrapper.findAll('[data-test="resume-item"]');
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain(CLASS);
    expect(items[0].text()).toContain("第 3 节");

    await wrapper.get('[data-test="resume-btn"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="classroom-stage"]').exists()).toBe(true);
    // started_at 有值 → 显示已上课时长
    expect(wrapper.find('[data-test="classroom-elapsed"]').exists()).toBe(true);
    // 恢复即直达既有会话：不新建
    expect(await listLessonSessions({ class_name: CLASS })).toHaveLength(1);
    expect((await getLessonSession(started.session.id))?.status).toBe("live");
  });

  it("query.session 直达：跳过启动页直接进舞台（Agent / 入口带参共用路径）", async () => {
    const started = await startLesson({
      class_name: CLASS,
      subject: SUBJECT,
      lesson_date: localDateStr(),
      period: 3,
    });
    const { wrapper } = await mountView({ session: String(started.session.id) });

    expect(wrapper.find('[data-test="classroom-start"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="classroom-stage"]').text()).toContain("第 3 节");
    expect(wrapper.find('[data-test="activity-tab-picker"]').exists()).toBe(true);
  });
});

describe("ClassroomView 下课", () => {
  it("下课确认通过：生成数据版小结、落库 ended 并弹出小结层", async () => {
    const started = await startLesson({
      class_name: CLASS,
      subject: SUBJECT,
      lesson_date: localDateStr(),
      period: 3,
    });
    const { wrapper } = await mountView({ session: String(started.session.id) });
    confirmMock.mockResolvedValue(true);

    await wrapper.get('[data-test="classroom-end"]').trigger("click");
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({ title: "下课", confirmText: "下课" });
    expect(wrapper.get('[data-test="end-dialog"]').text()).toContain("数据版");

    const saved = await getLessonSession(started.session.id);
    expect(saved?.status).toBe("ended");
    expect(saved?.digest_source).toBe("data");
    expect(saved?.digest_md).toContain("课堂小结");
  });

  it("下课确认取消：不落库、会话保持 live、无小结层", async () => {
    const started = await startLesson({
      class_name: CLASS,
      subject: SUBJECT,
      lesson_date: localDateStr(),
      period: 3,
    });
    const { wrapper } = await mountView({ session: String(started.session.id) });
    confirmMock.mockResolvedValue(false);

    await wrapper.get('[data-test="classroom-end"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="end-dialog"]').exists()).toBe(false);
    expect((await getLessonSession(started.session.id))?.status).toBe("live");
  });
});

describe("ClassroomView Agent 页面动作", () => {
  it("classroom/end-lesson（本会话）：展示 Agent 生成的 AI 版小结", async () => {
    const started = await startLesson({
      class_name: CLASS,
      subject: SUBJECT,
      lesson_date: localDateStr(),
      period: 3,
    });
    const { wrapper } = await mountView({ session: String(started.session.id) });

    const hit = emitPageAction("classroom/end-lesson", {
      session_id: started.session.id,
      digest_md: "# 课堂小结\n\nAI 版内容",
      digest_source: "ai",
      stats: {
        picks: [],
        pick_coverage: 0,
        praise_count: 0,
        improve_count: 0,
        absent: [],
        groups: [],
        silent: [],
        duration_min: 0,
      },
    });
    await flushPromises();

    expect(hit).toBe(true);
    expect(wrapper.get('[data-test="end-dialog"]').text()).toContain("AI 版");
    expect(wrapper.get('[data-test="end-dialog"]').text()).toContain("AI 版内容");
  });

  it("classroom/end-lesson（别的会话）：本页不动作，不弹小结", async () => {
    const started = await startLesson({
      class_name: CLASS,
      subject: SUBJECT,
      lesson_date: localDateStr(),
      period: 3,
    });
    const { wrapper } = await mountView({ session: String(started.session.id) });

    emitPageAction("classroom/end-lesson", { session_id: started.session.id + 999 });
    await flushPromises();

    expect(wrapper.find('[data-test="end-dialog"]').exists()).toBe(false);
  });
});