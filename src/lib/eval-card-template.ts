/**
 * 学生评价卡片 HTML 模板（A 版「暖阳成长卡」，spec：docs/EVAL_CARD.md）。
 * 产出完全自包含的 HTML：系统字体、纯 CSS（无 canvas/SVG 图表、无外链资源），
 * 保证 foreignObject 光栅化（html-to-png.ts）稳定，也方便后续按版本迭代样式。
 * 所有动态文本一律 escapeHtml，学生姓名等用户输入不可直插。
 */
import type { EvalCardChip, EvalCardView } from "./eval-card";

const CHIP_EMOJI: Record<EvalCardChip["key"], string> = {
  study: "📚",
  behavior: "🤝",
  homework: "✍️",
};

function esc(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 姓名平铺水印的 data-URI SVG（斜向 -18°，低透明度，重复铺满卡片） */
export function watermarkStyleValue(name: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="170">` +
    `<text x="16" y="98" transform="rotate(-18 120 85)" font-size="22" font-weight="600" ` +
    `letter-spacing="2" fill="#1d1d1f" fill-opacity="0.08" ` +
    `font-family="PingFang SC, Microsoft YaHei, sans-serif">${esc(name)}</text></svg>`;
  return `url('data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}')`;
}

function starsHtml(stars: number): string {
  let html = "";
  for (let i = 1; i <= 5; i += 1) {
    html += `<span class="${i <= stars ? "on" : "off"}">★</span>`;
  }
  return html;
}

/** 组装卡片完整 HTML。comment 用对话框编辑值（空则隐藏寄语区） */
export function buildEvalCardHtml(
  view: EvalCardView,
  opts: { watermark: boolean; comment: string }
): string {
  const comment = opts.comment.trim();

  const chipsHtml = view.chips.length
    ? `<div class="chips">${view.chips
        .map(
          (c) =>
            `<div class="chip">${CHIP_EMOJI[c.key]} ${esc(c.label)}<b>${esc(c.value)}</b></div>`
        )
        .join("")}</div>`
    : "";

  const scoreHtml = view.score
    ? `<div class="sec-title">📊 ${esc(view.score.title)}<span class="sub">${esc(view.score.subtitle)}</span></div>
  ${view.score.subjects
    .map(
      (s) =>
        `<div class="score-row"><div class="subj">${esc(s.subject)}</div><div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, s.score))}%"></div></div><div class="num">${esc(String(s.score))}</div></div>`
    )
    .join("")}
  ${
    view.score.rankNote
      ? `<div class="rank-note ${view.score.noteTone}">${
          view.score.noteTone === "up" ? "↑ " : view.score.noteTone === "down" ? "↓ " : ""
        }${esc(view.score.rankNote)}</div>`
      : ""
  }`
    : "";

  const highlightsHtml =
    view.tags.length || view.moments.length
      ? `<div class="sec-title">🌟 亮点时刻</div>
  ${view.tags.length ? `<div class="tags">${view.tags.map((t) => `<div class="tag">${esc(t)}</div>`).join("")}</div>` : ""}
  ${
    view.moments.length
      ? `<div class="tl">${view.moments
          .map(
            (m) =>
              `<div class="tl-item"><div class="dot"></div><div class="date">${esc(m.date)}</div><div class="txt">${esc(m.text)}</div></div>`
          )
          .join("")}</div>`
      : ""
  }`
      : "";

  const commentHtml = comment
    ? `<div class="sec-title">💬 老师想对你说</div>
  <div class="comment"><div class="q">“</div><p>${esc(comment)}</p></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>学生评价卡片</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { margin: 0; background: #ffffff; }
  .card {
    position: relative;
    width: 750px; min-height: 1240px;
    background: linear-gradient(180deg, #eef7f0 0%, #fdfefd 30%);
    padding: 28px;
    display: flex; flex-direction: column;
    font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    color: #1d1d1f;
  }
  /* 学生姓名平铺水印：盖在整卡上，透明度 8%，不影响阅读 */
  .wm {
    position: absolute; inset: 0; pointer-events: none;
    background-image: ${opts.watermark ? watermarkStyleValue(view.name) : "none"};
  }
  .card > *:not(.wm) { position: relative; }
  .banner {
    height: 196px; border-radius: 24px;
    background: linear-gradient(120deg, #2e9e57 0%, #6fc189 100%);
    padding: 28px 30px;
    display: flex; align-items: center; gap: 22px;
    color: #fff;
  }
  .avatar {
    width: 92px; height: 92px; border-radius: 50%;
    background: rgba(255, 255, 255, 0.92);
    display: flex; align-items: center; justify-content: center;
    font-size: 42px; font-weight: 700; color: #2e9e57;
    flex-shrink: 0;
  }
  .banner .name { font-size: 34px; font-weight: 700; letter-spacing: 1px; }
  .banner .meta { font-size: 19px; opacity: 0.92; margin-top: 8px; }
  .banner .stars { margin-left: auto; text-align: right; }
  .banner .stars .on { font-size: 26px; color: #ffe08a; letter-spacing: 4px; }
  .banner .stars .off { font-size: 26px; color: rgba(255, 255, 255, 0.38); letter-spacing: 4px; }
  .banner .stars .label { font-size: 15px; opacity: 0.9; margin-top: 6px; }
  .sec-title { font-size: 24px; font-weight: 700; margin: 26px 0 14px; }
  .sec-title .sub { font-size: 17px; font-weight: 400; color: #7a7a7a; margin-left: 12px; }
  .chips { display: flex; gap: 14px; margin-top: 22px; }
  .chip {
    flex: 1; background: #fff; border-radius: 999px;
    padding: 13px 0; text-align: center;
    font-size: 20px; color: #333;
    box-shadow: 0 2px 10px rgba(46, 158, 87, 0.08);
  }
  .chip b { font-size: 22px; color: #248a3d; margin-left: 6px; }
  .score-row { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
  .score-row .subj { width: 96px; font-size: 21px; color: #333; }
  .score-row .track { flex: 1; height: 14px; border-radius: 999px; background: #e8f2ea; overflow: hidden; }
  .score-row .fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #6fc189, #2e9e57); }
  .score-row .num { width: 56px; text-align: right; font-size: 25px; font-weight: 800; }
  .rank-note { font-size: 19px; color: #248a3d; margin-top: 2px; }
  .rank-note.down { color: #d97706; }
  .tags { display: flex; gap: 12px; flex-wrap: wrap; }
  .tag { background: #e8f5e9; color: #248a3d; border-radius: 999px; padding: 9px 18px; font-size: 19px; }
  .tl { margin-top: 16px; }
  .tl-item { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
  .tl-item .dot { width: 10px; height: 10px; border-radius: 50%; background: #248a3d; margin-top: 9px; flex-shrink: 0; }
  .tl-item .date { width: 62px; font-size: 17px; color: #7a7a7a; margin-top: 2px; flex-shrink: 0; }
  .tl-item .txt { font-size: 20px; color: #333; line-height: 1.5; }
  .comment { background: #f2faf4; border-radius: 18px; padding: 22px 24px; margin-top: 4px; position: relative; }
  .comment .q { position: absolute; top: 2px; left: 18px; font-size: 52px; color: #bfe3cb; font-weight: 700; line-height: 1; }
  .comment p { font-size: 21px; line-height: 1.78; color: #333; position: relative; }
  .footer { margin-top: auto; border-top: 1px solid #e0e8e2; padding-top: 18px; }
  .footer .row { display: flex; justify-content: space-between; align-items: baseline; }
  .footer .teacher { font-size: 20px; font-weight: 600; }
  .footer .date { font-size: 18px; color: #7a7a7a; }
  .footer .brand { text-align: center; font-size: 14px; color: #c2d3c6; margin-top: 14px; letter-spacing: 2px; }
</style>
</head>
<body>
<div class="card">
  ${opts.watermark ? `<div class="wm" aria-hidden="true"></div>` : ""}
  <div class="banner">
    <div class="avatar">${esc(view.avatarChar)}</div>
    <div>
      <div class="name">${esc(view.name)}</div>
      <div class="meta">${esc(view.className)} · ${esc(view.periodLabel)}</div>
    </div>
    <div class="stars">
      <div>${starsHtml(view.stars)}</div>
      <div class="label">本阶段综合评价 · ${esc(view.ratingLabel)}</div>
    </div>
  </div>
  ${chipsHtml}
  ${scoreHtml}
  ${highlightsHtml}
  ${commentHtml}
  <div class="footer">
    <div class="row">
      <div class="teacher">班主任 · ${esc(view.teacherName)}</div>
      <div class="date">${esc(view.dateLabel)}</div>
    </div>
    <div class="brand">APRILIO · 班级管理</div>
  </div>
</div>
</body>
</html>`;
}
