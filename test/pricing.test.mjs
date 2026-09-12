/**
 * 计费引擎测试：用官方定价手算结果对照。
 * 运行：node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	cacheHitRate,
	computeCost,
	formatCNY,
	formatTokens,
	isPeak,
	normalizeModel,
	tierLabel,
	totalTokens,
	unitPrices,
	usageDelta,
} from '../lib/pricing.js';

// 2026-09-02 是周三（北京时间）；以下用 UTC 表示对应的北京时间。
const WED_10AM_BJ = new Date('2026-09-02T02:00:00Z'); // 北京 10:00 → 高峰
const WED_1PM_BJ = new Date('2026-09-02T05:00:00Z'); // 北京 13:00 → 午休空闲
const WED_3PM_BJ = new Date('2026-09-02T07:00:00Z'); // 北京 15:00 → 高峰
const WED_859AM_BJ = new Date('2026-09-02T00:59:00Z'); // 北京 08:59 → 空闲
const WED_6PM_BJ = new Date('2026-09-02T10:00:00Z'); // 北京 18:00 → 空闲（区间右开）
const SAT_10AM_BJ = new Date('2026-09-05T02:00:00Z'); // 周六 10:00 → 空闲

test('高峰时段按北京时间周一至周五 9-12 / 14-18 判定', () => {
	assert.equal(isPeak(WED_10AM_BJ), true);
	assert.equal(isPeak(WED_3PM_BJ), true);
	assert.equal(isPeak(WED_1PM_BJ), false, '12:00-14:00 午休应为空闲');
	assert.equal(isPeak(WED_859AM_BJ), false, '9:00 之前应为空闲');
	assert.equal(isPeak(WED_6PM_BJ), false, '18:00 整应为空闲（右开区间）');
	assert.equal(isPeak(SAT_10AM_BJ), false, '周末应为空闲');
	assert.equal(tierLabel(WED_10AM_BJ), '高峰时段');
	assert.equal(tierLabel(WED_859AM_BJ), '空闲时段（半价）');
});

test('模型名归一化', () => {
	assert.equal(normalizeModel('deepseek-flash'), 'deepseek-flash');
	assert.equal(normalizeModel('DeepSeek-V4-Flash High'), 'deepseek-flash');
	assert.equal(normalizeModel('deepseek-v4-flash-vision-exp'), 'deepseek-flash');
	assert.equal(normalizeModel('deepseek-v4-pro'), 'deepseek-v4-pro');
	assert.equal(normalizeModel('DeepSeek-V4-Pro-0813'), 'deepseek-v4-pro');
	assert.equal(normalizeModel(undefined), 'deepseek-flash', '未识别时兜底 Flash');
});

test('Flash 空闲价：手算对照', () => {
	// 空闲价：命中 0.02 / 未命中 1 / 输出 4（元每百万）
	const r = computeCost(
		{ uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
		{ model: 'deepseek-flash', at: WED_859AM_BJ },
	);
	assert.equal(r.peak, false);
	assert.equal(r.parts.uncachedInput, 1);
	assert.equal(r.parts.cacheRead, 0.02);
	assert.equal(r.parts.output, 4);
	assert.equal(Number(r.costCNY.toFixed(6)), 5.02);
});

test('Flash 高峰价：空闲的一半折扣消失，价格翻倍', () => {
	const r = computeCost(
		{ uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
		{ model: 'deepseek-flash', at: WED_10AM_BJ },
	);
	assert.equal(r.peak, true);
	assert.equal(r.parts.uncachedInput, 2);
	assert.equal(r.parts.cacheRead, 0.04);
	assert.equal(r.parts.output, 8);
	assert.equal(Number(r.costCNY.toFixed(6)), 10.04);
});

test('V4-Pro 空闲价：手算对照', () => {
	const r = computeCost(
		{ uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
		{ model: 'deepseek-v4-pro', at: WED_859AM_BJ },
	);
	assert.equal(r.parts.uncachedInput, 4.5);
	assert.equal(r.parts.cacheRead, 0.15);
	assert.equal(r.parts.output, 13.5);
	assert.equal(Number(r.costCNY.toFixed(6)), 18.15);
});

test('cacheWrite 按未命中单价计费（官方未单列，取保守值）', () => {
	const r = computeCost(
		{ cacheWriteTokens: 1_000_000 },
		{ model: 'deepseek-flash', at: WED_859AM_BJ },
	);
	assert.equal(r.parts.cacheWrite, 1);
});

test('真实规模的会话花费量级合理（2M 输入 / 41.7k 输出）', () => {
	// 模拟界面底部那组数字：输入 2M（97% 命中）、输出 41.7k，Flash 空闲时段
	const r = computeCost(
		{
			cacheReadTokens: 1_940_000,
			uncachedInputTokens: 60_000,
			outputTokens: 41_700,
		},
		{ model: 'deepseek-flash', at: WED_859AM_BJ },
	);
	// 命中 1.94M×0.02 = 0.0388；未命中 0.06M×1 = 0.06；输出 0.0417M×4 = 0.1668
	assert.equal(Number(r.costCNY.toFixed(4)), 0.2656);
	assert.ok(r.costCNY > 0.2 && r.costCNY < 0.35, '单位应为「元」而非「角/分」');
});

test('零用量成本为零', () => {
	const r = computeCost({}, { model: 'deepseek-flash', at: WED_10AM_BJ });
	assert.equal(r.costCNY, 0);
});

test('usageDelta 取增量且负值归零', () => {
	const prev = { uncachedInputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 50 };
	const next = { uncachedInputTokens: 150, cacheReadTokens: 500, cacheWriteTokens: 10, outputTokens: 50 };
	assert.deepEqual(usageDelta(prev, next), {
		uncachedInputTokens: 50,
		cacheReadTokens: 300,
		cacheWriteTokens: 10,
		outputTokens: 0,
	});
	assert.deepEqual(usageDelta(undefined, next), {
		uncachedInputTokens: 150,
		cacheReadTokens: 500,
		cacheWriteTokens: 10,
		outputTokens: 50,
	});
	assert.deepEqual(
		usageDelta(next, prev),
		{ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
		'回退时不得产生负增量');
});

test('辅助函数：总量、命中率、格式化', () => {
	assert.equal(totalTokens({ uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 }), 10);
	assert.equal(cacheHitRate({ uncachedInputTokens: 3, cacheReadTokens: 97 }), 0.97);
	assert.equal(cacheHitRate({}), null);
	assert.equal(formatCNY(0.2656), '¥0.27');
	assert.equal(formatCNY(0.0031), '¥0.0031');
	assert.equal(formatCNY(0), '¥0');
	assert.equal(formatTokens(2_100_000), '2.10M');
	assert.equal(formatTokens(41_700), '42k');
	assert.equal(formatTokens(950), '950');
});

test('空闲时段恰为高峰时段单价的一半（官方口径）', () => {
	for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
		const peak = unitPrices(model, true);
		const off = unitPrices(model, false);
		assert.equal(off.cacheHit * 2, peak.cacheHit, `${model} cacheHit`);
		assert.equal(off.cacheMiss * 2, peak.cacheMiss, `${model} cacheMiss`);
		assert.equal(off.output * 2, peak.output, `${model} output`);
	}
});
