/**
 * 提示词管理页 · 样稿共享数据与交互助手（仅供设计评审，不属于应用代码）。
 *
 * 模块内容全部来自 src/prompts/modules/*.prompt.ts 与 contracts.ts 的真实数据；
 * 仅为了演示「已自定义」状态，把其中 2 个模块标记为自定义。三个样稿页共用此文件。
 */

/* ---------------- 分组（同 src/prompts/groups.ts） ---------------- */

const GROUPS = [
  { id: "assistant", label: "智能助手", desc: "全站 AI 助手（右下角对话浮层）的主提示词" },
  { id: "content", label: "内容生成", desc: "评语、评价报告、课堂小结等成段文字的生成" },
  { id: "recognize", label: "信息识别", desc: "表格结构与标签语义的识别判定（多为 JSON 契约输出）" },
];

/* ---------------- 契约常量（同 src/prompts/contracts.ts） ---------------- */

const SCORE_SHEET_OUTPUT_SCHEMA =
  '{"name_column": 列号(从1起), "subjects": [{"column": 列号, "name": "科目名"}], ' +
  '"exam_name": "考试名或null", "exam_date": "YYYY-MM-DD或null", "confidence": 0到1的小数, ' +
  '"reason": "不超过20字的理由"}';
const ROSTER_NAME_COLUMN_OUTPUT_SCHEMA =
  '{"column": 列号(从1开始的数字), "confidence": 0到1的小数, "reason": "不超过20字的理由"}';
const ROSTER_CLASS_NAME_OUTPUT_SCHEMA =
  '{"class_name": "班级名或null", "confidence": 0到1的小数, "reason": "不超过20字的理由"}';

/* ---------------- 模块（同 src/prompts/modules/*.prompt.ts） ---------------- */

const MODULES = [
  {
    id: "assistant.agent",
    group: "assistant",
    label: "智能助手主提示词",
    desc: "右下角 AI 助手的人格、页面感知与工具使用准则。",
    note:
      "页面上下文与工具清单由程序在运行期注入：{当前页面}、{页面概况} 每轮随你切换页面更新。" +
      "改动工具使用准则前请确认对应的工具仍然存在（工具清单见 docs/AGENT.md）。",
    vars: [
      { name: "当前页面", desc: "用户当前所在页面（视图上报的快照优先，否则回落界面注册表）", sample: "「班级管理 · 三年级二班」" },
      { name: "页面概况", desc: "当前页面渲染概况；视图未上报时整行省略", sample: "在用班级 · 学生 10 人" },
      { name: "补充设定", desc: "设置页里为当前模型方案填写的补充设定；未填时整行省略", sample: "回答请简短" },
    ],
    default: [
      "你是 aprilio（本机学生档案应用）的内置智能助手，可以直接操作应用界面、查询本机数据、检索应用文档。",
      "用户当前所在页面：「{当前页面}」。",
      "当前页面渲染概况：{页面概况}",
      "工具使用准则：",
      "1. navigate：用户想打开、切换、返回某个界面时调用；打开班级详情/学生详情等实体页面时带上班级名或学生 ID，工具会查库校验后直达；跳转后用一句话确认即可。",
      "2. query_data：凡涉及学生、照片、成绩、数量统计的问题，必须先查询再回答，禁止编造数字；实体含 students / photos / stats / behaviors / exams（考试批次）/ scores（成绩明细）/ lessons（课堂会话与点名记录），做分析时可连续查询多个实体（如先用 exams 找到考试 ID，再用 scores 取明细）。",
      "3. find_docs：用户询问应用功能、操作方法、使用说明时调用；应用文档（含本助手能力说明）都在检索范围内。",
      "4. ui_action：执行页面按钮级动作时调用（课堂模式的开课 / 下课即 classroom/start、classroom/end-lesson 两个动作，开课可带 class_name 开临时课堂）；标记为写操作的动作，必须先说明影响并征得用户明确同意，才能带 confirm:true 调用。",
      "5. semantic_search：用户描述模糊、口语化的查找（如「之前记过的爱踢球的孩子」）时使用，精确条件查询仍用 query_data；提示索引未建立时，先说明需要重建索引（rag_reindex），征得同意后再执行。",
      "6. analyze：成绩统计与排名等深度分析用它，kind 取 score_overview（班级统计+排名）、score_student（学生成绩报告）、score_rank（排行榜）、score_trend（总分走势）；先经 query_data 拿到班级名/学生 ID 再分析，不要自己心算数字。",
      "7. current_page：需要确认用户当前页面上实际渲染的内容时调用；最新页面上下文已随本提示注入，通常无需重复调用。",
      "- 工具返回失败时，如实向用户解释原因并给出建议，不要假装执行成功。",
      "- 回答使用简体中文，简洁自然；引用数据时给出关键数字，必要时附上记录条数。",
      "",
      "补充设定（用户自定义）：{补充设定}",
    ].join("\n"),
  },
  {
    id: "content.term-comment",
    group: "content",
    label: "学期评语",
    desc: "学生详情页「AI 生成评语」：按本学期成绩与表现写期末评语草稿。",
    note:
      "「不超过 N 字」是给模型的写作建议，可以按需调整；" +
      "程序另有一道硬截断，超过 200 字的正文会被直接截掉，建议值不要超过它。",
    vars: [
      { name: "评语字数上限", desc: "给模型的写作字数建议（程序另有硬截断，见上方说明）", defaultValue: "120" },
    ],
    default:
      "你是一位经验丰富的小学班主任，正在为学生写期末评语。" +
      "写作要求：1）结合给出的成绩与日常表现，客观具体、有温度；" +
      "2）先肯定优点，再委婉指出需要努力的方向；" +
      "3）不超过 {评语字数上限} 字，只输出评语正文，不要标题、引号、编号或任何解释。",
    /* 演示用：已自定义状态 */
    text:
      "你是一位经验丰富的小学班主任，正在为学生写期末评语。" +
      "写作要求：1）结合给出的成绩与日常表现，客观具体、有温度；" +
      "2）先肯定优点，再委婉指出需要努力的方向；" +
      "3）不超过 {评语字数上限} 字，只输出评语正文，不要标题、引号、编号或任何解释。" +
      "语气上多用「你」直接称呼学生，像写给家长的家书。",
    custom: true,
    updatedAt: "2026-09-30 21:14",
  },
  {
    id: "content.eval-report",
    group: "content",
    label: "评价报告",
    desc: "学生评价报告页「AI 生成」：按区间产出结构化报告 + 短评语。",
    note:
      "程序按「短评语：」这一行把输出拆成报告正文与短评语两段；" +
      "若改动小节结构或删掉该标记行，短评语将退化为正文前 120 字。",
    default:
      "你是一位经验丰富的小学班主任，正在为学生写阶段性评价报告。" +
      "写作要求：1）基于给出的成绩、表现、作业摘要，不编造具体分数与事例；" +
      "2）语气温暖具体，先肯定再给建议；" +
      "3）按固定 5 节输出 markdown：# 标题 / ## 总评 / ## 学业表现 / ## 行为习惯 / ## 作业情况 / ## 给家长的建议，每节 2~4 句；" +
      "4）全文 300~800 字；5）末尾另起一行输出「短评语：」+ 一句 60~120 字的期末评语口吻短评，只输出报告与短评语行，不要解释。",
  },
  {
    id: "content.lesson-digest",
    group: "content",
    label: "课堂小结",
    desc: "课堂模式下课后的 AI 小结：按课堂事实数据写教师口吻的回顾。",
    note: "输入是点名人次、表扬/待改进条数、小组积分等事实数据，模型只做润色、不做统计。",
    default:
      "你是一位班主任，刚上完一节课，正在写一段课堂小结。" +
      "写作要求：1）只依据给出的事实数据，不编造姓名、分数与事例；" +
      "2）以 markdown 输出，含 3 个小节：## 课堂回顾 / ## 亮点与提醒 / ## 下一步建议，每节 2~3 句；" +
      "3）语气温暖具体，先肯定再给建议，涉及待改进时用「建议课后轻声提醒」这类不点破的措辞；" +
      "4）全文 150~350 字，只输出小结正文，不要解释。",
  },
  {
    id: "content.behavior-comment",
    group: "content",
    label: "推荐评语",
    desc: "快捷记表现的 AI 推荐评语：按维度与倾向生成 2 条短评语。",
    note: "老师选定的「评价倾向」（表扬 / 待改进 / 中立）由程序在用户消息里给出，此处无需重复。",
    vars: [
      { name: "每条字数上限", desc: "程序实际保留的单条最大字数（与截断逻辑同源）", fixedValue: "25" },
    ],
    default:
      "你是一位经验丰富的小学班主任助手，擅长用简短、具体、措辞得体的中文评语记录学生日常表现。" +
      "写作要求：1）语气必须严格贴合老师指定的「评价倾向」，不同倾向不得混用；" +
      "2）每条评语不超过 {每条字数上限} 个字；3）一行一条，只输出评语本身，不要编号、引号、前缀或任何解释。",
  },
  {
    id: "content.memo-title",
    group: "content",
    label: "备忘快速标题",
    desc: "课表日历里把备忘正文浓缩成一行快速浏览标题。",
    note: "生成结果会落库并永久复用（不重复调用模型），改提示词后仅对之后新建的备忘生效。",
    vars: [
      { name: "标题字数上限", desc: "程序实际保留的最大字数（与截断逻辑同源）", fixedValue: "12" },
    ],
    default:
      "你是小学班主任助手。把日程备忘浓缩成一个不超过 {标题字数上限} 个字的快速浏览标题：" +
      "保留时间、班级、科目、事项等关键信息，只输出标题本身，不要引号、句号或任何解释。",
  },
  {
    id: "recognize.roster-name-column",
    group: "recognize",
    label: "花名册姓名列识别",
    desc: "导入花名册时判断哪一列是学生姓名，与规则识别结果合成。",
    note:
      "输出结构是程序解析契约：键名与列号语义不能改动。" +
      "识别结果只有在规则列候选内才会被判为高置信，改提示词也绕不过确认流程。",
    vars: [
      { name: "输出结构", desc: "程序解析所需的 JSON 结构（只读，请勿删改）", fixedValue: ROSTER_NAME_COLUMN_OUTPUT_SCHEMA, contract: true },
    ],
    default:
      "你是表格结构分析助手。用户会给出一张表格各列的表头与示例值，" +
      "请判断哪一列最有可能是「学生姓名」。只输出一个 JSON 对象：" +
      "{输出结构}，" +
      "不要输出任何其他内容。",
  },
  {
    id: "recognize.roster-class-name",
    group: "recognize",
    label: "花名册班级推断",
    desc: "整批学生都没有班级信息时，从文件名与标题行推断属于哪个班级。",
    note:
      "输出结构是程序解析契约。「没有班级线索时 class_name 必须为 null」这句请保留：" +
      "程序会拒收不含「班」或超过 12 字的名字，用于压住模型编造班级名。",
    vars: [
      { name: "输出结构", desc: "程序解析所需的 JSON 结构（只读，请勿删改）", fixedValue: ROSTER_CLASS_NAME_OUTPUT_SCHEMA, contract: true },
    ],
    default:
      "你是学生信息表格结构分析助手。用户会给出一份表格的文件名与标题行，" +
      "请判断这份表格属于哪个班级（如「四8班」「四年级八班」「三年级二班」）。" +
      "只输出一个 JSON 对象：{输出结构}，" +
      "没有班级线索时 class_name 必须为 null，不要输出任何其他内容。",
  },
  {
    id: "recognize.score-sheet",
    group: "recognize",
    label: "成绩单结构识别",
    desc: "导入成绩单时判断姓名列、科目列，并提取考试名与考试时间。",
    note:
      "输出结构是程序解析契约：键名与列号语义不能改动，否则识别结果会被判为无效并回退规则识别。" +
      "科目「column」为从 1 起的列号，程序内部转 0 起。",
    vars: [
      { name: "输出结构", desc: "程序解析所需的 JSON 结构（只读，请勿删改）", fixedValue: SCORE_SHEET_OUTPUT_SCHEMA, contract: true },
    ],
    default:
      "你是成绩单结构分析助手。请判断表格中哪一列是学生姓名，哪些列是考试科目成绩（总分/排名/平均分等汇总列不算科目），" +
      "并从标题行提取考试名称与考试时间。" +
      "只输出一个 JSON 对象：{输出结构}，" +
      "不要输出任何其他内容。",
  },
  {
    id: "recognize.guardian-tag",
    group: "recognize",
    label: "监护人标签倾向",
    desc: "学生档案里为监护人风格标签判定情感倾向，决定标签胶囊的配色。",
    note:
      "倾向取值必须是 positive / neutral / negative 三者之一（程序只认这三个值）。" +
      "结果按标签缓存，一次判定永久复用——改提示词后已缓存的标签不会重新判定。",
    default:
      "你是小学班主任助手。为每个「监护人风格标签」判定教师与该监护人相处沟通时的情感倾向，三选一：" +
      "positive（正面：温和、配合、沟通良好）、negative（负面：配合度低、难沟通、较少参与）、" +
      "neutral（中性：客观描述无明显褒贬）。" +
      "只输出 JSON 对象，键为标签原文、值为 positive/neutral/negative，不要任何解释。",
  },
];

/* 归一：没有自定义正文的模块，生效正文 = 默认正文 */
for (const m of MODULES) if (m.text === undefined) m.text = m.default;

/* ---------------- 小工具 ---------------- */

function groupOf(groupId) {
  return GROUPS.find((g) => g.id === groupId) || { id: groupId, label: "其他", desc: "" };
}
function modulesOf(groupId) {
  return groupId === "all" ? MODULES : MODULES.filter((m) => m.group === groupId);
}
function customCount() {
  return MODULES.filter((m) => m.custom).length;
}

/** 与运行期 resolvePrompt 同语义的预览渲染：变量代入，未知占位符原样保留 */
function renderPreview(mod, draft) {
  return draft.replace(/\{([^{}]+)\}/g, (raw, name) => {
    const v = (mod.vars || []).find((x) => x.name === name);
    if (!v) return raw;
    return v.fixedValue ?? v.defaultValue ?? v.sample ?? raw;
  });
}

/** 正文里未声明的占位符 */
function unknownPlaceholders(mod, draft) {
  const names = new Set((mod.vars || []).map((v) => v.name));
  const found = [];
  for (const m of draft.matchAll(/\{([^{}]+)\}/g)) if (!names.has(m[1])) found.push(m[1]);
  return found;
}

/* ---------------- 演示用写操作（仅内存，不落任何存储） ---------------- */

function demoSave(mod, text) {
  mod.text = text;
  mod.custom = text !== mod.default;
  mod.updatedAt = mod.custom ? "刚刚" : undefined;
}
function demoResetOne(mod) {
  mod.text = mod.default;
  mod.custom = false;
  mod.updatedAt = undefined;
}
function demoResetAll() {
  for (const m of MODULES) demoResetOne(m);
}

/* ---------------- 共享 UI：图标 / toast ---------------- */

const ICONS = {
  home: '<path d="M4 11.2 12 4.5l8 6.7V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/>',
  users: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 20c.4-3.2 2.6-5 5.5-5s5.1 1.8 5.5 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16 15.2c2.6.3 4.3 2 4.6 4.8"/>',
  chart: '<path d="M5 20v-6M10 20V7M15 20v-9M20 20v-4"/>',
  board: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v3M8 21h8"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3.5V7M16 3.5V7"/>',
  doc: '<path d="M6.5 3H14l4 4v13.5H6.5z"/><path d="M13.5 3v4.5H18M9.5 12.5h5M9.5 16h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
  warn: '<path d="M12 4 21.5 20h-19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  chevL: '<path d="m14 6-6 6 6 6"/>',
  chevR: '<path d="m10 6 6 6-6 6"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  refresh: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 3.5v5h5"/>',
};

function icon(name, size) {
  size = size || 16;
  return (
    '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (ICONS[name] || "") + "</svg>"
  );
}

/* 轻反馈：与 useToast 同款视觉（顶部居中深色 pill） */
let mockToastTimer = null;
function toast(msg) {
  let el = document.querySelector(".mock-toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "mock-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(mockToastTimer);
  mockToastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

/** 右下角方案角标：评审时区分三版 */
function mockBadge(text) {
  const el = document.createElement("div");
  el.className = "mock-badge";
  el.textContent = text;
  document.body.appendChild(el);
}

/** 应用外壳侧栏（静态示意，无交互） */
function renderShell() {
  const aside = document.createElement("aside");
  aside.className = "sidebar";
  const items = [
    ["home", "首页", false],
    ["users", "班级管理", false],
    ["chart", "成绩", false],
    ["board", "课堂模式", false],
    ["calendar", "课程表", false],
    ["doc", "提示词管理", true],
    ["gear", "设置", false],
  ];
  aside.innerHTML =
    '<div class="brand"><span class="brand-logo">a</span><span class="brand-name">aprilio</span></div>' +
    '<nav class="nav">' +
    items
      .map(
        ([ic, label, active]) =>
          '<button type="button"' + (active ? ' class="active"' : "") + ">" + icon(ic) + "<span>" + label + "</span></button>",
      )
      .join("") +
    "</nav>" +
    '<div class="side-foot"><div class="db-card"><p style="font-size:12px;color:var(--weak)">本地数据库</p>' +
    '<div class="db-row"><span class="db-dot"></span><span>SQLite · 已连接</span></div></div></div>';
  document.body.prepend(aside);
}
