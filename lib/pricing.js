/**
 * DeepSeek 计费引擎 —— 纯函数，无副作用，可独立测试。
 *
 * 定价来源：DeepSeek 官方 API 文档「模型 & 价格」页（2026 现行版）。
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 单位：元 / 百万 tokens。
 *
 * 时段规则（官方口径）：空闲时段价格为高峰时段的一半。
 *   高峰时段 = 北京时间 周一至周五 09:00-12:00 与 14:00-18:00，其余为空闲。
 *
 * 计费口径：
 *   token-meter 提供的是互不重叠的四个桶（uncachedInput / cacheRead / cacheWrite / output）。
 *   - uncachedInput（缓存未命中输入）按 cacheMiss 单价
 *   - cacheRead（缓存命中输入）按 cacheHit 单价（比未命中便宜 50 倍，是省钱关键）
 *   - cacheWrite（写入缓存的输入）官方未单列，按 cacheMiss 单价计（保守）
 *   - output 按 output 单价
 *
 * @module pricing
 */

/** 每百万 tokens 的价格（元）。 */
export const PRICING = {
	'deepseek-flash': {
		label: 'DeepSeek-V4.1-Flash',
		cacheHit: { offPeak: 0.02, peak: 0.04 },
		cacheMiss: { offPeak: 1, peak: 2 },
		output: { offPeak: 4, peak: 8 },
	},
	'deepseek-v4-pro': {
		label: 'DeepSeek-V4-Pro',
		cacheHit: { offPeak: 0.15, peak: 0.3 },
		cacheMiss: { offPeak: 4.5, peak: 9 },
		output: { offPeak: 13.5, peak: 27 },
	},
};

/** 未识别模型时使用的兜底定价档（取 Flash，并在界面标注为估算）。 */
export const FALLBACK_MODEL = 'deepseek-flash';

/** 高峰时段区间（北京时间，分钟数）。 */
const PEAK_WINDOWS = [
	[9 * 60, 12 * 60],
	[14 * 60, 18 * 60],
];

/** 北京时间相对 UTC 的偏移（毫秒）。 */
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 把 DSH 里出现的各种模型名归一化到定价档 key。
 * 例：'deepseek-v4-flash-vision-exp' / 'DeepSeek-V4-Flash High' → 'deepseek-flash'
 * @param {string|undefined|null} model - 原始模型名。
 * @returns {string} 定价档 key（未识别时返回 {@link FALLBACK_MODEL}）。
 */
export function normalizeModel(model) {
	const raw = String(model ?? '').toLowerCase();
	if (raw.includes('pro')) return 'deepseek-v4-pro';
	if (raw.includes('flash')) return 'deepseek-flash';
	if (raw.includes('chat') || raw.includes('reasoner')) return 'deepseek-v4-pro';
	return FALLBACK_MODEL;
}

/**
 * 判断给定时刻是否处于高峰计价时段（北京时间，周一至周五）。
 * @param {Date} [at] - 时刻，默认当前时间。
 * @returns {boolean} 高峰时段为 true。
 */
export function isPeak(at = new Date()) {
	const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS);
	const day = beijing.getUTCDay();
	if (day === 0 || day === 6) return false;
	const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
	return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to);
}

/**
 * 取某模型在某时段下的三项单价。
 * @param {string} modelKey - 已归一化的定价档 key。
 * @param {boolean} peak - 是否高峰时段。
 * @returns {{cacheHit:number, cacheMiss:number, output:number}} 元/百万 tokens。
 */
export function unitPrices(modelKey, peak) {
	const tier = PRICING[modelKey] ?? PRICING[FALLBACK_MODEL];
	const pick = (row) => (peak ? row.peak : row.offPeak);
	return {
		cacheHit: pick(tier.cacheHit),
		cacheMiss: pick(tier.cacheMiss),
		output: pick(tier.output),
	};
}

/**
 * 计算一批 token 用量的费用。
 * @param {object} usage - 用量（token 数，四桶互不重叠）。
 * @param {number} [usage.uncachedInputTokens] - 缓存未命中输入。
 * @param {number} [usage.cacheReadTokens] - 缓存命中输入。
 * @param {number} [usage.cacheWriteTokens] - 写入缓存的输入。
 * @param {number} [usage.outputTokens] - 输出（含推理）。
 * @param {object} [options] - 计价选项。
 * @param {string} [options.model] - 原始模型名。
 * @param {Date} [options.at] - 计价时刻（决定高峰/空闲）。
 * @returns {{costCNY:number, modelKey:string, peak:boolean, tokens:object, parts:object}}
 *   costCNY 为总额（元）；parts 为各项费用明细；tokens 为归一化后的四桶 token 数。
 */
export function computeCost(usage = {}, options = {}) {
	const peak = isPeak(options.at ?? new Date());
	const modelKey = normalizeModel(options.model);
	const price = unitPrices(modelKey, peak);
	const tokens = {
		uncachedInput: Math.max(0, Number(usage.uncachedInputTokens ?? 0)),
		cacheRead: Math.max(0, Number(usage.cacheReadTokens ?? 0)),
		cacheWrite: Math.max(0, Number(usage.cacheWriteTokens ?? 0)),
		output: Math.max(0, Number(usage.outputTokens ?? 0)),
	};
	const M = 1e6;
	const parts = {
		uncachedInput: (tokens.uncachedInput / M) * price.cacheMiss,
		cacheRead: (tokens.cacheRead / M) * price.cacheHit,
		cacheWrite: (tokens.cacheWrite / M) * price.cacheMiss,
		output: (tokens.output / M) * price.output,
	};
	const costCNY = parts.uncachedInput + parts.cacheRead + parts.cacheWrite + parts.output;
	return { costCNY, modelKey, peak, tokens, parts };
}

/**
 * 由一次上报的「本会话累计用量」推出相对上次的增量用量（单调不减，负值归零）。
 * 用于跨时段精确累加：每次上报按当时时段的单价为增量计价。
 * @param {object} prev - 上次记录的累计用量。
 * @param {object} next - 本次上报的累计用量。
 * @returns {object} 增量用量（四桶）。
 */
export function usageDelta(prev, next) {
	const d = (key) =>
		Math.max(0, Number(next?.[key] ?? 0) - Number(prev?.[key] ?? 0));
	return {
		uncachedInputTokens: d('uncachedInputTokens'),
		cacheReadTokens: d('cacheReadTokens'),
		cacheWriteTokens: d('cacheWriteTokens'),
		outputTokens: d('outputTokens'),
	};
}

/**
 * 汇总四桶 token 总量。
 * @param {object} usage - 四桶用量。
 * @returns {number} token 总数。
 */
export function totalTokens(usage = {}) {
	return (
		Number(usage.uncachedInputTokens ?? 0) +
		Number(usage.cacheReadTokens ?? 0) +
		Number(usage.cacheWriteTokens ?? 0) +
		Number(usage.outputTokens ?? 0)
	);
}

/**
 * 缓存命中率（命中输入 / 全部输入），无输入时返回 null。
 * @param {object} usage - 四桶用量。
 * @returns {number|null} 0-1 之间的比率。
 */
export function cacheHitRate(usage = {}) {
	const input =
		Number(usage.uncachedInputTokens ?? 0) +
		Number(usage.cacheReadTokens ?? 0) +
		Number(usage.cacheWriteTokens ?? 0);
	if (input <= 0) return null;
	return Number(usage.cacheReadTokens ?? 0) / input;
}

/** 金额格式化：小额用 4 位小数，避免显示成一堆 0.00。 */
export function formatCNY(value) {
	const n = Number(value ?? 0);
	if (!Number.isFinite(n)) return '¥--';
	if (n === 0) return '¥0';
	if (Math.abs(n) < 0.01) return `¥${n.toFixed(4)}`;
	return `¥${n.toFixed(2)}`;
}

/** token 数格式化：12.3k / 2.1M。 */
export function formatTokens(value) {
	const n = Number(value ?? 0);
	if (!Number.isFinite(n)) return '--';
	if (n < 1000) return String(n);
	if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
	return `${(n / 1e6).toFixed(2)}M`;
}

/** 当前计价时段的可读标签。 */
export function tierLabel(at = new Date()) {
	return isPeak(at) ? '高峰时段' : '空闲时段（半价）';
}
