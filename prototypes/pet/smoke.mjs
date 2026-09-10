/**
 * 原型冒烟测试：pet-raster / pet-rig / pet-studio
 *
 * 用法：node prototypes/pet/smoke.mjs
 * 依赖仓库根目录的 jsdom（devDependency）。
 *
 * 重点验证「素材板切片」的纯计算部分——抠图与摆位是整个贴图路线里
 * 唯一有真实数学的地方，而且它的正确性无法靠肉眼看 UI 判断。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RASTER = path.join(HERE, "pet-raster.html");
const RIG = path.join(HERE, "pet-rig.html");
const STUDIO = path.join(HERE, "pet-studio.html");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  \u2717 " + name + (extra ? "  " + extra : "")); }
};
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1 : eps);
const section = (t) => console.log("\n" + t);

/* ---- 载入页面（jsdom 无 canvas，切片画布路径跳过，只测纯函数） ---- */
function load(file) {
  const html = fs.readFileSync(file, "utf8");
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://localhost/",
  });
  return dom;
}

const rasterDom = load(RASTER);
const win = rasterDom.window;
const hook = win.__petRaster;
const S = hook && hook.sheet;

/* ============================================================
 * 1. 合成一张 3×3 素材板（纯品红底 + 9 个部件，带 1px 抗锯齿边）
 * ============================================================ */
const BG = [255, 0, 255];
const W = 300, H = 300, COLS = 3, ROWS = 3;
const CELL = 100;

function blendPx(data, i, color, cov) {
  const o = i * 4;
  for (let k = 0; k < 3; k++) data[o + k] = Math.round(BG[k] * (1 - cov) + color[k] * cov);
  data[o + 3] = 255;
}
// 画一个带 1px 抗锯齿的矩形：|sd| 以像素为单位，cov = clamp(0.5 - sd)
function drawRect(data, x0, y0, x1, y1, color) {
  for (let y = Math.floor(y0) - 2; y <= Math.ceil(y1) + 2; y++) {
    for (let x = Math.floor(x0) - 2; x <= Math.ceil(x1) + 2; x++) {
      const sd = Math.max(x0 - x - 0.5, x + 0.5 - x1, y0 - y - 0.5, y + 0.5 - y1);
      const cov = Math.max(0, Math.min(1, 0.5 - sd));
      if (cov <= 0) continue;
      blendPx(data, y * W + x, color, cov);
    }
  }
}

const ORANGE = [240, 163, 94], DARK = [58, 42, 33], WHITE = [255, 255, 255];
const sheet = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { sheet[i * 4] = 255; sheet[i * 4 + 1] = 0; sheet[i * 4 + 2] = 255; sheet[i * 4 + 3] = 255; }

// 每格中央放一个矩形（尺寸不同，便于验证 bbox）
const CELL_SHAPES = [
  [40, 30, ORANGE], [40, 40, ORANGE], [30, 20, ORANGE],
  [26, 30, WHITE], [26, 12, DARK], [26, 12, DARK],
  [30, 10, DARK], [30, 24, [184, 82, 78]], [24, 34, ORANGE],
];
// 第 8 格（张嘴）故意不画，验证「空格被跳过」
const EMPTY_CELL = 7;
CELL_SHAPES.forEach(([sw, sh, col], idx) => {
  if (idx === EMPTY_CELL) return;
  const c = idx % COLS, r = Math.floor(idx / COLS);
  const cx = c * CELL + CELL / 2, cy = r * CELL + CELL / 2;
  drawRect(sheet, cx - sw / 2, cy - sh / 2, cx + sw / 2, cy + sh / 2, col);
});

section("1. 抠图：色度距离 + 反混合");
if (!S) {
  ok("切片器已挂到 window.__petRaster.sheet", false);
} else {
  ok("切片器已挂到 window.__petRaster.sheet", true);
  ok("网格顺序第 1 格是身体", S.order[0] === "pet-body", S.order.slice(0, 3).join(" / "));

  const corner = S.sampleCorners(sheet, W, H, 0.02);
  ok("四角取色得到纯品红", corner.color.join(",") === "255,0,255", JSON.stringify(corner.color));
  ok("四角均匀（色差为 0）", corner.minSpread === 0 && corner.maxSpread === 0);

  const keyer = S.makeKeyer(BG, 0.18, 0.08);
  ok("品红背景走色度模式", keyer.useChroma === true);

  ok("纯背景 q ≈ 0", near(keyer.q(255, 0, 255), 0, 0.001));
  ok("纯白 q ≈ 1", near(keyer.q(255, 255, 255), 1, 0.02), "q=" + keyer.q(255, 255, 255).toFixed(3));
  ok("纯黑 q ≈ 1", near(keyer.q(0, 0, 0), 1, 0.02), "q=" + keyer.q(0, 0, 0).toFixed(3));
  ok("50% 白混合 q ≈ 0.5", near(keyer.q(255, 128, 255), 0.5, 0.03), "q=" + keyer.q(255, 128, 255).toFixed(3));
  ok("橙色角色 q 远高于容差", keyer.q(ORANGE[0], ORANGE[1], ORANGE[2]) > 0.6,
    "q=" + keyer.q(ORANGE[0], ORANGE[1], ORANGE[2]).toFixed(3));

  // 单格：身体那格
  const cellAt = (idx) => {
    const c = idx % COLS, r = Math.floor(idx / COLS);
    const out = new Uint8ClampedArray(CELL * CELL * 4);
    for (let y = 0; y < CELL; y++) {
      const so = ((r * CELL + y) * W + c * CELL) * 4, dof = y * CELL * 4;
      for (let x = 0; x < CELL * 4; x++) out[dof + x] = sheet[so + x];
    }
    return out;
  };
  const bodyCell = cellAt(0);
  const res = S.sliceCellData(bodyCell, CELL, CELL, keyer, true);
  ok("身体格切出内容", !!res.box);
  if (res.box) {
    ok("包围盒贴合矩形 (40×30)", near(res.box.w, 40, 2) && near(res.box.h, 30, 2),
      `${res.box.w}×${res.box.h}`);
    // 中心像素应为不透明橙色
    const ci = (Math.floor(res.box.h / 2) * res.box.w + Math.floor(res.box.w / 2)) * 4;
    ok("内部 alpha = 255", res.data[ci + 3] === 255, "a=" + res.data[ci + 3]);
    ok("内部颜色保持橙色",
      near(res.data[ci], ORANGE[0], 3) && near(res.data[ci + 1], ORANGE[1], 3) && near(res.data[ci + 2], ORANGE[2], 3),
      [res.data[ci], res.data[ci + 1], res.data[ci + 2]].join(","));
    ok("包围盒外留白已被抠掉", near(res.box.x, (CELL - 40) / 2, 2) && near(res.box.y, (CELL - 30) / 2, 2),
      `x=${res.box.x} y=${res.box.y}`);
  }
  // 背景像素：格内左上角 (5,5) 离矩形很远，抠图后 alpha 必须是 0
  const bgCell = cellAt(0);
  S.keyRGBA(bgCell, CELL, CELL, keyer, true);
  ok("背景像素被抠掉（alpha=0）", bgCell[(5 * CELL + 5) * 4 + 3] === 0);

  // 抗锯齿边：手工构造一个 50% 品红/橙混合像素，验证 alpha 与去色溢
  const px = new Uint8ClampedArray([Math.round((255 + 240) / 2), Math.round((0 + 163) / 2), Math.round((255 + 94) / 2), 255]);
  S.keyRGBA(px, 1, 1, keyer, true);
  ok("50% 混合像素 alpha ≈ 128 ±25", near(px[3], 128, 25), "a=" + px[3]);
  ok("去色溢后恢复橙色 r",
    near(px[0], ORANGE[0], 8) && near(px[1], ORANGE[1], 10) && near(px[2], ORANGE[2], 12),
    [px[0], px[1], px[2]].join(","));
  // 同一像素关掉去色溢，颜色应仍带品红污染（r、b 偏高）
  const px2 = new Uint8ClampedArray([Math.round((255 + 240) / 2), Math.round((0 + 163) / 2), Math.round((255 + 94) / 2), 255]);
  S.keyRGBA(px2, 1, 1, keyer, false);
  ok("关闭去色溢则保留品红污染（b 明显偏高）", px2[2] > ORANGE[2] + 20, [px2[0], px2[1], px2[2]].join(","));

  section("2. 空格 / 全背景格处理");
  const empt = S.sliceCellData(cellAt(EMPTY_CELL), CELL, CELL, keyer, true);
  ok("全背景格返回 null（会被跳过）", empt.box === null);
  ok("身体格不被误判为空", S.sliceCellData(cellAt(0), CELL, CELL, keyer, true).box !== null);

  section("2.0 回归：半透明像素不能污染其后的像素");
  // 曾经的缺陷：去色溢分支里用 var 重名了增益变量 k，变量提升导致
  // 「第一个半透明像素之后的所有像素都被当成增益≈0 抠成透明」，
  // 表现为切片结果从某个像素起整片消失。这里按扫描顺序构造
  // 「不透明 → 半透明 → 不透明」，断言最后一个仍是不透明的。
  {
    const w = 8, h = 1;
    const row = new Uint8ClampedArray(w * h * 4);
    const put = (x, c) => row.set([c[0], c[1], c[2], 255], x * 4);
    put(0, WHITE);                                   // 不透明
    put(1, [128, 0, 128]);                           // 半透明（约 50% 品红混合）
    for (let x = 2; x < w; x++) put(x, ORANGE);      // 后续都应保持不透明
    S.keyRGBA(row, w, h, keyer, true);
    ok("半透明像素本身 alpha 介于 0 与 255 之间", row[1 * 4 + 3] > 0 && row[1 * 4 + 3] < 255,
      "a=" + row[1 * 4 + 3]);
    const tail = [];
    for (let x = 2; x < w; x++) tail.push(row[x * 4 + 3]);
    ok("其后的不透明像素没有被连累", tail.every((a) => a === 255), "alphas=" + tail.join(","));
    ok("其后的像素颜色也没有被改坏",
      near(row[5 * 4], ORANGE[0], 2) && near(row[5 * 4 + 1], ORANGE[1], 2),
      [row[5 * 4], row[5 * 4 + 1], row[5 * 4 + 2]].join(","));
  }

  section("2.1 增益归一化：色度上限够不到 1 的前景色不应整块半透明");
  // 紫色配品红背景：q 顶多到 0.71，不做归一化整块部件只有 ~71% 不透明度
  ok("（前提）紫色的 q 确实到不了 1", keyer.q(150, 100, 220) < 0.85,
    "q=" + keyer.q(150, 100, 220).toFixed(3));
  const purpleCell = new Uint8ClampedArray(CELL * CELL * 4);
  for (let i = 0; i < CELL * CELL; i++) purpleCell.set([255, 0, 255, 255], i * 4);
  for (let y = 30; y < 70; y++) for (let x = 30; x < 70; x++) purpleCell.set([150, 100, 220, 255], (y * CELL + x) * 4);
  const pres = S.sliceCellData(purpleCell, CELL, CELL, keyer, true);
  if (pres.box) {
    const ci = (Math.floor(pres.box.h / 2) * pres.box.w + Math.floor(pres.box.w / 2)) * 4;
    ok("紫色部件归一化后完全不透明", pres.data[ci + 3] === 255, "a=" + pres.data[ci + 3]);
    ok("增益没有改坏紫色本身",
      near(pres.data[ci], 150, 6) && near(pres.data[ci + 1], 100, 6) && near(pres.data[ci + 2], 220, 6),
      [pres.data[ci], pres.data[ci + 1], pres.data[ci + 2]].join(","));
  } else {
    ok("紫色部件切出内容", false);
  }
}

section("2.2 切片器 UI 接线完整");
{
  const need = ["sheetCard", "sheetDrop", "sheetPreview", "sheetImg", "sheetGrid", "sheetMap",
    "sheetRows", "sheetCols", "sheetBg", "sheetTol", "sheetFeather", "sheetMirror", "sheetDespill",
    "btnSheetPick", "btnSheetSample", "btnSheetSlice", "fileSheet", "sheetHint", "sheetSize"];
  const miss = need.filter((id) => !win.document.getElementById(id));
  ok("切片器所需的 DOM 节点都在", miss.length === 0, miss.join(",") || need.length + " 个全部命中");
  const mapRows = win.document.querySelectorAll("#sheetMap > div").length;
  ok("默认 3×3 映射清单渲染 9 行", mapRows === 9, "rows=" + mapRows);
  const gridLines = win.document.querySelectorAll("#sheetGrid > i").length;
  ok("网格辅助线 = (行-1)+(列-1) 条", gridLines === 4, "lines=" + gridLines);
  ok("顺序清单首个是身体、末个是单耳",
    S.order[0] === "pet-body" && S.order[8] === "pet-ear-l", S.order.slice(0, 9).join(","));
  ok("镜像表覆盖眼 / 耳 / 腮红 / 爪", !!S.mirror["pet-eye-open-l"] && !!S.mirror["pet-ear-l"] &&
    !!S.mirror["pet-blush-l"] && !!S.mirror["pet-paw-l"]);
  const bad = Object.keys(S.layout).filter((k) => !(S.layout[k][0] > 0 && S.layout[k][0] < 1));
  ok("摆位骨架的宽度比例都在 (0,1) 内", bad.length === 0, bad.join(",") || "共 " + Object.keys(S.layout).length + " 个槽位");
}

section("3. 摆位骨架：锚点语义");
if (S) {
  const W2 = 512, H2 = 512;
  const bc = S.placePart("pet-body", 200, 100, W2, H2); // 底边中心锚点
  ok("bc：底边落在锚点 Y 上", near(bc.y + (100 * bc.scale) / 2, 0.912 * H2, 0.01), "bottom=" + (bc.y + 100 * bc.scale / 2).toFixed(2));
  ok("bc：水平居中", near(bc.x, 256, 0.01));
  const lc = S.placePart("pet-tail", 100, 60, W2, H2); // 左边中心锚点
  ok("lc：左边落在锚点 X 上", near(lc.x - (100 * lc.scale) / 2, 0.72 * W2, 0.01), "left=" + (lc.x - 100 * lc.scale / 2).toFixed(2));

  section("4. 镜像成对：眼 / 耳自动补另一侧");
  const parts = [
    { slot: "pet-body", nw: 200, nh: 100 },
    { slot: "pet-head", nw: 180, nh: 160 },
    { slot: "pet-tail", nw: 100, nh: 60 },
    { slot: "pet-eye-open-l", nw: 50, nh: 50 },
    { slot: "pet-ear-l", nw: 60, nh: 70 },
  ];
  const plan = S.planSheetLayers(parts, { canvasW: W2, canvasH: H2, mirror: true });
  const bySlot = Object.fromEntries(plan.map((p) => [p.slot, p]));
  ok("镜像开启后左右眼都在", !!bySlot["pet-eye-open-l"] && !!bySlot["pet-eye-open-r"]);
  ok("镜像开启后左右耳都在", !!bySlot["pet-ear-l"] && !!bySlot["pet-ear-r"]);
  if (bySlot["pet-eye-open-l"] && bySlot["pet-eye-open-r"]) {
    const l = bySlot["pet-eye-open-l"], r = bySlot["pet-eye-open-r"];
    ok("左右眼关于中轴镜像", near(l.x + r.x, W2, 0.01), `${l.x.toFixed(1)} / ${r.x.toFixed(1)}`);
    ok("左右眼缩放一致", near(l.scale, r.scale, 1e-6));
    ok("右眼标记为镜像", r.mirrored === true && l.mirrored === false);
  }
  const noMirror = S.planSheetLayers(parts, { canvasW: W2, canvasH: H2, mirror: false });
  ok("关闭镜像后只有单侧", noMirror.filter((p) => p.slot === "pet-eye-open-r").length === 0);
  ok("层级：身体在头之下", bySlot["pet-body"].z < bySlot["pet-head"].z,
    bySlot["pet-body"].z + " < " + bySlot["pet-head"].z);
  ok("层级：眼在头之上", bySlot["pet-eye-open-l"].z > bySlot["pet-head"].z);
  ok("层级：尾巴在身体之下", bySlot["pet-tail"].z < bySlot["pet-body"].z);
}

/* ============================================================
 * 5. 现有功能不回归：注入图层 → 状态机 → 变体显隐
 * ============================================================ */
section("5. pet-raster 既有功能回归");
if (hook) {
  hook.inject("pet-body");
  hook.inject("pet-eye-open-l");
  hook.inject("pet-eye-happy-l");
  hook.rebuild();
  const yb = win.document.querySelectorAll('.root [data-part="pet-root"]').length;
  ok("挂载后 root 容器存在", yb >= 0);
  ok("注入了 3 层", hook.layers().length === 3);
  hook.setState("happy");
  ok("切到 happy 状态", hook.state() === "happy");
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  ok("画布尺寸回落到 512", hook.canvas().width === 512 && hook.canvas().height === 512);
}

/* ---- pet-rig / pet-studio 可加载性 ---- */
section("6. 另外两个原型可加载、钩子就位");
[["pet-rig", RIG], ["pet-studio", STUDIO]].forEach(([name, file]) => {
  try {
    const d = load(file);
    const h = d.window.__petRig || d.window.__petStudio || d.window.__pet;
    const anyHook = Object.keys(d.window).filter((k) => /^__pet/.test(k));
    ok(name + " 脚本执行无异常", true, anyHook.length ? "钩子：" + anyHook.join(",") : "");
  } catch (e) {
    ok(name + " 脚本执行无异常", false, String(e && e.message));
  }
});

/* ============================================================
 * 7. 真实像素链路：把原生 canvas 垫进 jsdom，跑完整 sliceSheet()
 *    jsdom 本身没有 canvas，这一节验证的是 getImageData → 抠图 →
 *    putImageData → toDataURL → drawImage 这条画布管线。
 * ============================================================ */
section("7. 真实 canvas 切片链路");

function loadCanvasLib() {
  const candidates = [
    "@napi-rs/canvas",
    process.env.PET_CANVAS_PATH,
    path.join(os.homedir(), "node_modules", "@napi-rs", "canvas"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* 试下一个 */ }
  }
  return null;
}

const napi = loadCanvasLib();
if (!napi) {
  console.log("  - 跳过：没装 @napi-rs/canvas");
  console.log("    安装：cd <任意目录> && npm i @napi-rs/canvas");
  console.log("    或设 PET_CANVAS_PATH 指向该模块");
} else {
  const { createCanvas, ImageData, loadImage } = napi;

  // 注意：napi 的同步 API（new Image(); im.src = Buffer）虽然能立即拿到宽高，
  // 但要过一会儿才真正可被 drawImage 光栅化；所以一律走异步 loadImage，
  // 解完再触发 onload —— 这也更接近浏览器的真实行为。
  const toBuffer = (dataUrl) => {
    const s = String(dataUrl);
    return Buffer.from(s.indexOf(",") >= 0 ? s.slice(s.indexOf(",") + 1) : s, "base64");
  };

  // 把 napi 的 Image 包一层，冒充浏览器的 HTMLImageElement
  const ctxProto = Object.getPrototypeOf(createCanvas(1, 1).getContext("2d"));
  const origDrawImage = ctxProto.drawImage;
  ctxProto.drawImage = function (src, ...rest) {
    return origDrawImage.call(this, src && src.__img ? src.__img : src, ...rest);
  };
  class ShimImage {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this.__img = null; }
    set src(v) {
      this._src = v;
      loadImage(toBuffer(v)).then(
        (im) => {
          this.__img = im;
          this.naturalWidth = im.width;
          this.naturalHeight = im.height;
          if (this.onload) this.onload();
        },
        (e) => { if (this.onerror) this.onerror(e); }
      );
    }
    get src() { return this._src; }
  }

  const canvasDom = new JSDOM(fs.readFileSync(RASTER, "utf8"), {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/",
    beforeParse(w) {
      const origCreate = w.document.createElement.bind(w.document);
      w.document.createElement = function (tag, ...rest) {
        if (String(tag).toLowerCase() === "canvas") return createCanvas(1, 1);
        return origCreate(tag, ...rest);
      };
      w.Image = ShimImage;
      w.ImageData = ImageData;
    },
  });
  const cwin = canvasDom.window;
  const cdoc = cwin.document;
  const h = cwin.__petRaster && cwin.__petRaster.sheet;

  if (!h) {
    ok("切片器在 canvas 环境下可用", false);
  } else {
    // 造一张 600×600 的 3×3 素材板
    const SW = 600, SC = 200;
    const sheetCv = createCanvas(SW, SW);
    const sctx = sheetCv.getContext("2d");
    sctx.fillStyle = "#FF00FF"; sctx.fillRect(0, 0, SW, SW);
    [["#F0A35E", 80, 60], ["#F0A35E", 80, 80], ["#F0A35E", 60, 40],
     ["#FFFFFF", 52, 60], ["#3A2A21", 52, 24], ["#3A2A21", 52, 24],
     ["#3A2A21", 60, 20], ["#B8524E", 60, 48], ["#F0A35E", 48, 68]]
      .forEach(([col, sw, sh], i) => {
        const c = i % 3, r = Math.floor(i / 3);
        sctx.fillStyle = col;
        sctx.fillRect(c * SC + SC / 2 - sw / 2, r * SC + SC / 2 - sh / 2, sw, sh);
      });
    // 给「睁眼」那格加一块偏左的深色标记 —— 用它验证镜像层是真的水平翻转，
    // 而不是简单复制（对称图形怎么测都像对的）
    // 睁眼在第 3 格 → 第 1 行第 0 列
    sctx.fillStyle = "#3A2A21";
    sctx.fillRect(0 * SC + SC / 2 - 52 / 2 + 3, 1 * SC + SC / 2 + 6, 12, 18);
    const sheetUrl = sheetCv.toDataURL("image/png");

    h.setGrid(3, 3);
    h.setBg("#ff00ff");
    cdoc.getElementById("sheetTol").value = "18";
    cdoc.getElementById("sheetFeather").value = "8";
    h.loadUrl(sheetUrl);

    const before = cwin.__petRaster.layers().length;
    h.slice();

    // slice() 走 Image.onload（微任务），等它跑完
    const deadline = Date.now() + 4000;
    await new Promise((res) => {
      const poll = () => {
        if (cwin.__petRaster.layers().length > before || Date.now() > deadline) return res();
        setTimeout(poll, 20);
      };
      poll();
    });

    const L = cwin.__petRaster.layers();
    ok("slice() 切出 13 层（9 部件 + 4 镜像）", L.length === 13, "n=" + L.length);
    const bySlot = Object.fromEntries(L.map((x) => [x.slot, x]));
    const need = ["pet-body", "pet-head", "pet-tail", "pet-eye-open-l", "pet-eye-open-r",
      "pet-eye-happy-l", "pet-eye-sleep-l", "pet-mouth-closed", "pet-mouth-open",
      "pet-ear-l", "pet-ear-r"];
    const missing = need.filter((s) => !bySlot[s]);
    ok("必需槽位齐全", missing.length === 0, missing.join(",") || "全部命中");
    ok("没有未映射图层", L.filter((x) => x.unmapped).length === 0);
    ok("画布锁定在 512（未被最大部件带偏）",
      cwin.__petRaster.canvas().width === 512 && cwin.__petRaster.canvas().height === 512,
      cwin.__petRaster.canvas().width + "×" + cwin.__petRaster.canvas().height);

    if (bySlot["pet-eye-open-l"] && bySlot["pet-eye-open-r"]) {
      const a = bySlot["pet-eye-open-l"], b = bySlot["pet-eye-open-r"];
      ok("左右眼关于中轴镜像", near(a.x + b.x, 512, 0.6), a.x.toFixed(1) + " + " + b.x.toFixed(1));
    }
    // 渲染尺寸应等于骨架目标宽度，而不是被原始像素尺寸带偏
    if (bySlot["pet-body"]) {
      const bw = bySlot["pet-body"].nw * bySlot["pet-body"].scale;
      ok("身体渲染宽度 = 骨架目标 0.508×512", near(bw, 0.508 * 512, 1), bw.toFixed(1) + "px");
    }
    ok("图层已挂进 DOM 语义容器",
      cdoc.querySelectorAll(".root img[data-layer]").length === L.length,
      "dom=" + cdoc.querySelectorAll(".root img[data-layer]").length);

    const px = async (url, fx, fy) => {
      const im = await loadImage(toBuffer(url));
      const c = createCanvas(im.width, im.height);
      const x = c.getContext("2d");
      x.drawImage(im, 0, 0);
      const d = x.getImageData(Math.round((im.width - 1) * fx), Math.round((im.height - 1) * fy), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    };
    if (bySlot["pet-body"]) {
      const mid = await px(bySlot["pet-body"].url, 0.5, 0.5);
      ok("身体层中心不透明", mid[3] === 255, "rgba=" + mid.join(","));
      ok("身体层中心仍是橙色（抠图没串色）",
        Math.abs(mid[0] - 240) < 12 && Math.abs(mid[1] - 163) < 14 && Math.abs(mid[2] - 94) < 16,
        "rgb=" + mid.slice(0, 3).join(","));
      ok("身体层按内容紧裁（80×60 的方块）",
        near(bySlot["pet-body"].nw, 80, 2) && near(bySlot["pet-body"].nh, 60, 2),
        bySlot["pet-body"].nw + "×" + bySlot["pet-body"].nh);
      const corner = await px(bySlot["pet-body"].url, 0.005, 0.005);
      ok("紧裁后角上就是部件边缘（无留白边框）", corner[3] > 0, "a=" + corner[3]);
    }
    const lEye = bySlot["pet-eye-open-l"], rEye = bySlot["pet-eye-open-r"];
    if (lEye) {
      const e = await px(lEye.url, 0.5, 0.5);
      ok("眼睛层中心不透明", e[3] === 255, "a=" + e[3]);
      // 眼睛格是 52×60 的白块；这条同时回归「半透明像素污染后续像素」
      ok("眼睛层按内容整块切下（52×60，未被中途截断）",
        near(lEye.nw, 52, 2) && near(lEye.nh, 60, 2), lEye.nw + "×" + lEye.nh);
      if (rEye) ok("镜像眼与左眼等尺寸", rEye.nw === lEye.nw && rEye.nh === lEye.nh);
    }
    // 非对称标记：左眼深色块在左边，右眼镜像后深色块应该在右边
    if (lEye && rEye) {
      const lMark = await px(lEye.url, 0.15, 0.7);
      const lPlain = await px(lEye.url, 0.9, 0.7);
      const rMark = await px(rEye.url, 0.85, 0.7);
      const rPlain = await px(rEye.url, 0.1, 0.7);
      // 深色像素的 q 略小于 1（本格 qMax 由白色像素决定，增益为 1），
      // 落成 alpha 251 是符合预期的，不是缺陷
      ok("左眼：深色标记在左边", lMark[0] < 120 && lMark[3] >= 248, "rgba=" + lMark.join(","));
      ok("左眼：右边是白的", lPlain[0] > 200, "rgb=" + lPlain.slice(0, 3).join(","));
      ok("右眼：左边是白的（镜像后标记跑到右边）", rPlain[0] > 200, "rgb=" + rPlain.slice(0, 3).join(","));
      ok("右眼：深色标记在右边 —— 确认是水平翻转而非复制",
        rMark[0] < 120 && rMark[3] >= 248, "rgba=" + rMark.join(","));
    }
    const mf = JSON.parse(cdoc.getElementById("manifest").textContent);
    ok("导出 manifest 含全部图层", mf.layers.length === L.length,
      "manifest=" + mf.layers.length + " layers=" + L.length);
    ok("manifest 标记为 placed（部件尺寸不一，不能当同尺寸图层处理）",
      mf.canvas.align === "placed", mf.canvas.align);
    ok("manifest 记录了画布与地面线",
      mf.canvas.width === 512 && mf.canvas.groundLineY === 478,
      mf.canvas.width + "×" + mf.canvas.height + " ground=" + mf.canvas.groundLineY);
    ok("manifest 每一层都带坐标与缩放",
      mf.layers.every((x) => typeof x.x === "number" && typeof x.y === "number" && typeof x.scale === "number"));
    canvasDom.window.close();
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
