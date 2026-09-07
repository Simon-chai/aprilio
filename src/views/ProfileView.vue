<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import AppButton from "../components/ui/AppButton.vue";
import AppCard from "../components/ui/AppCard.vue";
import { useClock } from "../composables/useClock";
import {
  discardSelectedProfileImage,
  ensureProfile,
  profile,
  profileImageSrc,
  saveProfileChanges,
  selectProfileImage,
  type ProfileImageKind,
} from "../lib/profile";
import { profileSaveErrorMessage } from "../lib/error-message";
import { listTimetableSubjects } from "../lib/db";
import { SUBJECT_PRESETS } from "../lib/timetable";
import type { Profile } from "../types";
import { PROFILE_TITLES } from "../types";

const router = useRouter();
const { hhmm, greeting } = useClock();
const imageKinds: ProfileImageKind[] = ["avatar", "hero"];
const profileKeys: Array<keyof Profile> = ["name", "title", "motto", "avatar", "hero"];

const draft = reactive<Profile>({ ...profile.value });
const savedSnapshot = ref<Profile>({ ...profile.value });
const nameInput = ref<HTMLInputElement | null>(null);
const loading = ref(true);
const saving = ref(false);
const saved = ref(false);
const error = ref("");
const pendingFiles = new Map<ProfileImageKind, Set<string>>();
const selectionCount = ref(0);
const leaving = ref(false);
let ready = false;
let unmounted = false;
let activeSave: Promise<boolean> | null = null;
let imageOperation: Promise<void> | null = null;
let cleanupInFlight: Promise<void> | null = null;

/* 任教学科：我的课表的判定条件，主录入入口在个人资料页 */
const subjectCandidates = ref<string[]>([...SUBJECT_PRESETS]);
const newSubject = ref("");

const subjectChips = computed(() => {
  const chips = [...subjectCandidates.value];
  for (const s of draft.my_subjects ?? []) {
    if (!chips.includes(s)) chips.push(s);
  }
  return chips;
});

function isSelected(subject: string): boolean {
  return (draft.my_subjects ?? []).includes(subject);
}

function toggleSubject(subject: string): void {
  draft.my_subjects = isSelected(subject)
    ? (draft.my_subjects ?? []).filter((s) => s !== subject)
    : [...(draft.my_subjects ?? []), subject];
}

function addCustomSubject(): void {
  const s = newSubject.value.trim();
  if (!s) return;
  if (!subjectCandidates.value.includes(s)) {
    subjectCandidates.value = [...subjectCandidates.value, s];
  }
  if (!isSelected(s)) draft.my_subjects = [...(draft.my_subjects ?? []), s];
  newSubject.value = "";
}

async function loadSubjectCandidates(): Promise<void> {
  try {
    const merged = [...SUBJECT_PRESETS];
    for (const s of await listTimetableSubjects()) {
      if (!merged.includes(s)) merged.push(s);
    }
    subjectCandidates.value = merged;
  } catch {
    /* 候选加载失败不影响编辑，退回预设 */
  }
}

function normalizeSubjects(list: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const s = raw.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const isDirty = computed(
  () =>
    profileKeys.some((key) => draft[key] !== savedSnapshot.value[key]) ||
    JSON.stringify(draft.my_subjects ?? []) !== JSON.stringify(savedSnapshot.value.my_subjects ?? []),
);
const avatarPreview = computed(() => profileImageSrc(draft.avatar, "avatar"));
const heroPreview = computed(() => profileImageSrc(draft.hero, "hero"));
/* 历史数据可能存有枚举外的旧身份文案，追加为额外选项避免丢失 */
const titleOptions = computed(() => {
  const options: string[] = [...PROFILE_TITLES];
  if (draft.title && !options.includes(draft.title)) options.push(draft.title);
  return options;
});
const saveStatus = computed(() => {
  if (saving.value) return "\u4FDD\u5B58\u4E2D";
  if (saved.value && !isDirty.value) return "\u5DF2\u4FDD\u5B58";
  return isDirty.value ? "\u672A\u4FDD\u5B58" : "";
});

onMounted(async () => {
  await ensureProfile();
  if (unmounted) return;
  Object.assign(draft, profile.value);
  savedSnapshot.value = { ...profile.value };
  loading.value = false;
  ready = true;
  void loadSubjectCandidates();
});

watch(
  () => [profileKeys.map((key) => draft[key]), JSON.stringify(draft.my_subjects ?? [])],
  () => {
    if (ready && isDirty.value) {
      saved.value = false;
      error.value = "";
    }
  },
);

function messageOf(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

function trackPending(kind: ProfileImageKind, fileName: string): void {
  if (!fileName) return;
  const files = pendingFiles.get(kind) ?? new Set<string>();
  files.add(fileName);
  pendingFiles.set(kind, files);
}

function untrackPending(kind: ProfileImageKind, fileName: string): void {
  if (!fileName) return;
  const files = pendingFiles.get(kind);
  if (!files) return;
  files.delete(fileName);
  if (files.size === 0) pendingFiles.delete(kind);
}

async function clearPending(kind: ProfileImageKind): Promise<void> {
  const files = [...(pendingFiles.get(kind) ?? [])];
  const results = await Promise.allSettled(
    files.map(async (fileName) => {
      await discardSelectedProfileImage(fileName);
    }),
  );

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      untrackPending(kind, files[index]);
    }
  });

  const firstFailure = results.find((result) => result.status === "rejected");
  if (firstFailure?.status === "rejected") {
    throw firstFailure.reason;
  }
}

async function chooseImage(kind: ProfileImageKind): Promise<void> {
  if (loading.value || saving.value || leaving.value || selectionCount.value > 0) return;
  error.value = "";
  selectionCount.value += 1;
  const operation = (async () => {
    let selected: { value: string; fileName?: string } | null = null;

    try {
      selected = await selectProfileImage(kind);
      if (!selected) return;

      if (unmounted) {
        if (selected.fileName) {
          await discardSelectedProfileImage(selected.fileName).catch(() => undefined);
        }
        return;
      }

      try {
        await clearPending(kind);
      } catch (cause) {
        if (selected.fileName) {
          try {
            await discardSelectedProfileImage(selected.fileName);
          } catch {
            trackPending(kind, selected.fileName);
          }
        }
        throw cause;
      }

      if (unmounted) {
        if (selected.fileName) {
          await discardSelectedProfileImage(selected.fileName).catch(() => undefined);
        }
        return;
      }

      draft[kind] = selected.value;
      if (selected.fileName) trackPending(kind, selected.fileName);
    } catch (cause) {
      if (!unmounted) {
        error.value = messageOf(
          cause,
          "\u56FE\u7247\u9009\u62E9\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002",
        );
      }
    } finally {
      selectionCount.value -= 1;
    }
  })();
  imageOperation = operation;

  try {
    await operation;
  } finally {
    if (imageOperation === operation) imageOperation = null;
  }
}

async function restoreImage(kind: ProfileImageKind): Promise<void> {
  if (loading.value || saving.value || leaving.value || selectionCount.value > 0) return;
  error.value = "";
  selectionCount.value += 1;
  const operation = (async () => {
    try {
      await clearPending(kind);
      if (unmounted) return;
      draft[kind] = "";
    } catch (cause) {
      if (!unmounted) {
        error.value = messageOf(
          cause,
          "\u56FE\u7247\u6E05\u7406\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002",
        );
      }
    } finally {
      selectionCount.value -= 1;
    }
  })();
  imageOperation = operation;

  try {
    await operation;
  } finally {
    if (imageOperation === operation) imageOperation = null;
  }
}

async function saveChanges(): Promise<void> {
  if (
    loading.value ||
    saving.value ||
    leaving.value ||
    selectionCount.value > 0 ||
    cleanupInFlight ||
    !isDirty.value
  ) {
    return;
  }
  if (!draft.name.trim()) {
    error.value = "\u8BF7\u8F93\u5165\u59D3\u540D\u3002";
    nameInput.value?.focus();
    return;
  }

  saving.value = true;
  error.value = "";
  const next: Profile = {
    name: draft.name.trim(),
    title: draft.title.trim(),
    motto: draft.motto.trim(),
    avatar: draft.avatar,
    hero: draft.hero,
    my_subjects: normalizeSubjects(draft.my_subjects),
  };

  const saveOperation = (async () => {
    let succeeded = false;
    try {
      await saveProfileChanges(next);
      imageKinds.forEach((kind) => untrackPending(kind, next[kind]));
      if (unmounted) return false;
      Object.assign(draft, next);
      savedSnapshot.value = { ...next };
      saved.value = true;
      succeeded = true;
    } catch (cause) {
      if (!unmounted) {
        error.value = profileSaveErrorMessage(cause);
        saved.value = false;
      }
    } finally {
      saving.value = false;
    }
    return succeeded;
  })();
  activeSave = saveOperation;

  try {
    const succeeded = await saveOperation;
    if (succeeded && !unmounted) {
      void router.push({ name: "home" }).catch(() => undefined);
    }
  } finally {
    if (activeSave === saveOperation) activeSave = null;
  }
}

async function cleanupPending(): Promise<void> {
  if (cleanupInFlight) return cleanupInFlight;
  const cleanup = Promise.allSettled(imageKinds.map((kind) => clearPending(kind))).then((results) => {
    const firstFailure = results.find((result) => result.status === "rejected");
    if (firstFailure?.status === "rejected") throw firstFailure.reason;
  });
  cleanupInFlight = cleanup;
  try {
    await cleanup;
  } finally {
    if (cleanupInFlight === cleanup) cleanupInFlight = null;
  }
}

onBeforeRouteLeave(async () => {
  if (leaving.value || saving.value || selectionCount.value > 0) return false;
  leaving.value = true;

  try {
    if (
      isDirty.value &&
      !window.confirm(
        "\u8FD8\u6709\u672A\u4FDD\u5B58\u7684\u8D44\u6599\uFF0C\u786E\u5B9A\u79BB\u5F00\u5417\uFF1F",
      )
    ) {
      return false;
    }
    return true;
  } finally {
    leaving.value = false;
  }
});

onBeforeUnmount(() => {
  unmounted = true;
  const save = activeSave;
  const image = imageOperation;
  void Promise.all([
    save ? save.catch(() => undefined) : Promise.resolve(),
    image ? image.catch(() => undefined) : Promise.resolve(),
  ])
    .then(() => cleanupPending())
    .catch(() => undefined);
});
</script>

<template>
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <div class="flex items-center gap-2.5">
      <button
        type="button"
        class="text-ink transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
        aria-label="&#x8FD4;&#x56DE;&#x9996;&#x9875;"
        @click="router.push({ name: 'home' })"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M10 3L5 8L10 13"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <h1 class="text-tagline font-semibold text-ink">
        &#x4E2A;&#x4EBA;&#x8D44;&#x6599;
      </h1>
    </div>
    <div class="flex items-center gap-3">
      <p
        v-if="error"
        class="max-w-[360px] rounded-md border border-danger/30 bg-danger-soft px-3 py-1.5 text-right text-fine leading-5 text-danger"
        role="alert"
        aria-live="assertive"
      >
        {{ error }}
      </p>
      <span v-if="saveStatus" class="text-caption text-weak" aria-live="polite">
        {{ saveStatus }}
      </span>
      <AppButton
        :disabled="loading || saving || leaving || selectionCount > 0 || !isDirty"
        @click="saveChanges"
      >
        <template v-if="saving">&#x4FDD;&#x5B58;&#x4E2D;&#x2026;</template>
        <template v-else>&#x4FDD;&#x5B58;&#x66F4;&#x6539;</template>
      </AppButton>
    </div>
  </header>

  <div class="scroll-thin flex-1 overflow-y-auto p-8">
    <div class="mx-auto grid max-w-[1120px] gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <AppCard>
        <div class="mb-4 flex items-center justify-between">
          <div>
            <h2 class="text-body font-semibold text-ink">&#x9996;&#x9875;&#x9884;&#x89C8;</h2>
            <p class="mt-1 text-caption text-weak">
              &#x7F16;&#x8F91;&#x5185;&#x5BB9;&#x4F1A;&#x5373;&#x65F6;&#x663E;&#x793A;&#x5728;&#x8FD9;&#x91CC;
            </p>
          </div>
          <span class="rounded-pill bg-primary-soft px-2.5 py-1 text-fine text-primary">
            &#x5B9E;&#x65F6;&#x9884;&#x89C8;
          </span>
        </div>
        <div class="relative aspect-[16/10] overflow-hidden rounded-md bg-tile">
          <img
            :src="heroPreview"
            alt="&#x9996;&#x9875;&#x5927;&#x56FE;&#x9884;&#x89C8;"
            class="absolute inset-0 h-full w-full object-cover"
          />
          <div class="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/75" />
          <div class="absolute inset-x-5 bottom-5 text-white">
            <div class="mb-3 flex items-center gap-3">
              <img
                :src="avatarPreview"
                alt="&#x5934;&#x50CF;&#x9884;&#x89C8;"
                class="h-10 w-10 rounded-full object-cover ring-1 ring-white/50"
              />
              <span class="tnum text-caption text-white/70">{{ hhmm }}</span>
            </div>
            <p class="text-caption text-white/65">{{ greeting }}&#xFF0C;</p>
            <p class="mt-1 text-[26px] font-semibold leading-tight">
              {{ draft.name || "\u4F60\u7684\u59D3\u540D" }}
            </p>
            <p v-if="draft.motto" class="mt-1 text-caption text-white/70">
              {{ draft.motto }}
            </p>
          </div>
        </div>
      </AppCard>

      <div class="space-y-5">
        <AppCard>
          <h2 class="mb-4 text-body font-semibold text-ink">&#x57FA;&#x672C;&#x8D44;&#x6599;</h2>
          <div class="space-y-4">
            <div>
              <label for="profile-name" class="mb-1.5 block text-caption text-weak">
                &#x59D3;&#x540D;
              </label>
              <input
                id="profile-name"
                ref="nameInput"
                v-model="draft.name"
                :disabled="loading || saving || leaving || selectionCount > 0"
                class="h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none transition-colors focus:border-primary-focus"
              />
            </div>
            <div>
              <label for="profile-title" class="mb-1.5 block text-caption text-weak">
                &#x8EAB;&#x4EFD;
              </label>
              <select
                id="profile-title"
                v-model="draft.title"
                :disabled="loading || saving || leaving || selectionCount > 0"
                class="h-9 w-full rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none transition-colors focus:border-primary-focus"
              >
                <option value="">&#x672A;&#x8BBE;&#x7F6E;</option>
                <option v-for="t in titleOptions" :key="t" :value="t">{{ t }}</option>
              </select>
            </div>
            <div>
              <label for="profile-motto" class="mb-1.5 block text-caption text-weak">
                &#x7B7E;&#x540D;
              </label>
              <textarea
                id="profile-motto"
                v-model="draft.motto"
                rows="3"
                :disabled="loading || saving || leaving || selectionCount > 0"
                class="w-full resize-y rounded-sm border border-hairline bg-canvas px-3 py-2 text-caption leading-6 text-ink outline-none transition-colors focus:border-primary-focus"
                placeholder="&#x5199;&#x4E00;&#x53E5;&#x4F60;&#x60F3;&#x653E;&#x5728;&#x9996;&#x9875;&#x7684;&#x8BDD;"
              ></textarea>
            </div>
          </div>
        </AppCard>

        <AppCard>
          <h2 class="mb-4 text-body font-semibold text-ink">
            &#x9996;&#x9875;&#x56FE;&#x7247;
          </h2>
          <div class="space-y-5">
            <div class="flex items-center gap-3">
              <img
                :src="avatarPreview"
                alt="&#x5F53;&#x524D;&#x5934;&#x50CF;"
                class="h-16 w-16 shrink-0 rounded-full object-cover ring-1 ring-hairline"
              />
              <div class="min-w-0 flex-1">
                <p class="text-caption font-semibold text-ink">&#x5934;&#x50CF;</p>
                <p class="mt-1 text-fine text-weak">
                  &#x81EA;&#x52A8;&#x5C45;&#x4E2D;&#x88C1;&#x6210;&#x6B63;&#x65B9;&#x5F62;
                </p>
              </div>
              <AppButton
                variant="pearl"
                :disabled="loading || saving || leaving || selectionCount > 0"
                @click="chooseImage('avatar')"
              >
                &#x66F4;&#x6362;
              </AppButton>
            </div>
              <button
                v-if="draft.avatar"
                type="button"
                :disabled="loading || saving || leaving || selectionCount > 0"
              class="text-fine text-primary hover:underline"
              @click="restoreImage('avatar')"
            >
              &#x6062;&#x590D;&#x9ED8;&#x8BA4;&#x5934;&#x50CF;
            </button>
            <div class="border-t border-divider pt-5">
              <img
                :src="heroPreview"
                alt="&#x5F53;&#x524D;&#x9996;&#x9875;&#x5927;&#x56FE;"
                class="aspect-[16/6] w-full rounded-sm object-cover"
              />
              <div class="mt-3 flex items-center justify-between gap-3">
                <div>
                  <p class="text-caption font-semibold text-ink">&#x9996;&#x9875;&#x5927;&#x56FE;</p>
                  <p class="mt-1 text-fine text-weak">
                    &#x4F1A;&#x94FA;&#x6EE1;&#x9996;&#x9875;&#x7B2C;&#x4E00;&#x5C4F;
                  </p>
                </div>
                <AppButton
                  variant="pearl"
                  :disabled="loading || saving || leaving || selectionCount > 0"
                  @click="chooseImage('hero')"
                >
                  &#x66F4;&#x6362;
                </AppButton>
              </div>
              <button
                v-if="draft.hero"
                type="button"
                :disabled="loading || saving || leaving || selectionCount > 0"
                class="mt-2 text-fine text-primary hover:underline"
                @click="restoreImage('hero')"
              >
                &#x6062;&#x590D;&#x9ED8;&#x8BA4;&#x9996;&#x9875;&#x5927;&#x56FE;
              </button>
            </div>
          </div>
        </AppCard>

        <AppCard>
          <h2 class="mb-1 text-body font-semibold text-ink">任教学科</h2>
          <p class="mb-4 text-fine text-weak">
            用于「我的课表」与首页今日课程：勾选你教的科目，跨班的课会自动聚合成你的行程
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="s in subjectChips"
              :key="s"
              type="button"
              data-test="subject-chip"
              :disabled="loading || saving || leaving || selectionCount > 0"
              class="rounded-pill border px-3 py-1 text-fine transition-colors disabled:opacity-40"
              :class="
                isSelected(s)
                  ? 'border-ink bg-ink text-canvas font-medium'
                  : 'border-hairline bg-canvas text-muted hover:border-ink'
              "
              @click="toggleSubject(s)"
            >
              {{ s }}
            </button>
          </div>
          <div class="mt-4 flex items-center gap-2">
            <input
              id="profile-new-subject"
              v-model="newSubject"
              :disabled="loading || saving || leaving || selectionCount > 0"
              placeholder="自定义科目，如：写字"
              class="h-9 flex-1 rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none transition-colors focus:border-primary-focus"
              @keydown.enter.prevent="addCustomSubject"
            />
            <AppButton
              variant="pearl"
              :disabled="loading || saving || leaving || selectionCount > 0 || !newSubject.trim()"
              @click="addCustomSubject"
            >
              添加
            </AppButton>
          </div>
        </AppCard>

      </div>
    </div>
  </div>
</template>
