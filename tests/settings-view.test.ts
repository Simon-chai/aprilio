import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "../src/views/SettingsView.vue";
import ToastHost from "../src/components/ui/ToastHost.vue";
import { confirmAction } from "../src/composables/useConfirm";
import { useToastState } from "../src/composables/useToast";
import { maskApiKey, type AiProfile } from "../src/lib/ai";

const TEST_KEY = "sk-test-secret-1234";
const PROFILES_KEY = "aprilio.ai.profiles.v1";

// 破坏性确认统一走全局 confirmAction 弹层：mock 掉宿主交互，直接给出确认结果
vi.mock("../src/composables/useConfirm", () => ({
  confirmAction: vi.fn(),
}));

const mockConfirm = vi.mocked(confirmAction);

beforeEach(() => {
  localStorage.clear();
  mockConfirm.mockReset();
  // toast 队列是模块级单例：用例间清空，避免跨用例串味
  useToastState().clearAll();
});

/** 挂 ToastHost 读取全局 toast 条目文案（用完 unmount，顺带清空队列） */
function toastTexts(host: ReturnType<typeof mount>): string {
  return host
    .findAll('[data-test="quick-toast"]')
    .map((t) => t.text())
    .join();
}

function keyInput(wrapper: ReturnType<typeof mount>) {
  return wrapper.find("#ai-key input");
}

/** 方案种子：明文密钥直接写入（sanitize 读入时原样保留明文） */
function seedProfiles(profiles: AiProfile[], activeId: string) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify({ activeId, profiles }));
}

const PROFILE_A: AiProfile = {
  id: "p-a",
  name: "DeepSeek 日常主力",
  provider: "deepseek",
  model: "deepseek-chat",
  apiKey: TEST_KEY,
  baseUrl: "",
  temperature: 0.7,
  systemPrompt: "",
};
const PROFILE_B: AiProfile = {
  id: "p-b",
  name: "GLM-4 Flash 备用",
  provider: "zhipu",
  model: "glm-4-flash",
  apiKey: "sk-glm-key-5678",
  baseUrl: "",
  temperature: 0.7,
  systemPrompt: "",
};
const PROFILE_NO_KEY: AiProfile = { ...PROFILE_B, id: "p-c", name: "GPT-4o mini", provider: "openai", model: "gpt-4o-mini", apiKey: "" };

/** 图库索引种子：浏览器演示态里 dataURL 直接当缓存标识，缩略图可解析 */
const BG_INDEX = [
  {
    id: "bg-bing",
    kind: "timetable_bg",
    file: "data:image/jpeg;base64,AAEC",
    source: "url",
    origin_url: "https://cn.bing.com/th?id=OHR.Test_1920x1080.jpg",
    name: "测试壁纸",
    added_at: "2026-09-16T08:00:00.000Z",
    used_at: "2026-09-16T08:00:00.000Z",
  },
  {
    id: "bg-manual",
    kind: "timetable_bg",
    file: "data:image/png;base64,BBEC",
    source: "url",
    origin_url: "https://cdn.example.com/manual.jpg",
    name: "普通网络图",
    added_at: "2026-09-16T08:01:00.000Z",
    used_at: "2026-09-16T08:01:00.000Z",
  },
];

describe("SettingsView 必应壁纸缩略图", () => {
  /**
   * 图库索引是 backgrounds 模块的内存单例，用例间会互串；
   * 每个用例重置模块图后重新挂载，保证从 localStorage 干净起步。
   */
  async function mountSettings() {
    vi.resetModules();
    const { default: FreshSettingsView } = await import("../src/views/SettingsView.vue");
    const wrapper = mount(FreshSettingsView);
    await flushPromises();
    return wrapper;
  }

  it("shows thumbnails for fetched bing wallpapers only", async () => {
    localStorage.setItem("aprilio.backgrounds.v1", JSON.stringify(BG_INDEX));
    const wrapper = await mountSettings();

    // 只有带 bing 前缀的入库图进缩略图，手动粘贴的其他网络图不混入
    const thumbs = wrapper.findAll('[data-test="wallpaper-thumb"]');
    expect(thumbs).toHaveLength(1);
    const style = (thumbs[0].element as HTMLElement).style.backgroundImage;
    expect(style).toContain("data:image/jpeg;base64,AAEC");
    expect(thumbs[0].attributes("title")).toBe("测试壁纸");
    expect(wrapper.text()).toContain("必应");
    expect(wrapper.text()).toContain("测试壁纸");
    // 未入库时不渲染缩略图块
    expect(wrapper.text()).not.toContain("普通网络图");
  });

  it("hides the thumbnail block when nothing was fetched", async () => {
    const wrapper = await mountSettings();

    expect(wrapper.find('[data-test="wallpaper-thumbs"]').exists()).toBe(false);
  });
});

describe("SettingsView 模型方案列表与一键切换", () => {
  function mountSettings() {
    return mount(SettingsView);
  }

  it("renders profile cards with the active one marked and the key masked", async () => {
    seedProfiles([PROFILE_A, PROFILE_B], "p-a");
    const wrapper = mountSettings();
    await flushPromises();

    const cards = wrapper.findAll('[data-test="ai-profile"]');
    expect(cards).toHaveLength(2);
    // 当前方案带「当前使用」标记与选中态皮肤
    expect(cards[0].text()).toContain("当前使用");
    expect(cards[0].classes()).toContain("grad-border-soft");
    expect(cards[1].text()).not.toContain("当前使用");
    // 密钥脱敏展示，不出现明文
    expect(wrapper.text()).toContain(maskApiKey(TEST_KEY));
    expect(wrapper.text()).not.toContain(TEST_KEY);
  });

  it("switches the active profile with one click", async () => {
    seedProfiles([PROFILE_A, PROFILE_B], "p-a");
    const wrapper = mountSettings();
    await flushPromises();
    // 切换结果反馈统一走全局 toast：挂 ToastHost 查条目
    const host = mount(ToastHost);

    // 只有非当前方案有「设为当前」按钮，第一颗是 p-b 的
    await wrapper.get('[data-test="ai-profile-switch"]').trigger("click");
    await flushPromises();

    expect(toastTexts(host)).toContain("已切换到");
    host.unmount();
    const state = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "{}");
    expect(state.activeId).toBe("p-b");
    // 选中态皮肤跟过去
    const cards = wrapper.findAll('[data-test="ai-profile"]');
    expect(cards[1].classes()).toContain("grad-border-soft");
    expect(cards[1].text()).toContain("当前使用");
  });

  it("blocks switching to a profile that is missing its api key", async () => {
    seedProfiles([PROFILE_A, PROFILE_NO_KEY], "p-a");
    const wrapper = mountSettings();
    await flushPromises();

    await wrapper.get('[data-test="ai-profile-switch"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="ai-switch-error"]').text()).toContain("密钥");
    const state = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "{}");
    expect(state.activeId).toBe("p-a");
  });

  it("shows the empty state when no profiles exist", async () => {
    const wrapper = mountSettings();
    await flushPromises();

    expect(wrapper.find('[data-test="ai-profile-list"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("还没有模型方案");
    // 快捷切换胶囊只在有方案时出现
    expect(wrapper.find('[data-test="ai-switcher"]').exists()).toBe(false);
  });
});

describe("SettingsView 添加 / 编辑 / 删除方案", () => {
  function mountSettings() {
    return mount(SettingsView);
  }

  it("adds a profile through the modal and makes it active on first save", async () => {
    const wrapper = mountSettings();
    const host = mount(ToastHost);
    await flushPromises();

    await wrapper.get('[data-test="ai-profile-add"]').trigger("click");
    const modal = wrapper.get('[data-test="ai-modal"]');
    expect(modal.text()).toContain("添加模型");

    await modal.get('[data-test="ai-name"]').setValue("我的方案");
    // 新增默认 DeepSeek，模型 ID 已自动带入
    expect((modal.get('[data-test="ai-model"] input').element as HTMLInputElement).value).toBe("deepseek-chat");
    await modal.get("#ai-key input").setValue("sk-new-key-1234");
    await modal.get('[data-test="ai-save"]').trigger("click");
    await flushPromises();

    // 浏览器演示态不联网：退化为直接保存，toast 提示未校验；弹窗收起
    expect(toastTexts(host)).toContain("未校验");
    host.unmount();
    expect(wrapper.find('[data-test="ai-modal"]').exists()).toBe(false);

    const state = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "{}");
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0].name).toBe("我的方案");
    expect(state.profiles[0].model).toBe("deepseek-chat");
    expect(state.activeId).toBe(state.profiles[0].id);
    // 落盘密钥非明文
    const raw = localStorage.getItem(PROFILES_KEY) ?? "";
    expect(raw).not.toContain("sk-new-key-1234");
    expect(raw).toContain("enc1:");
  });

  it("rejects saving a profile without a name", async () => {
    seedProfiles([PROFILE_A], "p-a");
    const wrapper = mountSettings();
    await flushPromises();

    await wrapper.get('[data-test="ai-profile-add"]').trigger("click");
    await wrapper.get('[data-test="ai-save"]').trigger("click");

    expect(wrapper.get('[data-test="ai-save-error"]').text()).toContain("名字");
    // 弹窗未收起，没有写入任何新方案
    expect(wrapper.find('[data-test="ai-modal"]').exists()).toBe(true);
    expect(JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "{}").profiles).toHaveLength(1);
  });

  it("edits an existing profile from the row menu with prefilled fields", async () => {
    seedProfiles([PROFILE_A, PROFILE_B], "p-a");
    const wrapper = mountSettings();
    await flushPromises();

    await wrapper.get('[data-test="ai-profile-menu"]').trigger("click");
    await wrapper.get('[data-test="ai-profile-edit"]').trigger("click");

    const modal = wrapper.get('[data-test="ai-modal"]');
    expect((modal.get('[data-test="ai-name"]').element as HTMLInputElement).value).toBe(PROFILE_A.name);
    // 密钥默认 password 遮住，内联眼睛一键查看可显明文，再点回掩码
    expect((keyInput(modal).element as HTMLInputElement).type).toBe("password");
    await modal.get('[data-test="ai-key-toggle"]').trigger("click");
    expect((keyInput(modal).element as HTMLInputElement).type).toBe("text");
    expect((keyInput(modal).element as HTMLInputElement).value).toBe(TEST_KEY);
    await modal.get('[data-test="ai-key-toggle"]').trigger("click");
    expect((keyInput(modal).element as HTMLInputElement).type).toBe("password");

    await modal.get('[data-test="ai-name"]').setValue("改个名字");
    await modal.get('[data-test="ai-save"]').trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("改个名字");
    const state = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "{}");
    expect(state.profiles).toHaveLength(2);
    expect(state.profiles.find((p: AiProfile) => p.id === "p-a").name).toBe("改个名字");
  });

  it("keeps the fetch button disabled in browser preview inside the modal", async () => {
    seedProfiles([PROFILE_A], "p-a");
    const wrapper = mountSettings();
    await flushPromises();

    await wrapper.get('[data-test="ai-profile-add"]').trigger("click");
    expect(wrapper.get('[data-test="ai-modal"]').text()).toContain("模型 ID");
    expect(wrapper.get('[data-test="ai-models-fetch"]').attributes("disabled")).toBeDefined();
  });

  it("deletes a profile after the danger confirm and falls back the active one", async () => {
    mockConfirm.mockResolvedValue(true);
    seedProfiles([PROFILE_A, PROFILE_B], "p-a");
    const wrapper = mountSettings();
    const host = mount(ToastHost);
    await flushPromises();

    // 第一张卡是当前方案 p-a：打开 ⋯ 菜单 → 删除 → 全局危险确认（mock 通过）
    await wrapper.get('[data-test="ai-profile-menu"]').trigger("click");
    await wrapper.get('[data-test="ai-profile-delete"]').trigger("click");
    await flushPromises();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll('[data-test="ai-profile"]')).toHaveLength(1);
    expect(toastTexts(host)).toContain("已删除");
    host.unmount();
    // 删的是当前方案 → 回落到剩余的首个已配置方案 p-b
    const state = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "{}");
    expect(state.activeId).toBe("p-b");
  });

  it("keeps the profile when the danger confirm is cancelled", async () => {
    mockConfirm.mockResolvedValue(false);
    seedProfiles([PROFILE_A, PROFILE_B], "p-a");
    const wrapper = mountSettings();
    await flushPromises();

    await wrapper.get('[data-test="ai-profile-menu"]').trigger("click");
    await wrapper.get('[data-test="ai-profile-delete"]').trigger("click");
    await flushPromises();

    expect(wrapper.findAll('[data-test="ai-profile"]')).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "{}").activeId).toBe("p-a");
  });
});
