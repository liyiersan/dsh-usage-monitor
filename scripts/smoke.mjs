/**
 * 服务端插件冒烟测试：用 mock 的 cordis 上下文直接驱动 apply()，
 * 验证「路由注册 → 余额查询 → 上报累计」整条链路，无需重启 DSH。
 *
 * 用法（在工作区跑，账本写到临时 DSH_HOME，避免污染真实账本）：
 *   node scripts/smoke.mjs
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

// ── 测试环境：临时 DSH_HOME + 从真实凭据文件读 key ──────────────────────
const tempHome = await mkdtemp(join(tmpdir(), 'usage-monitor-smoke-'));
process.env.DSH_HOME = tempHome;

const credPath = join(homedir(), '.dsh', '.credentials.yaml');
/** 真实 API key（从凭据文件读取，仅用于本次冒烟测试，不打印）。 */
let apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
	const text = await readFile(credPath, 'utf8').catch(() => '');
	apiKey = text.match(/DEEPSEEK_API_KEY:\s*(\S+)/)?.[1];
}
console.log(apiKey ? '已取得 API key（长度 ' + apiKey.length + '）' : '⚠ 未取得 API key');

// ── mock cordis ctx ────────────────────────────────────────────────────
const routes = new Map();
const effects = [];
const ctx = {
	logger: { warn: (...a) => console.log('[warn]', ...a), debug: () => {} },
	credentials: {
		resolve: async (ref) => {
			console.log(`  · credentials.resolve(${ref})`);
			return apiKey ? { value: apiKey } : undefined;
		},
	},
	webServer: {
		register: (route) => {
			if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
			routes.set(route.path, route);
			console.log(`  · 注册路由 ${route.kind} ${route.path}`);
			return () => routes.delete(route.path);
		},
	},
	effect: (fn, label) => {
		const disposer = fn();
		effects.push({ label, disposer });
		return disposer;
	},
};

apply(ctx);
console.log(`\n注册的路由数: ${routes.size}`);

/** 造一个响应对象。 */
function mockRes() {
	return {
		statusCode: 0,
		headers: {},
		body: '',
		writeHead(status, headers) {
			this.statusCode = status;
			Object.assign(this.headers, headers ?? {});
		},
		end(body) {
			this.body = body ?? '';
		},
	};
}

/** 造一个请求对象（EventEmitter 风格，够 handler 用）。 */
function mockReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
	const listeners = {};
	return {
		method,
		url,
		headers,
		on(event, cb) {
			(listeners[event] ??= []).push(cb);
			return this;
		},
		destroy() {},
		// 手动触发（模拟数据到达与结束）
		_emit(event, payload) {
			for (const cb of listeners[event] ?? []) cb(payload);
		},
	};
}

// ── 1. GET /usage-monitor/data ─────────────────────────────────────────
console.log('\n[1] GET /usage-monitor/data');
{
	const route = routes.get('/usage-monitor/data');
	const res = mockRes();
	await route.handler(mockReq({ method: 'GET', url: '/usage-monitor/data' }), res);
	const payload = JSON.parse(res.body);
	console.log('  HTTP', res.statusCode);
	console.log('  balance:', JSON.stringify(payload.balance));
	console.log('  tier:', JSON.stringify(payload.tier));
	console.log('  totals:', JSON.stringify({ costCNY: payload.totals.costCNY, sessionCount: payload.totals.sessionCount }));
	console.log('  pricing keys:', Object.keys(payload.pricing).join(', '));
	if (payload.balance?.state !== 'ok') {
		console.log('  ⚠ 余额未取到（state=' + payload.balance?.state + '）：' + (payload.balance?.error ?? ''));
	} else {
		console.log('  ✅ 余额查询成功：' + payload.balance.currency + ' ' + payload.balance.total);
	}
}

// ── 2. POST /usage-monitor/report（增量计价 + 跨会话累计） ──────────────
console.log('\n[2] POST /usage-monitor/report');
{
	const route = routes.get('/usage-monitor/report');
	const post = async (payload, contentType = 'application/json') => {
		const req = mockReq({ method: 'POST', headers: { 'content-type': contentType } });
		const res = mockRes();
		const promise = route.handler(req, res);
		req._emit('data', Buffer.from(JSON.stringify(payload)));
		req._emit('end');
		await promise;
		return { status: res.statusCode, payload: JSON.parse(res.body || '{}') };
	};

	// 会话 A 第一次上报：Flash，1M 命中 + 60k 未命中 + 40k 输出
	const first = await post({
		sessionId: 'smoke-session-a',
		model: 'deepseek-flash',
		usage: { cacheReadTokens: 1_000_000, uncachedInputTokens: 60_000, outputTokens: 40_000 },
	});
	console.log('  第一次上报 →', first.status, '本会话累计金额:', first.payload.costCNY?.toFixed(6), '总累计:', first.payload.totals?.costCNY?.toFixed(6));

	// 同一会话再上报（总量增长 500k 命中）：应只对增量计价
	const second = await post({
		sessionId: 'smoke-session-a',
		model: 'deepseek-flash',
		usage: { cacheReadTokens: 1_500_000, uncachedInputTokens: 60_000, outputTokens: 40_000 },
	});
	console.log('  第二次上报 →', second.status, '本会话累计金额:', second.payload.costCNY?.toFixed(6));

	// 重复上报同样内容：不得重复计价（单调性保护）
	const third = await post({
		sessionId: 'smoke-session-a',
		model: 'deepseek-flash',
		usage: { cacheReadTokens: 1_500_000, uncachedInputTokens: 60_000, outputTokens: 40_000 },
	});
	console.log('  重复上报 →', third.status, '本会话累计金额:', third.payload.costCNY?.toFixed(6), '(应与第二次相同)');

	// 第二个会话：V4-Pro
	const other = await post({
		sessionId: 'smoke-session-b',
		model: 'deepseek-v4-pro',
		usage: { cacheReadTokens: 100_000, uncachedInputTokens: 10_000, outputTokens: 5_000 },
	});
	console.log('  另一会话(V4-Pro) →', other.status, '总累计:', other.payload.totals?.costCNY?.toFixed(6), '会话数:', other.payload.totals?.sessionCount);

	// 媒体类型防御
	const bad = await post({ sessionId: 'x' }, 'text/plain');
	console.log('  非 JSON 媒体类型 →', bad.status, '(应为 415)');

	// 校验：重复上报未重复计价
	const ok = Math.abs(third.payload.costCNY - second.payload.costCNY) < 1e-12;
	console.log(ok ? '  ✅ 幂等保护生效（重复上报未重复计价）' : '  ❌ 重复上报导致重复计价');

	// 手算校验第一次：命中 1M×0.02/1e6=0.02 + 未命中 60k×1/1e6=0.06 + 输出 40k×4/1e6=0.16
	const at = new Date();
	const beijing = new Date(at.getTime() + 8 * 3600_000);
	const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
	const day = beijing.getUTCDay();
	const peak = day !== 0 && day !== 6 && ((minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080));
	const expected = peak ? 0.04 + 0.12 + 0.32 : 0.02 + 0.06 + 0.16;
	console.log(`  手算第一次（${peak ? '高峰' : '空闲'}）：${expected} vs 实际 ${first.payload.costCNY?.toFixed(6)}`);
	console.log(Math.abs(first.payload.costCNY - expected) < 1e-9 ? '  ✅ 金额与手算一致' : '  ❌ 金额不符');

	// 按模型分桶（新功能）：flash / pro 的 token 与金额分别记账
	const flashBucket = first.payload.byModel?.['deepseek-flash'];
	const bucketTokens = flashBucket
		? flashBucket.usage.uncachedInputTokens + flashBucket.usage.cacheReadTokens + flashBucket.usage.outputTokens
		: 0;
	console.log(
		`  会话 A 分桶: [${Object.keys(first.payload.byModel ?? {}).join(', ')}] flash 桶 ¥${flashBucket?.costCNY?.toFixed(6)} / ${bucketTokens} tokens`,
	);
	console.log(flashBucket ? '  ✅ 按模型分桶生效' : '  ❌ 分桶缺失');

	const proBucket = other.payload.byModel?.['deepseek-v4-pro'];
	console.log(`  会话 B 分桶: [${Object.keys(other.payload.byModel ?? {}).join(', ')}] pro 桶 ¥${proBucket?.costCNY?.toFixed(6)}`);
	console.log(proBucket ? '  ✅ 另一会话独立分桶（Pro）' : '  ❌ Pro 分桶缺失');

	const modelTotals = Object.entries(other.payload.totals?.byModel ?? {})
		.map(([key, value]) => `${key}=¥${Number(value.costCNY).toFixed(4)}/${value.tokenTotal}tok`)
		.join('  |  ');
	console.log('  累计按模型拆分:', modelTotals);
}

// ── 3. 账本落盘 ────────────────────────────────────────────────────────
console.log('\n[3] 账本落盘');
{
	await new Promise((r) => setTimeout(r, 500));
	// 触发一次 data 请求以推动 flush 节流
	const route = routes.get('/usage-monitor/data');
	const res = mockRes();
	await route.handler(mockReq({ method: 'GET', url: '/usage-monitor/data' }), res);
	const ledgerPath = join(tempHome, 'usage-monitor', 'ledger.json');
	const raw = await readFile(ledgerPath, 'utf8').catch(() => null);
	if (raw) {
		const parsed = JSON.parse(raw);
		console.log('  ✅ 账本已写入:', ledgerPath);
		console.log('  会话数:', Object.keys(parsed.sessions).length, '| 会话:', Object.keys(parsed.sessions).join(', '));
	} else {
		console.log('  ⚠ 账本文件尚未落盘（节流窗口内），路径应为:', ledgerPath);
	}
}

// ── 4. 收尾 ────────────────────────────────────────────────────────────
console.log('\n[4] 释放');
for (const { label, disposer } of effects) {
	if (typeof disposer === 'function') {
		try {
			disposer();
		} catch (error) {
			console.log(`  disposer(${label}) 抛错:`, error?.message);
		}
	}
}
console.log('路由剩余:', routes.size);
console.log('\n完成。临时 DSH_HOME =', tempHome);
