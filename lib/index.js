/**
 * dsh-usage-monitor —— 宿主（Web 服务端）半。
 *
 * 职责：
 *   1. 定时查询 DeepSeek 账户余额（GET /user/balance，密钥经 ctx.credentials 解析）；
 *   2. 维护跨会话用量账本（增量计价，跨高峰/空闲时段精确累加）；
 *   3. 通过 ctx.webServer 暴露两个本地 HTTP 端点，供客户端插件读取/上报：
 *        GET  /usage-monitor/data    余额 + 定价表 + 累计汇总
 *        POST /usage-monitor/report  客户端上报某会话的累计用量
 *
 * 设计约束：
 *   - 任何网络/磁盘异常都不得影响 DSH 本体：全部捕获、降级、记录日志；
 *   - 账本写入节流，避免频繁落盘；
 *   - 端点仅监听回环地址（DSH 的 webServer 默认姿态），POST 要求 JSON 媒体类型，
 *     从而挡住跨站「简单请求」（与 DSH 自身 /api 的做法一致）。
 *
 * @module @local/dsh-usage-monitor
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
	PRICING,
	cacheHitRate,
	computeCost,
	isPeak,
	normalizeModel,
	tierLabel,
	totalTokens,
	usageDelta,
} from './pricing.js';

/** Cordis 插件名。 */
export const name = 'usage-monitor';

/** 依赖的服务：Web 服务器（注册端点）与凭据（解析 API key）。 */
export const inject = ['webServer', 'credentials'];

/** DeepSeek 余额接口。 */
const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';
/** 余额缓存时长（毫秒）。 */
const BALANCE_TTL_MS = 60_000;
/** 余额请求超时（毫秒）。 */
const BALANCE_TIMEOUT_MS = 15_000;
/** 账本落盘节流（毫秒）。 */
const LEDGER_FLUSH_MS = 5_000;
/** 数据端点路径。 */
const ROUTE_DATA = '/usage-monitor/data';
/** 上报端点路径。 */
const ROUTE_REPORT = '/usage-monitor/report';

/** DSH 主目录。 */
function dshHome() {
	return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 空账本。 */
function emptyLedger() {
	return { version: 1, since: new Date().toISOString(), sessions: {} };
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store',
	});
	res.end(body);
}

/** 读取请求体（带大小上限，避免被本地大请求拖垮）。 */
function readBody(req, limit = 64 * 1024) {
	return new Promise((resolvePromise, rejectPromise) => {
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				rejectPromise(new Error('payload too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
		req.on('error', rejectPromise);
	});
}

/**
 * 插件主体。
 * @param {object} ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
	const dir = join(dshHome(), 'usage-monitor');
	const ledgerPath = join(dir, 'ledger.json');
	const logger = ctx.logger ?? console;

	/** @type {{version:number, since:string, sessions:Record<string, any>}|null} */
	let ledger = null;
	let ledgerReady = false;
	let ledgerDirty = false;
	let lastFlush = 0;
	let flushing = null;

	/** 余额缓存。 */
	let balance = { state: 'loading', at: null };

	/** 从磁盘装载账本（只尝试一次）。 */
	async function ensureLedger() {
		if (ledgerReady) return ledger;
		ledgerReady = true;
		try {
			const raw = await readFile(ledgerPath, 'utf8');
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
				ledger = parsed;
			} else {
				ledger = emptyLedger();
			}
		} catch (error) {
			if (error?.code !== 'ENOENT') logger.warn?.('[usage-monitor] 账本读取失败，将重建:', error?.message ?? error);
			ledger = emptyLedger();
		}
		return ledger;
	}

	/** 原子落盘（节流）。 */
	async function flushLedger(force = false) {
		if (!ledger) return;
		const now = Date.now();
		if (!force && now - lastFlush < LEDGER_FLUSH_MS) {
			ledgerDirty = true;
			return;
		}
		if (flushing) return flushing;
		ledgerDirty = false;
		lastFlush = now;
		flushing = (async () => {
			try {
				await mkdir(dir, { recursive: true });
				const tmp = `${ledgerPath}.tmp`;
				await writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8');
				await rename(tmp, ledgerPath);
			} catch (error) {
				logger.warn?.('[usage-monitor] 账本写入失败:', error?.message ?? error);
			} finally {
				flushing = null;
			}
		})();
		return flushing;
	}

	/** 定期刷盘（配合节流，把延迟写入补上）。 */
	const flushTimer = setInterval(() => {
		if (ledgerDirty) void flushLedger(true);
	}, LEDGER_FLUSH_MS);
	flushTimer.unref?.();

	/** 解析 DeepSeek API key：优先凭据服务，回退进程环境。 */
	async function resolveApiKey() {
		try {
			const resolved = await ctx.credentials?.resolve?.('DEEPSEEK_API_KEY');
			if (resolved?.value) return resolved.value;
		} catch (error) {
			logger.debug?.('[usage-monitor] 凭据解析失败，回退环境变量:', error?.message ?? error);
		}
		return process.env.DEEPSEEK_API_KEY || undefined;
	}

	/** 刷新余额（带 TTL 与并发合并）。 */
	let balanceInflight = null;
	async function refreshBalance(force = false) {
		const fresh = balance.at !== null && Date.now() - Date.parse(balance.at) < BALANCE_TTL_MS;
		if (!force && (fresh || balanceInflight)) return balanceInflight ?? balance;
		balanceInflight = (async () => {
			try {
				const key = await resolveApiKey();
				if (!key) {
					balance = { state: 'no-credential', at: new Date().toISOString() };
					return balance;
				}
				const response = await fetch(BALANCE_ENDPOINT, {
					headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
					signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
				});
				const text = await response.text();
				if (!response.ok) {
					balance = {
						state: 'error',
						at: new Date().toISOString(),
						error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
						previous: balance.state === 'ok' ? balance : undefined,
					};
					return balance;
				}
				const parsed = JSON.parse(text);
				const info = Array.isArray(parsed?.balance_infos) ? parsed.balance_infos[0] : undefined;
				if (!info) {
					balance = { state: 'error', at: new Date().toISOString(), error: '响应中没有 balance_infos' };
					return balance;
				}
				balance = {
					state: 'ok',
					at: new Date().toISOString(),
					isAvailable: parsed.is_available !== false,
					currency: info.currency ?? 'CNY',
					total: Number(info.total_balance ?? 0),
					granted: Number(info.granted_balance ?? 0),
					toppedUp: Number(info.topped_up_balance ?? 0),
				};
				return balance;
			} catch (error) {
				balance = {
					state: 'error',
					at: new Date().toISOString(),
					error: error?.message ?? String(error),
					previous: balance.state === 'ok' ? balance : undefined,
				};
				return balance;
			} finally {
				balanceInflight = null;
			}
		})();
		return balanceInflight;
	}

	/** 汇总账本（含按模型的准确拆分）。 */
	function summarize() {
		const sessions = ledger?.sessions ?? {};
		const ids = Object.keys(sessions);
		const tokens = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
		let costCNY = 0;
		const byModel = {};
		/** 归集一个模型桶。 */
		const addModel = (key, bucketUsage, bucketCost) => {
			const entry = (byModel[key] = byModel[key] ?? { costCNY: 0, tokenTotal: 0, sessions: 0 });
			entry.costCNY += Number(bucketCost ?? 0);
			entry.tokenTotal += totalTokens(bucketUsage ?? {});
			entry.sessions += 1;
		};
		for (const id of ids) {
			const record = sessions[id];
			const usage = record?.usage ?? {};
			for (const bucket of Object.keys(tokens)) tokens[bucket] += Number(usage[bucket] ?? 0);
			costCNY += Number(record?.costCNY ?? 0);
			// 新记录：按模型分桶汇总（准确——跨模型的会话各归各的）。
			const buckets = record?.byModel ?? {};
			if (Object.keys(buckets).length > 0) {
				for (const [key, bucket] of Object.entries(buckets)) addModel(key, bucket?.usage, bucket?.costCNY);
			} else {
				// 旧记录（本功能上线前写入）：没有模型维度，退回按末尾模型归集。
				addModel(record?.model || 'unknown', usage, record?.costCNY);
			}
		}
		return {
			costCNY,
			sessionCount: ids.length,
			tokens,
			tokenTotal: totalTokens(tokens),
			cacheHitRate: cacheHitRate(tokens),
			byModel,
			lastUpdatedAt: ids
				.map((id) => sessions[id]?.updatedAt)
				.filter(Boolean)
				.sort()
				.at(-1) ?? null,
			since: ledger?.since ?? null,
		};
	}

	/** 处理一次客户端上报：按增量计价并累计。 */
	async function handleReport(payload) {
		const book = await ensureLedger();
		const sessionId = String(payload?.sessionId ?? '').trim();
		if (!sessionId) return { ok: false, error: 'missing sessionId' };
		const usage = {
			uncachedInputTokens: Number(payload?.usage?.uncachedInputTokens ?? 0),
			cacheReadTokens: Number(payload?.usage?.cacheReadTokens ?? 0),
			cacheWriteTokens: Number(payload?.usage?.cacheWriteTokens ?? 0),
			outputTokens: Number(payload?.usage?.outputTokens ?? 0),
		};
		const model = String(payload?.model ?? '');
		const at = payload?.at ? new Date(payload.at) : new Date();
		const when = Number.isNaN(at.getTime()) ? new Date() : at;

		const prev = book.sessions[sessionId] ?? {
			model,
			usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
			costCNY: 0,
			createdAt: new Date().toISOString(),
		};
		// 单调性保护：用量只增不减，避免投影回退导致重复计价。
		const delta = usageDelta(prev.usage, usage);
		const { costCNY } = computeCost(delta, { model, at: when });
		// 按模型分桶：把**本次增量**的 token 与金额记到当前模型名下，
		// 这样"Flash 用了多少 / Pro 花了多少"可以分别看到（切换模型不影响历史桶）。
		const modelKey = normalizeModel(model);
		const prevBuckets = prev.byModel ?? {};
		const prevBucket = prevBuckets[modelKey] ?? {
			usage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
			costCNY: 0,
		};
		const bucketUsage = {
			uncachedInputTokens: Number(prevBucket.usage?.uncachedInputTokens ?? 0) + delta.uncachedInputTokens,
			cacheReadTokens: Number(prevBucket.usage?.cacheReadTokens ?? 0) + delta.cacheReadTokens,
			cacheWriteTokens: Number(prevBucket.usage?.cacheWriteTokens ?? 0) + delta.cacheWriteTokens,
			outputTokens: Number(prevBucket.usage?.outputTokens ?? 0) + delta.outputTokens,
		};
		const byModel = {
			...prevBuckets,
			[modelKey]: { usage: bucketUsage, costCNY: Number(prevBucket.costCNY ?? 0) + costCNY },
		};
		book.sessions[sessionId] = {
			...prev,
			model: model || prev.model,
			usage,
			byModel,
			costCNY: Number(prev.costCNY ?? 0) + costCNY,
			updatedAt: new Date().toISOString(),
		};
		ledgerDirty = true;
		void flushLedger();
		const saved = book.sessions[sessionId];
		return {
			ok: true,
			costCNY: saved.costCNY,
			byModel: saved.byModel ?? null,
			usage: saved.usage ?? null,
			totals: summarize(),
		};
	}

	/** 端点 1：读取仪表盘数据。 */
	const disposeData = ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_DATA,
				handler: async (req, res) => {
					if (req.method !== 'GET' && req.method !== 'HEAD') {
						res.writeHead(405, { allow: 'GET, HEAD' });
						res.end();
						return;
					}
					try {
						const book = await ensureLedger();
						// 客户端可带 ?force=1 强制刷新余额（面板上的手动刷新）；
						// 带 ?sessionId=… 时一并返回该会话在账本里的**已计价金额**——
						// 那才是跨模型准确的数字（增量计价），客户端不该按当前模型
						// 重算整段历史（切换模型会导致数字跳变）。
						const url = new URL(req.url ?? ROUTE_DATA, 'http://127.0.0.1');
						const force = url.searchParams.get('force') === '1';
						const sessionId = url.searchParams.get('sessionId') ?? '';
						const current = await refreshBalance(force);
						const now = new Date();
						const record = sessionId !== '' ? book.sessions?.[sessionId] : undefined;
						sendJson(res, 200, {
							ok: true,
							now: now.toISOString(),
							balance: current,
							pricing: PRICING,
							tier: { peak: isPeak(now), label: tierLabel(now) },
							totals: summarize(),
							session: record
								? {
										id: sessionId,
										model: record.model ?? '',
										costCNY: Number(record.costCNY ?? 0),
										usage: record.usage ?? null,
										byModel: record.byModel ?? null,
										updatedAt: record.updatedAt ?? null,
									}
								: null,
						});
					} catch (error) {
						logger.warn?.('[usage-monitor] data 端点失败:', error?.message ?? error);
						sendJson(res, 500, { ok: false, error: error?.message ?? String(error) });
					}
				},
			}),
		'usage-monitor: /usage-monitor/data',
	);

	/** 端点 2：接收客户端用量上报。 */
	const disposeReport = ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'exact',
				path: ROUTE_REPORT,
				handler: async (req, res) => {
					if (req.method !== 'POST') {
						res.writeHead(405, { allow: 'POST' });
						res.end();
						return;
					}
					// 要求 JSON 媒体类型：跨站「简单请求」无法携带它，浏览器预检会被挡下。
					const contentType = String(req.headers['content-type'] ?? '');
					if (!contentType.includes('application/json')) {
						sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
						return;
					}
					try {
						const raw = await readBody(req);
						const payload = JSON.parse(raw || '{}');
						const result = await handleReport(payload);
						sendJson(res, result.ok ? 200 : 400, result);
					} catch (error) {
						logger.warn?.('[usage-monitor] report 端点失败:', error?.message ?? error);
						sendJson(res, 400, { ok: false, error: error?.message ?? String(error) });
					}
				},
			}),
		'usage-monitor: /usage-monitor/report',
	);

	// 启动即预热余额，之后按 TTL 由端点按需刷新。
	void refreshBalance(true);
	// 账本预热：让首次请求就有累计数据。
	void ensureLedger();

	// 释放时清定时器并强制落盘，避免丢数据。
	ctx.effect(() => () => {
		clearInterval(flushTimer);
		void flushLedger(true);
		void disposeData?.();
		void disposeReport?.();
	}, 'usage-monitor: cleanup');
}
