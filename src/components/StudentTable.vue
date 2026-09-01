<script setup lang="ts">
import type { StudentRow } from "../types";
import { formatShort } from "../lib/format";

defineProps<{ rows: StudentRow[] }>();
const emit = defineEmits<{ open: [row: StudentRow] }>();

const COLS = "180px 140px 160px 170px 120px 160px 120px 1fr";
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-hairline bg-canvas">
    <!-- 表头 -->
    <div
      class="grid h-11 items-center border-b border-hairline bg-pearl px-5 text-fine text-weak"
      :style="{ gridTemplateColumns: COLS }"
    >
      <span>姓名</span>
      <span>学号</span>
      <span>年级班级</span>
      <span>联系电话</span>
      <span>图片记录</span>
      <span>更新时间</span>
      <span>操作</span>
      <span />
    </div>

    <!-- 数据行 -->
    <div
      v-for="row in rows"
      :key="row.id"
      class="grid h-[52px] cursor-pointer items-center border-b border-divider px-5 text-caption transition-colors last:border-b-0 hover:bg-parchment"
      :style="{ gridTemplateColumns: COLS }"
      @click="emit('open', row)"
    >
      <span class="font-semibold text-ink">{{ row.name }}</span>
      <span class="text-muted">{{ row.student_no }}</span>
      <span class="text-muted">{{ row.grade_class }}</span>
      <span class="text-muted">{{ row.guardian_phone ?? "—" }}</span>
      <span class="text-muted">{{ row.photo_count }} 张</span>
      <span class="text-weak">{{ formatShort(row.updated_at) }}</span>
      <span class="text-primary">查看</span>
      <span />
    </div>
  </div>
</template>
