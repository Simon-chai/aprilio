/**
 * 内存兜底库（拆分自 db.ts）：浏览器演示态 / 单测环境的 17 个集合完整复制品。
 * 结构与 SQLite 表一一对应；域文件经 mem() 取用，经 resetMemoryStore() 重置。
 */
import { currentSemester } from "../semester";
import { inferExamType } from "../score-analysis";
import { fmtLocalTs } from "./shared";
import type {
  BehaviorDimension,
  CalendarEvent,
  ClassMeta,
  CommentPreset,
  Exam,
  ExamScore,
  Gender,
  Guardian,
  Photo,
  RecycleItem,
  Student,
  StudentBehaviorRecord,
  StudentEvalReport,
  StudentHomeworkRecord,
  StudentTermComment,
  Timetable,
  TimetableException,
  TimetableSlot,
} from "../../types";
import type {
  ClassroomActivitySet,
  LessonEvent,
  LessonSession,
  Seating,
} from "../../classroom/types";

/* ------------------------------------------------------------------ */
/* 内存兜底：浏览器里也能看到完整界面                                    */
/* ------------------------------------------------------------------ */

export interface MemoryStore {
  students: Student[];
  photos: Photo[];
  classes: string[];
  /** 班级元信息（归档状态），按班级名索引 */
  classMeta: Record<string, ClassMeta>;
  /** 学期评语（每生每学期一条） */
  termComments: StudentTermComment[];
  guardians: Guardian[];
  behaviorDimensions: BehaviorDimension[];
  behaviorRecords: StudentBehaviorRecord[];
  commentPresets: (CommentPreset & { last_used_at: string })[];
  recycleBin: RecycleItem[];
  exams: Exam[];
  examScores: ExamScore[];
  timetables: Timetable[];
  timetableSlots: TimetableSlot[];
  timetableExceptions: TimetableException[];
  calendarEvents: CalendarEvent[];
  /** 个人作业台账 */
  homeworks: StudentHomeworkRecord[];
  /** 评价报告存档 */
  evalReports: StudentEvalReport[];
  /** 课堂会话（lesson_sessions） */
  lessonSessions: LessonSession[];
  /** 课堂事件流（lesson_events） */
  lessonEvents: LessonEvent[];
  /** 学期域座位表（seatings） */
  seatings: Seating[];
  /** 课堂活动组合配置（classroom_activity_sets） */
  activitySets: ClassroomActivitySet[];
  nextStudentId: number;
  nextPhotoId: number;
  nextGuardianId: number;
  nextDimensionId: number;
  nextBehaviorRecordId: number;
  nextCommentPresetId: number;
  nextRecycleId: number;
  nextExamId: number;
  nextExamScoreId: number;
  nextTimetableId: number;
  nextTimetableSlotId: number;
  nextTimetableExceptionId: number;
  nextCalendarEventId: number;
  nextTermCommentId: number;
  nextHomeworkId: number;
  nextEvalReportId: number;
  nextLessonSessionId: number;
  nextLessonEventId: number;
  nextSeatingId: number;
  nextActivitySetId: number;
}

/** 与 SQLite datetime('now','localtime') 同格式的本地时间戳 */
export const now = () => fmtLocalTs(new Date());

/** 与 Rust 迁移种子数据保持一致，浏览器演示态/单测共用 */
const BEHAVIOR_DIMENSIONS: BehaviorDimension[] = [
  { id: 1, category: "study", code: "homework", name: "作业情况", icon: "BookOpen", sort_order: 1, is_system: 1, is_active: 1 },
  { id: 2, category: "study", code: "exam", name: "单元/期中期末成绩", icon: "GraduationCap", sort_order: 2, is_system: 1, is_active: 1 },
  { id: 3, category: "behavior", code: "classroom", name: "课堂表现", icon: "MessageSquare", sort_order: 3, is_system: 1, is_active: 1 },
  { id: 4, category: "behavior", code: "labor", name: "劳动情况", icon: "Sparkles", sort_order: 4, is_system: 1, is_active: 1 },
];

const BEHAVIOR_PRESET_SEED: [number, CommentPreset["type"], string][] = [
  [1, "praise", "书写工整规范，解题步骤完整清晰"],
  [1, "praise", "按时独立完成作业，正确率极高"],
  [1, "improve", "作业未按时提交，需及时补交"],
  [1, "improve", "错题漏题较多，未进行及时订正"],
  [1, "neutral", "作业按时完成，整体表现平稳"],
  [2, "praise", "测试成绩名列前茅，基础扎实知识掌握牢固"],
  [2, "praise", "较上次有显著进步，难题突破能力提升"],
  [2, "improve", "基础计算失误较多，需加强审题与验算习惯"],
  [2, "improve", "重点知识点有脱节，需针对性复习补漏"],
  [2, "neutral", "成绩处于班级平均水平，保持学习节奏"],
  [3, "praise", "课堂听讲专注，积极举手发言发表独到见解"],
  [3, "praise", "互动热烈，能主动带动小组讨论探索"],
  [3, "improve", "课堂听讲容易走神，需要老师多次提醒注意集中"],
  [3, "improve", "自控力较弱，有做小动作或讲话现象"],
  [3, "neutral", "课堂表现平稳，能按时完成课堂任务"],
  [4, "praise", "主动承担卫生大扫除，擦黑板和整理卫生角非常细致"],
  [4, "praise", "值日尽职尽责，主动帮助其他同学整理桌椅"],
  [4, "improve", "值日敷衍草率，未完成清洁任务提前离开"],
  [4, "improve", "缺乏公共卫生意识，桌面及周围杂物未整理"],
  [4, "neutral", "按安排完成值日任务"],
];

function seedStore(): MemoryStore {
  const base = now();
  const names: [string, Gender, string, string, string][] = [
    ["林知远", "男", "2017-05-12", "三年级二班", "138 0012 8846"],
    ["苏晚", "女", "2017-08-03", "三年级二班", "139 8877 2310"],
    ["陈嘉树", "男", "2016-11-27", "四年级一班", "137 6620 4518"],
    ["周砚", "男", "2016-03-14", "四年级一班", "150 2211 9073"],
    ["何听雨", "女", "2018-01-09", "二年级三班", "186 5540 7782"],
    ["顾星野", "男", "2017-09-30", "二年级三班", "133 9080 3321"],
    ["沈屿", "女", "2017-06-18", "三年级一班", "159 3344 1208"],
    ["温故", "男", "2017-02-21", "三年级一班", "188 0077 6690"],
    ["江雪眠", "女", "2015-12-05", "五年级二班", "132 5511 4477"],
    ["陆时安", "男", "2016-07-16", "五年级二班", "181 2290 3388"],
    // 四年级一班补足到 10 人：与 docs/examples/成绩单-四年级一班-*.csv 样例对应，
    // 让「班级成绩 / 个人成绩」面板在浏览器演示态即有完整的班级统计与排名。
    ["赵晨曦", "女", "2016-04-18", "四年级一班", "137 5566 1201"],
    ["钱雨泽", "男", "2016-09-02", "四年级一班", "138 2233 4502"],
    ["孙梦琪", "女", "2016-06-25", "四年级一班", "139 6688 7303"],
    ["李承宇", "男", "2016-02-11", "四年级一班", "150 3344 8604"],
    ["周思远", "男", "2016-12-08", "四年级一班", "151 7788 9905"],
    ["吴佳怡", "女", "2016-08-19", "四年级一班", "158 1122 2306"],
    ["郑子轩", "男", "2016-05-30", "四年级一班", "159 4455 6607"],
    ["王诗雅", "女", "2016-10-14", "四年级一班", "180 6677 8808"],
  ];

  const guardians: Guardian[] = [];
  let gid = 1;
  const fatherJobs = ["工程师", "个体经营", "公务员", "司机", "销售"];
  const motherJobs = ["教师", "护士", "会计", "全职妈妈", "设计师"];

  const students: Student[] = names.map(([name, gender, birth, klass, phone], i) => {
    const sid = i + 1;
    guardians.push({
      id: gid++,
      student_id: sid,
      name: `${name.slice(0, 1)}建国`,
      phone,
      relation: "父亲",
      is_primary: true,
      occupation: fatherJobs[i % fatherJobs.length],
      tags: i % 2 === 0 ? ["积极配合"] : ["严格"],
    });
    guardians.push({
      id: gid++,
      student_id: sid,
      name: `${name.slice(0, 1)}秀英`,
      phone: phone.replace("8", "9"),
      relation: "母亲",
      is_primary: false,
      occupation: motherJobs[i % motherJobs.length],
      tags: ["沟通顺畅"],
    });
    return {
      id: sid,
      name,
      gender,
      birth_date: birth,
      student_no: `2023000${String(1 + i)}`,
      grade_class: klass,
      id_card: null,
      address: "杭州市西湖区文三路 128 号",
      status: "active",
      note: null,
      guardians: [],
      created_at: base,
      updated_at: base,
    };
  });

  for (const s of students) {
    s.guardians = guardians.filter((g) => g.student_id === s.id);
  }

  const captions = ["校园运动会", "科学课实验", "期中表彰", "课外阅读", "春游合影"];
  const photos: Photo[] = [];
  let pid = 1;

  photos.push({
    id: pid++,
    student_id: null,
    grade_class: "三年级二班",
    file_name: "demo-class-32.jpg",
    caption: "三年级二班开学集体合影",
    taken_at: "2026-09-01",
    created_at: base,
  });

  for (const s of students) {
    const count = 3 + (s.id % 5);
    for (let i = 0; i < count; i++) {
      photos.push({
        id: pid++,
        student_id: s.id,
        file_name: `demo-${s.id}-${i + 1}.jpg`,
        caption: captions[(s.id + i) % captions.length],
        taken_at: "2026-08-20",
        created_at: base,
      });
    }
  }

  const initialClasses = Array.from(
    new Set(students.map((s) => s.grade_class).filter(Boolean))
  );

  // 演示课表：三年级二班整周 + 三年级一班少量格子；
  // 周一第 2 节两个班都有语文 → 演示「我的课表」跨班聚合与撞课告警
  const demoTimetableEntries: [string, [number, number, string, string?][]][] = [
    [
      "三年级二班",
      [
        [1, 1, "数学"],
        [1, 2, "语文"],
        [1, 3, "英语"],
        [1, 5, "体育"],
        [1, 6, "音乐"],
        [2, 1, "语文"],
        [2, 2, "数学"],
        [2, 3, "美术"],
        [2, 5, "道德与法治"],
        [3, 1, "语文"],
        [3, 2, "数学"],
        [3, 3, "科学"],
        [3, 5, "信息科技", "去机房"],
        [4, 1, "数学"],
        [4, 2, "语文"],
        [4, 3, "体育"],
        [4, 5, "劳动"],
        [5, 1, "英语"],
        [5, 2, "数学"],
        [5, 3, "语文"],
        [5, 5, "班会"],
      ],
    ],
    [
      "三年级一班",
      [
        [1, 1, "数学"],
        [1, 2, "语文"],
        [1, 3, "英语"],
        [3, 1, "语文"],
        [3, 2, "数学"],
        [5, 3, "语文"],
      ],
    ],
  ];

  const semester = currentSemester();
  const timetables: Timetable[] = [];
  const timetableSlots: TimetableSlot[] = [];
  let timetableId = 1;
  let slotId = 1;
  for (const [className, entries] of demoTimetableEntries) {
    const tid = timetableId++;
    timetables.push({
      id: tid,
      class_name: className,
      semester,
      note: null,
      periods: null,
      my_subjects: null,
      created_at: base,
      updated_at: base,
    });
    for (const [day, period, subject, note] of entries) {
      timetableSlots.push({
        id: slotId++,
        timetable_id: tid,
        day_of_week: day,
        period,
        subject,
        note: note ?? null,
        updated_at: base,
      });
    }
  }

  // 演示日程事件：班级事件（type 区分）+ 教师个人事件（class_name 为 null）
  const localDate = (offsetDays: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const calendarEvents: CalendarEvent[] = [
    { id: 1, class_name: "三年级二班", event_date: localDate(1), type: "todo", period: null, content: "收秋游回执单", title: null, done: 0, created_at: base, updated_at: base },
    { id: 2, class_name: "三年级二班", event_date: localDate(3), type: "memo", period: null, content: "大课间彩排", title: null, done: 0, created_at: base, updated_at: base },
    { id: 3, class_name: "三年级二班", event_date: localDate(-2), type: "memo", period: null, content: "班委开会", title: null, done: 1, created_at: base, updated_at: base },
    { id: 4, class_name: "三年级二班", event_date: localDate(2), type: "exam", period: 6, content: "数学第一单元测验", title: null, done: 0, created_at: base, updated_at: base },
    { id: 5, class_name: null, event_date: localDate(0), type: "homework", period: 4, content: "布置语文第 3 课抄写", title: null, done: 0, created_at: base, updated_at: base },
    { id: 6, class_name: null, event_date: localDate(0), type: "todo", period: null, content: "下午教研组会议", title: null, done: 0, created_at: base, updated_at: base },
  ];

  // 演示调课例外：明天第 6 节停课（彩排）、后天第 7 节加一节语文
  const timetableExceptions: TimetableException[] = [
    {
      id: 1,
      timetable_id: 1,
      exception_date: localDate(1),
      period: 6,
      subject: "",
      note: "大课间彩排",
      created_at: base,
      updated_at: base,
    },
    {
      id: 2,
      timetable_id: 1,
      exception_date: localDate(2),
      period: 7,
      subject: "语文",
      note: "调课补课",
      created_at: base,
      updated_at: base,
    },
  ];

  // 演示成绩：多班级 × 多次考试，覆盖「数字分」与「等级制」两种口径。
  // - 四年级一班：与 docs/examples 成绩单样例同源（10 人 × 5 次考试，含等级制月考），
  //   用于展示多考试趋势、个人单科走势与偏科诊断；
  // - 三年级二班：主演示班（林知远 / 苏晚）3 次考试，展示逐次进步；
  // - 其余班级：按学生/科目确定性生成 3 次考试，保证任意班级打开「考试成绩」都有多考试对比。
  interface DemoExamDef {
    name: string;
    exam_date: string;
    subjects: string[];
    rows: [string, ...(number | string)[]][];
  }

  const explicitScoreSpecs: { class_name: string; exams: DemoExamDef[] }[] = [
    {
      class_name: "四年级一班",
      exams: [
        {
          name: "学情摸底测试",
          exam_date: "2026-09-18",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["陈嘉树", 88, 91, 85],
            ["周砚", 82, 85, 78],
            ["赵晨曦", 95, 89, 92],
            ["钱雨泽", 76, 81, 73],
            ["孙梦琪", 90, 87, 91],
            ["李承宇", 84, 92, 86],
            ["周思远", 72, 78, 70],
            ["吴佳怡", 87, 84, 88],
            ["郑子轩", 93, 86, 85],
            ["王诗雅", 80, 83, 77],
          ],
        },
        {
          name: "第一单元测验",
          exam_date: "2026-09-25",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["陈嘉树", 85, 90, 78],
            ["周砚", 79, 83, 72],
            ["赵晨曦", 92, 88, 90],
            ["钱雨泽", 74, 80, 70],
            ["孙梦琪", 88, 85, 89],
            ["李承宇", 80, 89, 82],
            ["周思远", 70, 76, 68],
            ["吴佳怡", 85, 82, 86],
            ["郑子轩", 90, 84, 83],
            ["王诗雅", 78, 81, 75],
          ],
        },
        {
          name: "第一次月考",
          exam_date: "2026-10-09",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["陈嘉树", 92, 93, 84],
            ["周砚", 83, 82, 66],
            ["赵晨曦", 96, 95, 94],
            ["钱雨泽", 65, 81, 64],
            ["孙梦琪", 94, 93, 95],
            ["李承宇", 85, 91, 83],
            ["周思远", 55, 62, 54],
            ["吴佳怡", 91, 82, 92],
            ["郑子轩", 93, 94, 82],
            ["王诗雅", 82, 81, 63],
          ],
        },
        {
          name: "期中考试",
          exam_date: "2026-11-05",
          subjects: ["语文", "数学", "英语", "科学"],
          rows: [
            ["陈嘉树", 92, 95, 88, 90],
            ["周砚", 85, 88, 79, 84],
            ["赵晨曦", 96, 91, 94, 92],
            ["钱雨泽", 78, 83, 81, 86],
            ["孙梦琪", 91, 89, 93, 88],
            ["李承宇", 83, 92, 85, 90],
            ["周思远", 75, 80, 72, 78],
            ["吴佳怡", 89, 86, 90, 84],
            ["郑子轩", 94, 87, 88, 91],
            ["王诗雅", 82, 84, 79, 83],
          ],
        },
        {
          name: "期末考试",
          exam_date: "2027-01-15",
          subjects: ["数学", "语文", "英语", "科学", "道德与法治"],
          rows: [
            ["陈嘉树", 96, 90, 92, 89, 91],
            ["周砚", 89, 86, 84, 88, 85],
            ["赵晨曦", 93, 97, 95, 93, 94],
            ["钱雨泽", 85, 80, 83, 87, 84],
            ["孙梦琪", 92, 93, 94, 90, 92],
            ["李承宇", 94, 85, 88, 91, 89],
            ["周思远", 82, 78, 76, 80, 79],
            ["吴佳怡", 88, 90, 89, 86, 87],
            ["郑子轩", 90, 95, 87, 92, 90],
            ["王诗雅", 86, 84, 82, 85, 83],
          ],
        },
      ],
    },
    {
      class_name: "三年级二班",
      exams: [
        {
          name: "第一次月考",
          exam_date: "2026-09-26",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["林知远", 88, 92, 85],
            ["苏晚", 90, 86, 91],
          ],
        },
        {
          name: "期中考试",
          exam_date: "2026-11-06",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["林知远", 91, 95, 88],
            ["苏晚", 93, 89, 94],
          ],
        },
        {
          name: "期末考试",
          exam_date: "2027-01-14",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["林知远", 94, 97, 90],
            ["苏晚", 95, 92, 96],
          ],
        },
      ],
    },
  ];

  const generatedClasses: { class_name: string; names: string[] }[] = [
    { class_name: "三年级一班", names: ["沈屿", "温故"] },
    { class_name: "五年级二班", names: ["江雪眠", "陆时安"] },
    { class_name: "二年级三班", names: ["何听雨", "顾星野"] },
  ];
  const generatedExams = [
    { name: "第一次月考", exam_date: "2026-09-24" },
    { name: "期中考试", exam_date: "2026-11-07" },
    { name: "期末考试", exam_date: "2027-01-13" },
  ];
  const generatedSubjects = ["语文", "数学", "英语"];
  /** 确定性伪随机成绩（72~91 起，逐次略升），仅用于演示数据，保证每次启动一致 */
  const demoScoreOf = (studentId: number, subjectIndex: number, examIndex: number): number => {
    const baseScore = 72 + ((studentId * 7 + subjectIndex * 11) % 20);
    const drift = examIndex * 2;
    const jitter = ((studentId + subjectIndex * 3 + examIndex * 5) % 5) - 2;
    return Math.max(55, Math.min(100, baseScore + drift + jitter));
  };

  const exams: Exam[] = [];
  const examScores: ExamScore[] = [];
  let examId = 1;
  let examScoreId = 1;
  const pushExam = (className: string, def: DemoExamDef) => {
    exams.push({
      id: examId,
      class_name: className,
      name: def.name,
      exam_date: def.exam_date,
      exam_type: inferExamType(def.name),
      note: null,
      created_at: base,
      updated_at: base,
    });
    for (const [studentName, ...cells] of def.rows) {
      const student = students.find((s) => s.name === studentName);
      if (!student) continue;
      def.subjects.forEach((subject, i) => {
        const value = cells[i];
        const isNumeric = typeof value === "number";
        examScores.push({
          id: examScoreId++,
          exam_id: examId,
          student_id: student.id,
          subject,
          score: isNumeric ? value : null,
          grade: isNumeric ? null : String(value),
          created_at: base,
          updated_at: base,
        });
      });
    }
    examId++;
  };

  for (const spec of explicitScoreSpecs) {
    for (const def of spec.exams) pushExam(spec.class_name, def);
  }

  for (const { class_name, names: classNames } of generatedClasses) {
    generatedExams.forEach((exam, examIndex) => {
      const rows: [string, ...(number | string)[]][] = classNames.map((name) => {
        const student = students.find((s) => s.name === name);
        const cells = generatedSubjects.map((_, subjectIndex) =>
          student ? demoScoreOf(student.id, subjectIndex, examIndex) : 80
        );
        return [name, ...cells];
      });
      pushExam(class_name, { ...exam, subjects: generatedSubjects, rows });
    });
  }

  return {
    students,
    photos,
    classes: initialClasses,
    classMeta: {},
    termComments: [],
    guardians,
    behaviorDimensions: BEHAVIOR_DIMENSIONS.map((d) => ({ ...d })),
    behaviorRecords: [],
    commentPresets: BEHAVIOR_PRESET_SEED.map(([dimensionId, type, content], i) => ({
      id: i + 1,
      dimension_id: dimensionId,
      type,
      content,
      use_count: 1,
      source: "system" as const,
      last_used_at: base,
    })),
    recycleBin: [],
    exams,
    examScores,
    timetables,
    timetableSlots,
    timetableExceptions,
    calendarEvents,
    nextStudentId: 19,
    nextPhotoId: pid,
    nextGuardianId: gid,
    nextDimensionId: BEHAVIOR_DIMENSIONS.length + 1,
    nextBehaviorRecordId: 1,
    nextCommentPresetId: BEHAVIOR_PRESET_SEED.length + 1,
    nextRecycleId: 1,
    nextExamId: examId,
    nextExamScoreId: examScoreId,
    nextTimetableId: timetableId,
    nextTimetableSlotId: slotId,
    nextTimetableExceptionId: timetableExceptions.length + 1,
    nextCalendarEventId: calendarEvents.length + 1,
    nextTermCommentId: 1,
    homeworks: [],
    evalReports: [],
    nextHomeworkId: 1,
    nextEvalReportId: 1,
    lessonSessions: [],
    lessonEvents: [],
    seatings: [],
    activitySets: [],
    nextLessonSessionId: 1,
    nextLessonEventId: 1,
    nextSeatingId: 1,
    nextActivitySetId: 1,
  };
}

let memory: MemoryStore | null = null;
export function mem(): MemoryStore {
  if (!memory) memory = seedStore();
  return memory;
}


/** 重置并返回内存库（clearAll 用）：可选注入自定义种子库 */
export function resetMemoryStore(next: MemoryStore = seedStore()): MemoryStore {
  memory = next;
  return memory;
}
