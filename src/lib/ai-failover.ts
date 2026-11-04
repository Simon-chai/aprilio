/**
 * 多模型自动切换（failover）。
 *
 * 行为约定（docs/MODEL_FAILOVER.md）：
 * - 候选顺序：当前方案 → 其它已配置方案（按方案列表顺序），缺模型 / 缺密钥的方案不参与
 * - 一次请求失败（网络、限流、额度、密钥、超时…）就自动改试下一个候选，直到成功
 * - 成功的是备用方案时，把「当前方案」持久切过去（界面胶囊同步刷新），直到用户手动切回
 * - 失败方案进入冷却（默认 5 分钟），冷却期内不参与备用顺序，到期自动恢复；
 *   当前方案永远排第一，用户手动选的模型不会被冷却挡住
 * - 已经向界面推过流式增量就不再切换：换模型会让半截文本与新回复错乱
 * - 参数类错误（序列化 / 字段缺失）换模型也解决不了，直接抛错
 *
 * 全自动、无开关：所有 AI 调用（通用生成、裸 chat、润色、Agent）默认经过这里。
 */
import {
  aiProfileToConfig,
  isAiConfigured,
  loadAiProfiles,
  setActiveAiProfile,
  type AiConfig,
  type AiProfile,
} from "./ai";
import { errorMessage } from "./error-message";
import { tauriLlm, type AgentLlm, type AgentMessage, type LlmResponse, type ToolDefinition } from "./llm";
import { logWarn } from "./logger";

/** 失败方案的冷却时长：期间不参与备用顺序，到期自动恢复 */
export const AI_FAILOVER_COOLDOWN_MS = 5 * 60 * 1000;

/** 流式请求等待「首个增量」的上限：模型完全没响应时据此切换 */
export const AI_FAILOVER_FIRST_BYTE_TIMEOUT_MS = 90 * 1000;

/** 非流式请求整次上限（导入识别等一次性任务） */
export const AI_FAILOVER_TOTAL_TIMEOUT_MS = 4 * 60 * 1000;

/** 冷却表存本机：{ cooldowns: { [profileId]: 到期时间戳 } } */
const FAILOVER_STORAGE_KEY = "aprilio.ai.failover.v1";

/** 参数 / 协议类错误：换模型同样会失败，不做切换 */
const NON_FAILOVER_ERROR = /serializ|invalid args|missing field|参数异常/i;

/** 自动切换的一个候选：profileId 为空表示调用方临时传入、不在方案集里的配置 */
export interface AiFailoverCandidate {
  profileId: string | null;
  config: AiConfig;
}

export interface AiFailoverOptions {
  /** 失败方案冷却时长，默认 AI_FAILOVER_COOLDOWN_MS */
  cooldownMs?: number;
  /** 流式首字超时，默认 AI_FAILOVER_FIRST_BYTE_TIMEOUT_MS */
  firstByteTimeoutMs?: number;
  /** 非流式整次超时，默认 AI_FAILOVER_TOTAL_TIMEOUT_MS */
  totalTimeoutMs?: number;
}

type CooldownMap = Record<string, number>;

function readCooldowns(now: number): CooldownMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(FAILOVER_STORAGE_KEY);
    if (!raw) return {};
    const list = (JSON.parse(raw) as { cooldowns?: unknown } | null)?.cooldowns;
    if (!list || typeof list !== "object") return {};
    const out: CooldownMap = {};
    for (const [id, until] of Object.entries(list as Record<string, unknown>)) {
      // 顺手清理过期项，避免冷却表越存越大
      if (typeof until === "number" && Number.isFinite(until) && until > now) out[id] = until;
    }
    return out;
  } catch {
    return {};
  }
}

function writeCooldowns(map: CooldownMap): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FAILOVER_STORAGE_KEY, JSON.stringify({ cooldowns: map }));
  } catch {
    /* 存储不可写时只是失去冷却记忆，不影响切换本身 */
  }
}

/** 某方案是否还在冷却期 */
export function isProfileCooling(profileId: string): boolean {
  const now = Date.now();
  return (readCooldowns(now)[profileId] ?? 0) > now;
}

/** 标记方案失败，冷却 ms 毫秒（到期自动恢复为候选） */
export function markProfileCooling(profileId: string, ms = AI_FAILOVER_COOLDOWN_MS): void {
  if (!profileId || !(ms > 0)) return;
  const now = Date.now();
  const map = readCooldowns(now);
  map[profileId] = now + ms;
  writeCooldowns(map);
}

/** 清除某方案的冷却（成功调用 / 手动切回时） */
export function clearProfileCooldown(profileId: string): void {
  if (!profileId) return;
  const map = readCooldowns(Date.now());
  if (!(profileId in map)) return;
  delete map[profileId];
  writeCooldowns(map);
}

/** 方案展示名：没起名字时退回模型 ID */
function profileLabel(profile: AiProfile): string {
  return profile.name.trim() || profile.model;
}

/**
 * 构建本次请求的候选顺序：当前方案优先，其余已配置方案按列表顺序跟上；
 * 冷却中的方案只在「备用位」被跳过，不会挡住当前方案。
 * 没有任何可用方案时，退回调用方传入的配置（至少让错误如实暴露）。
 */
export function failoverCandidates(preferred: AiConfig): AiFailoverCandidate[] {
  const state = loadAiProfiles();
  const configured = state.profiles.filter(isAiConfigured);
  if (configured.length === 0) return [{ profileId: null, config: preferred }];

  const active = configured.find((p) => p.id === state.activeId);
  const toCandidate = (p: AiProfile): AiFailoverCandidate => ({
    profileId: p.id,
    config: aiProfileToConfig(p),
  });
  if (!active) {
    // 当前方案不可用（缺模型 / 缺密钥）：先按列表顺序试，全部冷却时忽略冷却
    const available = configured.filter((p) => !isProfileCooling(p.id));
    return (available.length ? available : configured).map(toCandidate);
  }
  const rest = configured.filter((p) => p.id !== active.id && !isProfileCooling(p.id));
  return [active, ...rest].map(toCandidate);
}

/** 失败是否值得换一个模型再试（参数 / 协议类错误不切换） */
export function isFailoverWorthy(error: unknown): boolean {
  return !NON_FAILOVER_ERROR.test(errorMessage(error));
}

/** 成功时持久切换当前方案（是备用方案才切），并清掉它的冷却记录 */
function adoptProfile(candidate: AiFailoverCandidate): void {
  if (!candidate.profileId) return;
  clearProfileCooldown(candidate.profileId);
  const state = loadAiProfiles();
  const target = state.profiles.find((p) => p.id === candidate.profileId);
  if (!target || state.activeId === candidate.profileId) return;
  setActiveAiProfile(candidate.profileId);
  logWarn(`[ai] 当前模型方案不可用，已自动切换到「${profileLabel(target)}」`);
}

/** 全部候选失败时的聚合错误：保留首个（用户所选模型）的原因，再说明尝试次数 */
function aggregateError(primary: unknown, attempts: number): Error {
  const cause = errorMessage(primary).trim().split("\n")[0];
  if (attempts <= 1) return new Error(cause || "AI 请求失败，请检查模型配置与网络。");
  return new Error(
    `已自动尝试 ${attempts} 个模型方案，全部失败：${cause || "未知错误"}`,
  );
}

/**
 * 把任意 LLM 包成「失败自动换下一个方案」的 LLM。
 * base 供单测注入替身，缺省走桌面端 Rust 传输。
 */
export function createFailoverLlm(base: AgentLlm = tauriLlm(), options: AiFailoverOptions = {}): AgentLlm {
  const cooldownMs = options.cooldownMs ?? AI_FAILOVER_COOLDOWN_MS;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? AI_FAILOVER_FIRST_BYTE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? AI_FAILOVER_TOTAL_TIMEOUT_MS;

  return {
    async chat(req: {
      system: string;
      messages: AgentMessage[];
      tools: ToolDefinition[];
      config: AiConfig;
      onDelta?: (text: string) => void;
    }): Promise<LlmResponse> {
      const candidates = failoverCandidates(req.config);
      let primaryError: unknown = null;

      for (const candidate of candidates) {
        let current = true;
        let emitted = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutMs = req.onDelta ? firstByteTimeoutMs : totalTimeoutMs;
        const clearTimer = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        };
        // 超时只是放弃本次候选：底层 invoke 无法取消，迟到的事件由 current 挡掉
        const timeoutError = new Error(
          `AI 请求超时：等待模型响应超过 ${Math.round(timeoutMs / 1000)} 秒`,
        );
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeoutError), timeoutMs);
        });
        const onDelta = req.onDelta
          ? (text: string) => {
              if (!current || !text) return;
              emitted = true;
              clearTimer(); // 流式：只等首字，之后不再限时
              req.onDelta?.(text);
            }
          : undefined;

        try {
          const result = await Promise.race([
            base.chat({ ...req, config: candidate.config, onDelta }),
            deadline,
          ]);
          current = false;
          clearTimer();
          adoptProfile(candidate);
          return result;
        } catch (e) {
          current = false;
          clearTimer();
          if (primaryError === null) primaryError = e;
          // 已输出半截内容 / 参数类错误：换模型只会更糟，原样抛给调用方
          if (emitted || !isFailoverWorthy(e)) throw e;
          if (candidate.profileId) {
            const profile = loadAiProfiles().profiles.find((p) => p.id === candidate.profileId);
            markProfileCooling(candidate.profileId, cooldownMs);
            logWarn(
              `[ai] 模型方案「${profile ? profileLabel(profile) : candidate.profileId}」请求失败，已自动尝试下一个方案`,
              errorMessage(e).slice(0, 200),
            );
          }
        }
      }

      throw aggregateError(primaryError, candidates.length);
    },
  };
}
