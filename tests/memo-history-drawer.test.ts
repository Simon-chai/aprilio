import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MemoHistoryDrawer from "../src/components/MemoHistoryDrawer.vue";
import { addCalendarEvent } from "../src/lib/db";
import { ensureProfile, profile } from "../src/lib/profile";
import { DEFAULT_PROFILE } from "../src/types";

/**
 * 历史备忘抽屉：数据走 db.ts 的内存示例数据（非 Tauri）。
 * 示例事件以「今天」为基准生成，且模块级单例只种一次——
 * 统一把系统时间固定到 2026-09-09（周三），后续用例复用这份种子。
 */
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0));
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function openDrawer() {
  // ensureProfile 幂等且只在首次覆盖 profile，先初始化再设任教学科
  await ensureProfile();
  profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
  const wrapper = mount(MemoHistoryDrawer, { props: { open: false } });
  await wrapper.setProps({ open: true });
  await flushPromises();
  return wrapper;
}

function items(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('[data-test="memo-history-item"]');
}

function findItem(wrapper: ReturnType<typeof mount>, text: string) {
  return items(wrapper).find((i) => i.text().includes(text));
}

describe("MemoHistoryDrawer.vue", () => {
  it("lists memos grouped by date, newest first, with today marked", async () => {
    const wrapper = await openDrawer();

    // 演示事件分布在 5 个日期（09-12 / 09-11 / 09-10 / 09-09 / 09-07）
    const groups = wrapper.findAll('[data-test="memo-history-group"]');
    expect(groups).toHaveLength(5);
    expect(groups[0]!.text()).toContain("9/12 周六");
    expect(groups[0]!.text()).toContain("大课间彩排");

    const today = groups.find((g) => g.text().includes("（今天）"));
    expect(today?.text()).toContain("9/9 周三");
    expect(today?.text()).toContain("下午教研组会议");

    wrapper.unmount();
  });

  it("restores the lesson context of a memo from the timetable (subject + class)", async () => {
    await ensureProfile();
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    // 周三第 1 节：三年级二班与三年级一班都是语文 → 个人备忘还原出当时那节课
    await addCalendarEvent(null, "2026-09-09", "带三角板", "todo", 1);

    const wrapper = await openDrawer();
    const item = findItem(wrapper, "带三角板");
    expect(item).toBeDefined();
    const context = item!.get('[data-test="memo-history-context"]').text();
    expect(context).toContain("第1节");
    expect(context).toContain("语文");
    expect(context).toContain("三年级二班");
    expect(context).toContain("等 2 个班");

    wrapper.unmount();
  });

  it("shows 全天 for all-day events and 第N节 when that period has no lesson", async () => {
    const wrapper = await openDrawer();

    const allDay = findItem(wrapper, "下午教研组会议");
    expect(allDay?.get('[data-test="memo-history-context"]').text()).toBe("全天");
    // 周三第 4 节两个演示班都没有课 → 只还原到节次（标题超 8 字被截断，用前缀定位）
    const lesson = findItem(wrapper, "布置语文第 3");
    expect(lesson?.get('[data-test="memo-history-context"]').text()).toBe("第4节");

    wrapper.unmount();
  });

  it("filters by type pill and by keyword", async () => {
    const wrapper = await openDrawer();

    // 第 3 枚胶囊 = 考试
    await wrapper.findAll('[data-test="memo-history-type"]')[2]!.trigger("click");
    await flushPromises();
    expect(items(wrapper)).toHaveLength(1);
    expect(items(wrapper)[0]!.text()).toContain("数学第一单元测验");

    // 再点一次取消筛选
    await wrapper.findAll('[data-test="memo-history-type"]')[2]!.trigger("click");
    await flushPromises();
    expect(items(wrapper).length).toBeGreaterThan(1);

    // 关键词搜索
    await wrapper.get('[data-test="memo-history-search"]').setValue("回执");
    await flushPromises();
    expect(wrapper.text()).toContain("收秋游回执单");
    expect(wrapper.text()).not.toContain("班委开会");

    wrapper.unmount();
  });

  it("hides completed memos when 只看未完成 is on", async () => {
    const wrapper = await openDrawer();
    expect(wrapper.text()).toContain("班委开会");

    await wrapper.get('[data-test="memo-history-undone"]').setValue(true);
    await flushPromises();
    expect(wrapper.text()).not.toContain("班委开会");
    expect(wrapper.text()).toContain("收秋游回执单");

    wrapper.unmount();
  });

  it("toggles done and deletes a memo inline", async () => {
    const wrapper = await openDrawer();

    const item = findItem(wrapper, "大课间彩排")!;
    await item.get("button").trigger("click"); // 第一个按钮 = 完成勾选
    await flushPromises();
    expect(item.classes()).toContain("group");

    // 删除后条目消失
    const del = item.findAll("button").at(-1)!;
    await del.trigger("click");
    await flushPromises();
    expect(findItem(wrapper, "大课间彩排")).toBeUndefined();

    wrapper.unmount();
  });

  it("filters by time range: 近 90 天 drops older memos", async () => {
    await ensureProfile();
    await addCalendarEvent(null, "2020-01-01", "很久以前的备忘", "memo", null);

    const wrapper = await openDrawer();
    expect(wrapper.text()).toContain("很久以前的备忘");

    await wrapper.get('[data-test="memo-history-range-recent"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).not.toContain("很久以前的备忘");
    expect(wrapper.text()).toContain("收秋游回执单");

    wrapper.unmount();
  });
});
