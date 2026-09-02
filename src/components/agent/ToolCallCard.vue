<script setup lang="ts">
/**
 * 工具调用卡片：Agent 正在/已经执行的一个工具的可视化。
 * 状态点：running 转圈 · done 绿点 · failed 红点；结果摘要折叠展示。
 */
import type { ChatItem } from "../../composables/useAgent";

const props = defineProps<{ item: Extract<ChatItem, { kind: "tool" }> }>();

const RESULT_PREVIEW_LEN = 160;

function resultPreview(): string {
  const result = props.item.result;
  if (!result) return "";
  if (!result.ok) return result.error ?? "执行失败";
  const text = result.summary.replace(/\s+/g, " ").trim();
  return text.length > RESULT_PREVIEW_LEN ? `${text.slice(0, RESULT_PREVIEW_LEN)}…` : text;
}
</script>

<template>
  <div class="rounded-md border border-white/10 bg-white/[0.06] px-2.5 py-1.5">
    <div class="flex items-center gap-1.5">
      <!-- 状态指示 -->
      <span v-if="item.status === 'running'" class="flex h-2 w-2" aria-hidden="true">
        <span class="h-2 w-2 animate-ping rounded-full bg-primary-on-dark/70" />
      </span>
      <span
        v-else
        class="h-2 w-2 rounded-full"
        :class="item.status === 'done' ? 'bg-success' : 'bg-danger'"
        aria-hidden="true"
      />

      <span class="text-[12px] font-medium text-white/85">{{ item.label }}</span>
      <span class="min-w-0 flex-1 truncate text-[11px] text-white/50">{{ item.detail }}</span>

      <span v-if="item.status === 'running'" class="typing-dots text-[11px] text-white/45">执行中</span>
    </div>

    <p
      v-if="item.status !== 'running' && resultPreview()"
      class="mt-1 select-text break-words border-t border-white/10 pt-1 text-[11px] leading-relaxed text-white/55"
    >
      {{ resultPreview() }}
    </p>
  </div>
</template>
