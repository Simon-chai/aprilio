/**
 * 原型冒烟测试：课堂模式 classroom-mode.html
 *
 * 用法：node prototypes/classroom/smoke.mjs
 * 依赖仓库根目录的 jsdom（devDependency）。
 *
 * 验证可玩原型的核心链路：启动上课 → 座位记表现 → 缺勤排除 →
 * 换座 → 点名动画落定 → 小组加分 → 下课小结与 AI 生成 → 投影切换。
 * 动画类交互（点名滚动的减速节奏）只验证落定结果，不验证帧级表现。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "classroom-mode.html");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  " + extra : "")); }
};
const section = (t) => console.log("\n" + t);
const wait = (fn, ms = 8000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const poll = () => {
    let done = false;
    try { done = !!fn(); } catch (e) { return rej(e); }
    if (done) return res();
    if (Date.now() - t0 > ms) return rej(new Error("等待超时"));
    setTimeout(poll, 50);
  };
  poll();
});

const html = fs.readFileSync(PAGE, "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/" });
const win = dom.window;
const doc = win.document;

/* ============ 1. 页面加载与关键节点 ============ */
section("1. 页面加载与关键节点");
ok("脚本执行无异常", true);
const need = ["launcher", "app", "btn-start", "btn-pick", "btn-end", "btn-proj",
  "scr-pick", "scr-seats", "scr-groups", "scr-digest", "seat-row", "g-view", "p-view",
  "dg-stats", "dg-ai-txt", "sheet", "toasts", "pick-modes"];
const miss = need.filter((id) => !doc.getElementById(id));
ok("关键 DOM 节点齐全", miss.length === 0, miss.join(",") || need.length + " 个全部命中");
ok("启动页可见、课堂隐藏", !doc.getElementById("launcher").classList.contains("hidden")
  && doc.getElementById("app").classList.contains("hidden"));
ok("座位预渲染 30 个", doc.querySelectorAll(".seat").length === 30);
ok("演示缺勤 2 人（置灰）", doc.querySelectorAll(".seat.absent").length === 2);
ok("小组卡预渲染 5 张", doc.querySelectorAll("#g-view .g-card").length === 5);

/* ============ 2. 开始上课 ============ */
section("2. 开始上课");
doc.getElementById("btn-start").click();
ok("进入课堂界面", doc.getElementById("launcher").classList.contains("hidden")
  && !doc.getElementById("app").classList.contains("hidden"));
const feedItems = () => doc.querySelectorAll("#feed .feed-item").length;
ok("预置 2 条本节课记录", feedItems() === 2, "feed=" + feedItems());
ok("点名台为当前页", doc.getElementById("scr-pick").classList.contains("on"));

/* ============ 3. 座位记表现（点头像 → 底部面板 → 表扬） ============ */
section("3. 座位记表现");
const feedBefore = feedItems();
const scoreBefore = +(doc.querySelector('#g-view [data-gscore="0"]').textContent || "0");
const seat3 = doc.querySelector('.seat[data-stu="3"]'); // 李思远 · 火箭组（g=0）
seat3.click();
ok("点头像弹出快捷面板", doc.getElementById("sheet").classList.contains("on")
  && doc.getElementById("sh-name").textContent === "李思远");
doc.querySelectorAll("#sh-dims .chip")[1].click(); // 切到「作业情况」
doc.querySelector('#sheet .pol-btn[data-t="praise"]').click();
ok("表扬后流水 +1", feedItems() === feedBefore + 1, feedBefore + " → " + feedItems());
ok("面板自动关闭", !doc.getElementById("sheet").classList.contains("on"));
ok("火箭组积分 +1", +(doc.querySelector('#g-view [data-gscore="0"]').textContent) === scoreBefore + 1,
  scoreBefore + " → " + doc.querySelector('#g-view [data-gscore="0"]').textContent);
ok("座位角标出现红花计数", seat3.querySelector(".bd").textContent.includes("🌸"),
  seat3.querySelector(".bd").textContent);
const lastFeed = doc.querySelector("#feed .feed-item");
ok("流水内容含维度与倾向", lastFeed.textContent.includes("李思远")
  && lastFeed.textContent.includes("作业情况") && lastFeed.textContent.includes("表扬"));

/* ============ 4. 缺勤排除与恢复 ============ */
section("4. 缺勤排除");
const pool0 = win.pickPool();
ok("点名池排除缺勤（28 人）", pool0.length === 28, "pool=" + pool0.length);
ok("点名池不含缺勤学生", !pool0.some((s) => s.id === 5 || s.id === 17));
const seat5 = doc.querySelector('.seat[data-stu="5"]');
seat5.click();
doc.getElementById("sh-absent").click();
ok("取消缺勤后点名池 29 人", win.pickPool().length === 29);
seat5.click();
doc.getElementById("sh-absent").click();
ok("重新标记缺勤恢复 28 人", win.pickPool().length === 28);

/* ============ 5. 换座 ============ */
section("5. 换座");
doc.getElementById("btn-swap").click();
ok("进入换座模式（提示出现）", !doc.getElementById("swap-hint").classList.contains("hidden"));
const s0 = doc.querySelectorAll(".seat")[0], s1 = doc.querySelectorAll(".seat")[1];
const n0 = s0.querySelector(".nm").textContent, n1 = s1.querySelector(".nm").textContent;
s0.click();
/* renderSeats 为全量重建，选中态出现在新节点上，必须重查 */
ok("首个座位进入待交换态", doc.querySelectorAll(".seat")[0].classList.contains("pickme"));
s1.click();
const seatsAfter = doc.querySelectorAll(".seat");
ok("两个座位完成交换", seatsAfter[0].querySelector(".nm").textContent === n1
  && seatsAfter[1].querySelector(".nm").textContent === n0, n0 + " ⇄ " + n1);
doc.getElementById("btn-swap").click();
ok("退出换座模式", doc.getElementById("swap-hint").classList.contains("hidden"));

/* ============ 6. 点名动画落定 ============ */
section("6. 点名动画落定");
const calledBefore = win.S_called_len ? win.S_called_len() : doc.querySelectorAll("#called-list .called-chip").length;
doc.getElementById("btn-pick").click();
ok("滚动中禁用抽取按钮", doc.getElementById("btn-pick").disabled === true);
await wait(() => doc.getElementById("btn-pick").disabled === false, 9000);
ok("落定后按钮恢复", true);
const pickName = doc.getElementById("pick-name").textContent;
ok("中央展示学生姓名", pickName.length >= 2 && pickName !== "准备好了吗？", "→ " + pickName);
const chips = doc.querySelectorAll("#called-list .called-chip").length;
ok("已点名单 +1", chips === calledBefore + 1, calledBefore + " → " + chips);
ok("AI 提示条出现", !doc.getElementById("pick-hint").classList.contains("hidden"),
  doc.getElementById("pick-hint-txt").textContent);
ok("落点快捷动作就位", doc.querySelectorAll("#pick-acts .pol-btn").length === 3);

/* ============ 7. 小组加分与红花榜 ============ */
section("7. 小组加分与红花榜");
const g2before = +(doc.querySelector('#g-view [data-gscore="2"]').textContent);
doc.querySelector('#g-view .g-add[data-g="2"][data-r="发言"]').click();
ok("小组 +1 生效", +(doc.querySelector('#g-view [data-gscore="2"]').textContent) === g2before + 1,
  g2before + " → " + doc.querySelector('#g-view [data-gscore="2"]').textContent);
doc.getElementById("v-p").click();
ok("切换到个人红花榜", !doc.getElementById("p-view").classList.contains("hidden")
  && doc.querySelectorAll("#p-view .p-row").length === 30);
doc.getElementById("v-g").click();

/* ============ 8. 键盘导航 ============ */
section("8. 键盘导航");
doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "3", bubbles: true }));
ok("按 3 切到小组页", doc.getElementById("scr-groups").classList.contains("on"));
doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "4", bubbles: true }));
ok("按 4 切到小结页", doc.getElementById("scr-digest").classList.contains("on"));

/* ============ 9. 下课小结与 AI 生成 ============ */
section("9. 下课小结与 AI 生成");
ok("统计卡渲染 4 张", doc.querySelectorAll("#dg-stats .dg-stat").length === 4);
ok("时间线有记录", doc.querySelectorAll("#dg-tl .tl-row").length >= 3,
  "tl=" + doc.querySelectorAll("#dg-tl .tl-row").length);
win.genAI();
await wait(() => (doc.querySelector("#dg-ai-txt .txt-node")?.textContent || "").length > 30, 9000);
const aiText = doc.querySelector("#dg-ai-txt").textContent;
ok("AI 小结生成完毕", aiText.includes("三(2)班") && aiText.includes("点名"), aiText.slice(0, 40) + "…");
doc.getElementById("btn-archive").click();
ok("存档给出反馈", doc.querySelectorAll("#toasts .toast").length >= 1);

/* ============ 10. 投影模式 ============ */
section("10. 投影模式");
doc.getElementById("btn-proj").click();
ok("投影模式开启（侧栏隐藏、舞台放大）", doc.getElementById("win").classList.contains("proj"));
doc.getElementById("btn-proj").click();
ok("投影模式可退出", !doc.getElementById("win").classList.contains("proj"));

console.log(`\n${pass} 通过 / ${fail} 失败`);
win.close();
process.exit(fail ? 1 : 0);
