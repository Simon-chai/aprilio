/**
 * 数据与设置页的页面动作（声明式注册，default export 即被容器装载）。
 *
 * clear-all-data 是首个「写操作」样例：dangerous = true，
 * ui_action 工具会先走容器确认门（模型须征得用户同意后传 confirm:true）。
 */
import { clearAll } from "../../lib/db";
import { definePageAction } from "../define";

export default definePageAction({
  page: "settings",
  key: "clear-all-data",
  label: "清空全部数据",
  description: "清空全部学生与图片记录（SQLite 或内存演示数据），不可撤销。",
  dangerous: true,
  run: async () => {
    await clearAll();
    return { ok: true, summary: "已清空全部学生与图片记录。" };
  },
});
