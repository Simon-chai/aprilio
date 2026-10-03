/**
 * localStorage JSON 读写统一入口。
 *
 * 业务模块各自手写「环境守卫 + try/parse/sanitize + 回落」的模板散布多处，
 * 这里收敛骨架；键内数据的清洗（sanitize）仍由各业务自带的 parse 回调负责。
 */

/**
 * 读取 localStorage 的 JSON 值。
 * 环境不可用 / 键缺失 / JSON 损坏 / parse 抛错，一律返回 fallback()。
 *
 * 注意：键缺失时也会走 fallback 且可能抛错的话，请在 fallback 内自行兜底
 * （如 ai.ts 的旧配置迁移，fallback 带副作用，就不适合套这个骨架）。
 */
export function readJsonStorage<T>(
  key: string,
  fallback: () => T,
  parse: (raw: string) => T = (raw) => JSON.parse(raw) as T,
): T {
  if (typeof localStorage === "undefined") return fallback();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback();
    return parse(raw);
  } catch {
    return fallback();
  }
}
