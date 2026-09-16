<script setup lang="ts">
/**
 * 座位大屏（seating 活动 UI）。
 *
 * 交互：点座位 → 浮层（维度 + 常用评语 + 手输 → 表扬/待改进/中立记入档案；缺勤/归班；调整座位）
 * - 记表现走 ctx.emit('behavior')：框架同事务双写档案（settle='behavior'）
 * - 缺勤走 ctx.emit('attendance')：缺勤学生由 Context 移出在班名单与点名池
 * - 调座：选目标空格 → assignSeat()（幂等命令）→ 可选 seat_change 摘要事件
 * - 右栏：本课统计 + 缺勤名单 + 最近操作时间线（可撤销，撤销后框架重放刷新计数）
 */
import { computed, ref, watch } from "vue";
import AppButton from "../ui/AppButton.vue";
import AppDialog from "../ui/AppDialog.vue";
import { useLessonContext } from "../../classroom/context";
import { assignSeat } from "../../classroom/seating";
import { listCommentPresets } from "../../lib/db";
import { BEHAVIOR_POLARITY_LABEL } from "../../types";
import type { BehaviorPolarity, CommentPreset } from "../../types";
import type { ClassroomStudent } from "../../classroom/types";
import type {
  SeatingActivityState,
  SeatingTimelineEntry,
} from "../../classroom/activities/seating.activity";

const props = defineProps<{
  state: SeatingActivityState | null;
  config?: Record<string, unknown>;
}>();

const ctx = useLessonContext();

/** 本地网格：ctx.seating 是装配快照，调座后即时更新本地（落库结果下次装配生效） */
interface GridModel {
  rows: number;
  cols: number;
  cells: Array<Array<ClassroomStudent | null>>;
}

function snapshotGrid(): GridModel {
  return {
    rows: ctx.seating.rows,
    cols: ctx.seating.cols,
    cells: ctx.seating.cells.map((row) => [...row]),
  };
}

/** 浮层里的三态按钮（与事件契约 payload.type 一一对应） */
const POLARITIES: BehaviorPolarity[] = ["praise", "improve", "neutral"];

const grid = ref<GridModel>(snapshotGrid());
const rowIndexes = computed(() => Array.from({ length: grid.value.rows }, (_, i) => i + 1));
const colIndexes = computed(() => Array.from({ length: grid.value.cols }, (_, i) => i + 1));

/** 列头组名：取该列首个有组号的学生（回退网格按列赋组号，与 seating.ts 同口径） */
const columnGroups = computed(() =>
  colIndexes.value.map((c) => {
    for (const r of rowIndexes.value) {
      const stu = cell(r, c);
      if (stu && stu.group_no > 0) return stu.group_no;
    }
    return 0;
  }),
);

function cell(row: number, col: number): ClassroomStudent | null {
  return grid.value.cells[row - 1]?.[col - 1] ?? null;
}

const praise = computed(() => props.state?.praise ?? {});
const improve = computed(() => props.state?.improve ?? {});
const absentList = computed(() => props.state?.absent ?? []);
const timeline = computed(() => props.state?.timeline ?? []);

const praiseCount = computed(() => Object.values(praise.value).reduce((sum, n) => sum + n, 0));
const improveCount = computed(() => Object.values(improve.value).reduce((sum, n) => sum + n, 0));

function praiseOf(studentId: number): number {
  return praise.value[studentId] ?? 0;
}

function improveOf(studentId: number): number {
  return improve.value[studentId] ?? 0;
}

function isAbsent(studentId: number | undefined): boolean {
  return studentId !== undefined && absentList.value.some((a) => a.student_id === studentId);
}

function initial(name: string): string {
  return name.slice(0, 1);
}

/* ---------------- 学生操作浮层 ---------------- */

const sheetStudent = ref<ClassroomStudent | null>(null);
const dimensionId = ref<number>(ctx.dimensions[0]?.id ?? 0);
const polarity = ref<BehaviorPolarity>("praise");
const comment = ref("");
const presets = ref<CommentPreset[]>([]);
const saving = ref(false);

const activeDimension = computed(
  () => ctx.dimensions.find((d) => d.id === dimensionId.value) ?? null,
);

const sheetMeta = computed(() => {
  const stu = sheetStudent.value;
  if (!stu) return "";
  const group = ctx.groups.find((g) => g.group_no === stu.group_no);
  const seat = stu.row_no >= 1 ? `第${stu.row_no}排${stu.col_no}列` : "未入座";
  return [group?.name, seat, isAbsent(stu.id) ? "缺勤中" : ""].filter(Boolean).join(" · ");
});

watch(
  [dimensionId, polarity],
  async () => {
    const id = dimensionId.value;
    if (!id) {
      presets.value = [];
      return;
    }
    try {
      presets.value = await listCommentPresets(id, polarity.value);
    } catch {
      // 常用评语取不到不影响手输评语
      presets.value = [];
    }
  },
  { immediate: true },
);

function openSheet(stu: ClassroomStudent) {
  sheetStudent.value = stu;
  comment.value = "";
  if (!ctx.dimensions.some((d) => d.id === dimensionId.value)) {
    dimensionId.value = ctx.dimensions[0]?.id ?? 0;
  }
}

function closeSheet() {
  sheetStudent.value = null;
}

function pickPreset(content: string) {
  comment.value = content;
}

async function submitBehavior() {
  const stu = sheetStudent.value;
  const dim = activeDimension.value;
  if (!stu || !dim) return;
  const text = comment.value.trim();
  if (!text) {
    ctx.ui.toast("请选择常用评语或输入评语", { tone: "error" });
    return;
  }
  saving.value = true;
  try {
    await ctx.emit({
      activity: "seating",
      kind: "behavior",
      student_id: stu.id,
      // 事件只存最小充分字段：评语正文在档案记录里（settled_record_id 反查）
      payload: { dimension_id: dim.id, type: polarity.value, via: "seat" },
      behavior: {
        dimension_id: dim.id,
        dimension_name_snap: dim.name,
        category_snap: dim.category,
        type: polarity.value,
        comment: text,
      },
    });
    ctx.ui.toast(`${stu.name} · ${BEHAVIOR_POLARITY_LABEL[polarity.value]}已记入档案`, {
      tone: "success",
    });
    closeSheet();
  } catch (e) {
    ctx.ui.toast(e instanceof Error ? e.message : String(e), { tone: "error" });
  } finally {
    saving.value = false;
  }
}

async function toggleAbsent() {
  const stu = sheetStudent.value;
  if (!stu) return;
  const absent = !isAbsent(stu.id);
  try {
    await ctx.emit({
      activity: "seating",
      kind: "attendance",
      student_id: stu.id,
      payload: { absent },
    });
    ctx.ui.toast(`${stu.name} · ${absent ? "已标记缺勤" : "已归班"}`, { tone: "success" });
    closeSheet();
  } catch (e) {
    ctx.ui.toast(e instanceof Error ? e.message : String(e), { tone: "error" });
  }
}

/* ---------------- 调座 ---------------- */

const moveSource = ref<ClassroomStudent | null>(null);

function startMove() {
  if (!sheetStudent.value) return;
  moveSource.value = sheetStudent.value;
  closeSheet();
  ctx.ui.toast(`已选 ${moveSource.value.name}，请点击一个空位完成调座`);
}

function cancelMove() {
  moveSource.value = null;
  ctx.ui.toast("已取消调座");
}

async function onCellClick(stu: ClassroomStudent | null, row: number, col: number) {
  if (moveSource.value) {
    await moveTo(row, col);
    return;
  }
  if (stu) openSheet(stu);
}

async function moveTo(row: number, col: number) {
  const src = moveSource.value;
  if (!src) return;
  const target = cell(row, col);
  if (target && target.id !== src.id) {
    ctx.ui.toast("该位置已有学生，请选空位", { tone: "error" });
    return;
  }
  if (target?.id === src.id) {
    moveSource.value = null;
    return;
  }
  const groupNo = src.group_no > 0 ? src.group_no : col;
  const from: { row: number; col: number } | null =
    src.row_no >= 1 && src.col_no >= 1 ? { row: src.row_no, col: src.col_no } : null;
  try {
    // 幂等命令：先清旧座再占新格（一人一座）；课堂内外均可执行，不撤销
    await assignSeat(ctx.session.class_name, ctx.session.lesson_date, src.id, row, col, groupNo);
  } catch (e) {
    ctx.ui.toast(e instanceof Error ? e.message : String(e), { tone: "error" });
    return;
  }
  if (from) {
    const oldRow = grid.value.cells[from.row - 1];
    if (oldRow && oldRow[from.col - 1]?.id === src.id) oldRow[from.col - 1] = null;
  }
  grid.value.cells[row - 1][col - 1] = { ...src, row_no: row, col_no: col, group_no: groupNo };
  moveSource.value = null;
  try {
    // 摘要事件（可选）：只供回放/小结展示，真实座位状态以 seatings 表为准
    await ctx.emit({
      activity: "seating",
      kind: "seat_change",
      student_id: src.id,
      payload: { student_id: src.id, from, to: { row, col } },
    });
    ctx.ui.toast(`${src.name} 已调座`, { tone: "success" });
  } catch (e) {
    ctx.ui.toast(e instanceof Error ? e.message : String(e), { tone: "error" });
  }
}

/* ---------------- 撤销 ---------------- */

async function onRevoke(entry: SeatingTimelineEntry) {
  const ok = await ctx.ui.confirm({
    title: "撤销课堂记录",
    message: `撤销「${entry.text}」？档案记录会同步删除。`,
    tone: "danger",
    confirmText: "撤销",
  });
  if (!ok) return;
  try {
    await ctx.revoke(entry.id);
    ctx.ui.toast("已撤销");
  } catch (e) {
    ctx.ui.toast(e instanceof Error ? e.message : String(e), { tone: "error" });
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 gap-4" data-test="seat-grid-panel">
    <div class="flex min-w-0 flex-1 flex-col gap-2">
      <div class="rounded-sm bg-white/10 py-1.5 text-center text-fine text-white/50">讲　台</div>
      <p
        v-if="ctx.seating.derived"
        class="rounded-sm bg-improve-soft px-3 py-2 text-fine text-improve"
        data-test="seat-derived-note"
      >
        未维护座位表，本次按学号临时排座（调座结果会写入学期座位表）
      </p>
      <div class="flex min-h-0 flex-1 justify-center gap-2" data-test="seat-board">
        <div
          v-for="c in colIndexes"
          :key="c"
          class="flex min-h-0 flex-1 flex-col gap-1.5 rounded-md border border-white/10 bg-white/5 p-2"
        >
          <p class="text-center text-fine font-medium text-white/50">
            {{ columnGroups[c - 1] > 0 ? `第 ${columnGroups[c - 1]} 组` : "" }}
          </p>
          <button
            v-for="r in rowIndexes"
            :key="r"
            type="button"
            class="relative flex min-h-[54px] flex-col items-center justify-center gap-0.5 rounded-md border px-1 py-1.5 text-center transition-colors"
            :class="[
              cell(r, c)
                ? 'border-white/10 bg-white/10 text-white hover:bg-white/15'
                : 'border-white/10 bg-white/5 text-white/35 hover:bg-white/10',
              cell(r, c) && isAbsent(cell(r, c)!.id) ? 'opacity-50' : '',
              moveSource && cell(r, c)?.id === moveSource.id ? 'border-primary-on-dark bg-white/15' : '',
            ]"
            :data-test="`seat-${r}-${c}`"
            @click="onCellClick(cell(r, c), r, c)"
          >
            <template v-if="cell(r, c)">
              <span
                class="flex h-7 w-7 items-center justify-center rounded-pill bg-white/5 text-fine font-semibold"
              >
                {{ initial(cell(r, c)!.name) }}
              </span>
              <span class="max-w-full truncate text-fine">{{ cell(r, c)!.name }}</span>
              <span class="flex items-center gap-1 text-fine">
                <span v-if="isAbsent(cell(r, c)!.id)" class="text-white/50">缺勤</span>
                <span v-if="praiseOf(cell(r, c)!.id)" class="text-praise-on-dark">
                  表扬 {{ praiseOf(cell(r, c)!.id) }}
                </span>
                <span v-if="improveOf(cell(r, c)!.id)" class="text-improve-on-dark">
                  待改进 {{ improveOf(cell(r, c)!.id) }}
                </span>
              </span>
            </template>
            <span v-else class="text-fine">空位</span>
          </button>
        </div>
      </div>
      <div class="flex items-center gap-2 text-fine text-white/50">
        <span v-if="moveSource" data-test="seat-move-hint">
          调座中：{{ moveSource.name }} → 点击空位
        </span>
        <span v-else>点座位记表现 · 缺勤 / 调座都在浮层里</span>
        <button
          v-if="moveSource"
          type="button"
          class="text-white/50 hover:text-white"
          data-test="seat-move-cancel"
          @click="cancelMove"
        >
          取消调座
        </button>
      </div>
    </div>

    <aside class="flex w-[290px] shrink-0 flex-col gap-3">
      <div class="rounded-lg border border-white/10 bg-white/5 p-3">
        <p class="text-caption font-semibold text-white">本节课统计</p>
        <div class="mt-2 grid grid-cols-3 gap-2 text-center">
          <div>
            <p class="text-stat text-praise-on-dark" data-test="seat-praise-count">{{ praiseCount }}</p>
            <p class="text-fine text-white/50">表扬</p>
          </div>
          <div>
            <p class="text-stat text-improve-on-dark" data-test="seat-improve-count">{{ improveCount }}</p>
            <p class="text-fine text-white/50">待改进</p>
          </div>
          <div>
            <p class="text-stat text-white/50" data-test="seat-absent-count">{{ absentList.length }}</p>
            <p class="text-fine text-white/50">缺勤</p>
          </div>
        </div>
        <p v-if="absentList.length" class="mt-2 text-fine text-white/50" data-test="seat-absent-list">
          缺勤：{{ absentList.map((a) => a.student_name).join("、") }}
        </p>
      </div>

      <div class="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 bg-white/5 p-3">
        <p class="text-caption font-semibold text-white">
          本课动态 <span class="text-fine font-normal text-white/50">{{ timeline.length }} 条</span>
        </p>
        <div class="scroll-thin mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          <div
            v-for="entry in timeline"
            :key="entry.id"
            class="flex items-center gap-2 text-fine"
            data-test="seat-timeline-row"
          >
            <span class="min-w-0 flex-1 truncate text-white/70">{{ entry.text }}</span>
            <span class="shrink-0 text-white/35">{{ entry.occurred_at.slice(11, 16) }}</span>
            <button
              type="button"
              class="shrink-0 text-white/50 hover:text-white"
              :data-test="`seat-revoke-${entry.id}`"
              @click="onRevoke(entry)"
            >
              撤销
            </button>
          </div>
          <p v-if="!timeline.length" class="text-fine text-white/50">暂无记录</p>
        </div>
      </div>
    </aside>

    <AppDialog
      :open="!!sheetStudent"
      :title="sheetStudent?.name ?? ''"
      :description="sheetMeta"
      width="sm"
      data-test="seat-sheet"
      @close="closeSheet"
    >
      <div class="mt-3 flex flex-wrap gap-1.5" data-test="seat-dims">
        <button
          v-for="d in ctx.dimensions"
          :key="d.id"
          type="button"
          class="rounded-pill border px-2.5 py-1 text-fine"
          :class="
            d.id === dimensionId
              ? 'border-primary bg-primary-soft text-primary'
              : 'border-hairline text-weak hover:text-ink'
          "
          :data-test="`seat-dim-${d.id}`"
          @click="dimensionId = d.id"
        >
          {{ d.name }}
        </button>
      </div>

      <div class="mt-3 flex gap-1.5" data-test="seat-polarity">
        <button
          v-for="p in POLARITIES"
          :key="p"
          type="button"
          class="rounded-pill border px-2.5 py-1 text-fine"
          :class="
            p === polarity
              ? 'border-primary bg-primary-soft text-primary'
              : 'border-hairline text-weak hover:text-ink'
          "
          :data-test="`seat-polarity-${p}`"
          @click="polarity = p"
        >
          {{ BEHAVIOR_POLARITY_LABEL[p] }}
        </button>
      </div>

      <div class="mt-3 flex flex-wrap gap-1.5" data-test="seat-presets">
        <button
          v-for="p in presets"
          :key="p.id"
          type="button"
          class="rounded-pill bg-pearl px-2.5 py-1 text-fine text-muted hover:bg-primary-soft hover:text-primary"
          @click="pickPreset(p.content)"
        >
          {{ p.content }}
        </button>
      </div>

      <textarea
        v-model="comment"
        rows="2"
        data-test="seat-comment"
        placeholder="评语（记入学生档案）"
        class="mt-3 w-full resize-none rounded-md border border-hairline bg-canvas px-3 py-2 text-caption text-ink outline-none"
      />

      <template #footer>
        <div class="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            class="text-caption text-weak hover:text-danger"
            data-test="seat-absent"
            @click="toggleAbsent"
          >
            {{ isAbsent(sheetStudent?.id) ? "取消缺勤（归班）" : "标记缺勤" }}
          </button>
          <div class="flex items-center gap-2">
            <AppButton variant="secondary" data-test="seat-move" @click="startMove">
              调整座位
            </AppButton>
            <AppButton :disabled="saving" data-test="seat-submit" @click="submitBehavior">
              {{ BEHAVIOR_POLARITY_LABEL[polarity] }}并记入档案
            </AppButton>
          </div>
        </div>
      </template>
    </AppDialog>
  </div>
</template>