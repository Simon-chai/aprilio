/**
 * 座位编排（学期域 seatings）：
 * - 有座位表 → 按表构建网格；无表 → 按学号序内存回退推导（不落库，课堂模式无需先维护座位）
 * - 组号显式存在座位行上（不由列推导，支持团团坐等任意分组）；P0 组名统一「第 N 组」
 * - 调整座位 = 幂等命令（同生旧座先清，一人一座）
 */
import { listSeating, listStudents, removeSeatingStudent, upsertSeating } from "../lib/db";
import { semesterOfDate } from "../lib/timetable";
import type { ClassroomGroup, ClassroomStudent, SeatingGrid } from "./types";

/** 回退推导的默认列数（6 列 ≈ 小学常见座位布局） */
export const DEFAULT_SEAT_COLS = 6;

export interface ClassroomRoster {
  /** 全班在册学生（含未入座者：row_no/col_no/group_no = 0） */
  students: ClassroomStudent[];
  seating: SeatingGrid;
  semester: string;
}

/** 装配一节课的名单 + 座位网格（有表按表，无表回退推导） */
export async function buildClassroomRoster(
  className: string,
  lessonDate: string,
): Promise<ClassroomRoster> {
  const semester = semesterOfDate(lessonDate);
  const rows = await listStudents("", className);
  const seats = await listSeating(className, semester);

  if (!seats.length) {
    const grid = deriveSeatingGrid(
      rows.map((s) => ({
        id: s.id,
        name: s.name,
        student_no: s.student_no ?? "",
        gender: s.gender,
        row_no: 0,
        col_no: 0,
        group_no: 0,
      })),
    );
    return { students: flattenGrid(grid), seating: grid, semester };
  }

  const seatOf = new Map(seats.map((s) => [s.student_id, s]));
  const students: ClassroomStudent[] = rows.map((s) => {
    const seat = seatOf.get(s.id);
    return {
      id: s.id,
      name: s.name,
      student_no: s.student_no ?? "",
      gender: s.gender,
      row_no: seat?.row_no ?? 0,
      col_no: seat?.col_no ?? 0,
      group_no: seat?.group_no ?? 0,
    };
  });

  const rowCount = Math.max(1, ...seats.map((s) => s.row_no));
  const colCount = Math.max(1, ...seats.map((s) => s.col_no));
  const cells: Array<Array<ClassroomStudent | null>> = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => null),
  );
  for (const st of students) {
    if (st.row_no >= 1 && st.row_no <= rowCount && st.col_no >= 1 && st.col_no <= colCount) {
      cells[st.row_no - 1][st.col_no - 1] = st;
    }
  }
  return { students, seating: { rows: rowCount, cols: colCount, cells, derived: false }, semester };
}

/**
 * 无表回退推导（纯函数）：按学号升序（空学号按 id）从左到右、从上到下铺网格，组号 = 列号。
 * 返回网格的 cell 内是补齐了 row/col/group 的学生副本；flattenGrid 展开即得学生表。
 */
export function deriveSeatingGrid(
  students: ClassroomStudent[],
  cols: number = DEFAULT_SEAT_COLS,
): SeatingGrid {
  const colCount = Math.max(1, Math.min(Math.floor(cols) || DEFAULT_SEAT_COLS, 12));
  const sorted = [...students].sort(compareStudents);
  const rowCount = Math.max(1, Math.ceil(sorted.length / colCount));
  const cells: Array<Array<ClassroomStudent | null>> = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => null),
  );
  sorted.forEach((s, i) => {
    const row = Math.floor(i / colCount) + 1;
    const col = (i % colCount) + 1;
    cells[row - 1][col - 1] = { ...s, row_no: row, col_no: col, group_no: col };
  });
  return { rows: rowCount, cols: colCount, cells, derived: true };
}

/** 网格展平为学生表（含空格位跳过），按行优先顺序 */
export function flattenGrid(grid: SeatingGrid): ClassroomStudent[] {
  const list: ClassroomStudent[] = [];
  for (const row of grid.cells) {
    for (const cell of row) {
      if (cell) list.push(cell);
    }
  }
  return list;
}

/** 按组号聚合（group_no = 0 的未入座学生不进组）；P0 组名统一「第 N 组」 */
export function buildGroups(students: ClassroomStudent[]): ClassroomGroup[] {
  const byGroup = new Map<number, ClassroomStudent[]>();
  for (const s of students) {
    if (s.group_no <= 0) continue;
    const list = byGroup.get(s.group_no) ?? [];
    list.push(s);
    byGroup.set(s.group_no, list);
  }
  return [...byGroup.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([group_no, list]) => ({
      group_no,
      name: `第 ${group_no} 组`,
      students: list.sort(compareStudents),
    }));
}

/** 安排/移动座位（幂等命令）：先清该生在同班同学期的旧座，再占新格 */
export async function assignSeat(
  className: string,
  lessonDate: string,
  studentId: number,
  rowNo: number,
  colNo: number,
  groupNo: number,
): Promise<void> {
  await upsertSeating({
    class_name: className,
    semester: semesterOfDate(lessonDate),
    row_no: rowNo,
    col_no: colNo,
    group_no: groupNo,
    student_id: studentId,
  });
}

/** 撤出座位（回到未入座池） */
export async function unseat(className: string, lessonDate: string, studentId: number): Promise<void> {
  await removeSeatingStudent(className, semesterOfDate(lessonDate), studentId);
}

/** 按学号升序（空学号按 id 排在最后） */
function compareStudents(a: ClassroomStudent, b: ClassroomStudent): number {
  const ka = (a.student_no ?? "").trim();
  const kb = (b.student_no ?? "").trim();
  if (ka && kb) return ka.localeCompare(kb, "zh", { numeric: true });
  if (ka) return -1;
  if (kb) return 1;
  return a.id - b.id;
}