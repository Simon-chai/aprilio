/**
 * 首页的页面动作（声明式注册，default export 即被容器装载）。
 *
 * open-pomodoro：番茄钟是首页内的沉浸层交互（非独立页面），navigate 的
 * NAV_TARGETS 不覆盖，走 ui_action → 总线广播 → HomeView 挂监听接住。
 * Agent 可从任意页面发起，当前不在首页时先跳回首页再投递。
 */
import { nextTick } from "vue";
import { emitPageAction } from "../page-action-bus";
import { definePageAction } from "../define";

export default definePageAction({
  page: "home",
  key: "open-pomodoro",
  label: "打开番茄钟",
  description:
    "进入首页的番茄钟沉浸层（专注 25 / 短休 5 / 长休 15 分钟倒计时）。当前不在首页时会先跳回首页。",
  run: async (ctx) => {
    if (ctx.router.currentRoute.value.name !== "home") {
      await ctx.router.push({ name: "home" });
      await nextTick(); // 等首页视图挂载完成，总线监听才就位
    }
    const delivered = emitPageAction("home/open-pomodoro");
    if (!delivered) {
      return { ok: false, summary: "", error: "首页视图未挂载，无法打开番茄钟，请稍后重试。" };
    }
    return { ok: true, summary: "已进入番茄钟沉浸层（专注 25 分钟），空格开始/暂停，Esc 退出。" };
  },
});
