/**
 * dsh-usage-monitor —— 客户端（浏览器）半，bundle 格式。
 *
 * 加载约定（见 @deepseek-ai/dsh-client-modules）：
 *   宿主扫描声明了 dsh.client 的 Loader 条目，把本文件经 /plugins/<包名>/client.js
 *   提供出去；文件必须是 `window.__ModuleLoader__.load({id, factory})` 形式，
 *   factory 内为模块主体（惰性 CJS），依赖经 require 从统一基座取得。
 *
 * 功能：
 *   - 读取会话 tokenUsage 投影，按内置定价表实时换算本会话花费；
 *   - 从宿主端点 /usage-monitor/data 读取余额、累计与定价；
 *   - 把本会话累计用量上报给宿主端点，用于跨会话累计。
 *
 * 注意：定价引擎与 lib/pricing.js 保持一致（客户端无法 import 服务端模块，
 * 因此此处内联一份；改动定价请同时更新两处）。
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-usage-monitor',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		// ───────────────────────── 定价引擎（与 lib/pricing.js 同步） ─────────────────────────
		const PRICING = {
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
		const FALLBACK_MODEL = 'deepseek-flash';
		const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];
		const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

		function normalizeModel(model) {
			const raw = String(model ?? '').toLowerCase();
			if (raw.includes('pro')) return 'deepseek-v4-pro';
			if (raw.includes('flash')) return 'deepseek-flash';
			if (raw.includes('chat') || raw.includes('reasoner')) return 'deepseek-v4-pro';
			return FALLBACK_MODEL;
		}
		function isPeak(at = new Date()) {
			const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS);
			const day = beijing.getUTCDay();
			if (day === 0 || day === 6) return false;
			const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
			return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to);
		}
		function unitPrices(modelKey, peak) {
			const tier = PRICING[modelKey] ?? PRICING[FALLBACK_MODEL];
			const pick = (row) => (peak ? row.peak : row.offPeak);
			return { cacheHit: pick(tier.cacheHit), cacheMiss: pick(tier.cacheMiss), output: pick(tier.output) };
		}
		function computeCost(usage = {}, options = {}) {
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
			return {
				costCNY: parts.uncachedInput + parts.cacheRead + parts.cacheWrite + parts.output,
				modelKey,
				peak,
				tokens,
				parts,
			};
		}
		function totalTokens(usage = {}) {
			return (
				Number(usage.uncachedInputTokens ?? 0) +
				Number(usage.cacheReadTokens ?? 0) +
				Number(usage.cacheWriteTokens ?? 0) +
				Number(usage.outputTokens ?? 0)
			);
		}
		function cacheHitRate(usage = {}) {
			const input =
				Number(usage.uncachedInputTokens ?? 0) +
				Number(usage.cacheReadTokens ?? 0) +
				Number(usage.cacheWriteTokens ?? 0);
			if (input <= 0) return null;
			return Number(usage.cacheReadTokens ?? 0) / input;
		}
		function formatCNY(value) {
			const n = Number(value ?? 0);
			if (!Number.isFinite(n)) return '¥--';
			if (n === 0) return '¥0';
			if (Math.abs(n) < 0.01) return `¥${n.toFixed(4)}`;
			return `¥${n.toFixed(2)}`;
		}
		function formatTokens(value) {
			const n = Number(value ?? 0);
			if (!Number.isFinite(n)) return '--';
			if (n < 1000) return String(n);
			if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
			return `${(n / 1e6).toFixed(2)}M`;
		}
		function tierLabel(peak) {
			return peak ? '高峰时段' : '空闲时段（半价）';
		}

		// ───────────────────────── 宿主端点 ─────────────────────────
		const DATA_ENDPOINT = '/usage-monitor/data';
		const REPORT_ENDPOINT = '/usage-monitor/report';

		async function fetchDashboard(force = false, sessionId = '') {
			const parts = [];
			if (force) parts.push('force=1');
			if (sessionId) parts.push(`sessionId=${encodeURIComponent(sessionId)}`);
			const url = parts.length > 0 ? `${DATA_ENDPOINT}?${parts.join('&')}` : DATA_ENDPOINT;
			const response = await fetch(url, { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		}

		// ───────────────── 共享仪表盘状态（面板与 dock 条同源） ─────────────────
		/**
		 * 「用量」面板与输入框 dock 条是同一个插件的两个挂载点，必须显示同一份
		 * 余额/累计数据。若各持一份 useState，面板上的「刷新」只会更新面板自己：
		 * dock 条要等自己下一轮轮询（最长 60 秒）才会跟上，期间两处数字互相矛盾。
		 *
		 * 因此把仪表盘数据放到模块级 store：谁刷新都写回同一份缓存并通知全部订阅者，
		 * 两处随即可见地一起更新；并发取数合并成一次请求（force 也去重，服务端
		 * refreshBalance 自身带 TTL 与 in-flight 合并，重复强制刷新没有意义）。
		 */
		const dashboardStore = (() => {
			/** 最近一次成功取回的数据；null = 尚未取到。 */
			let cache = null;
			/** 进行中的请求（并发调用合并到同一个 promise）。 */
			let pending = null;
			const listeners = new Set();
			const notify = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {
						/* 单个订阅者出错不影响其他订阅者 */
					}
				}
			};
			return {
				get: () => cache,
				set: (next) => {
					if (!next || typeof next !== 'object') return;
					cache = next;
					notify();
				},
				/** 就地合并（上报响应只带回 totals 时使用）。 */
				merge: (patch) => {
					if (!patch || typeof patch !== 'object') return;
					cache = { ...(cache ?? {}), ...patch };
					notify();
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				/** 取数并写回共享缓存；进行中则复用，避免两处挂载点重复请求。 */
				load: (sessionId = '', force = false) => {
					if (pending) return pending;
					pending = fetchDashboard(force, sessionId)
						.then((data) => {
							cache = data;
							notify();
							return data;
						})
						.finally(() => {
							pending = null;
						});
					return pending;
				},
				/** 仅测试用：清空缓存与进行中的请求。 */
				reset: () => {
					cache = null;
					pending = null;
					notify();
				},
			};
		})();

		/**
		 * 订阅共享仪表盘状态：返回当前数据并驱动重渲染。
		 * 面板刷新、dock 条轮询、上报回执写回 totals——任何一处更新都立即反映到两处。
		 * @param {string} sessionId - 当前会话 id（变化时重新取数并订阅）。
		 * @returns {object|null} 最近一次仪表盘数据。
		 */
		function useDashboard(sessionId) {
			const [dashboard, setDashboard] = React.useState(() => dashboardStore.get());
			React.useEffect(() => {
				setDashboard(dashboardStore.get());
				return dashboardStore.subscribe(() => setDashboard(dashboardStore.get()));
			}, [sessionId]);
			return dashboard;
		}

		/**
		 * 本会话花费：优先用宿主账本里**已计价**的金额——它按各阶段所用的模型
		 * 与时段分别增量计价，所以**切换模型不会让历史金额跳变**；只有当账本里
		 * 还没有这个会话（尚未上报）时，才退回「按当前模型重算整段用量」的本地估算。
		 * @param {object|null} ledgerRecord - 账本里该会话的记录（含 costCNY）。
		 * @param {number} localEstimate - 本地估算金额（元）。
		 * @returns {{cost:number, fromLedger:boolean}} 显示金额及其来源。
		 */
		function sessionCostOf(ledgerRecord, localEstimate) {
			const ledgerCost = ledgerRecord?.costCNY;
			if (typeof ledgerCost === 'number' && Number.isFinite(ledgerCost)) {
				return { cost: ledgerCost, fromLedger: true };
			}
			return { cost: localEstimate, fromLedger: false };
		}

		async function reportUsage(sessionId, model, usage) {
			const response = await fetch(REPORT_ENDPOINT, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId, model, usage }),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		}

		// ───────────────────────── 样式 ─────────────────────────
		const CSS = `
.umsm-root{display:flex;flex-direction:column;gap:12px;padding:16px 18px;font-size:13px;line-height:1.5;overflow:auto;height:100%;box-sizing:border-box}
.umsm-head{display:flex;align-items:center;gap:10px}
.umsm-title{font-size:14px;font-weight:600}
.umsm-sub{font-size:12px;opacity:.6}
.umsm-refresh{margin-left:auto;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
.umsm-refresh:disabled{opacity:.45;cursor:default}
.umsm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
.umsm-card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:10px;padding:10px 12px;background:var(--dsw-specific-tip,rgba(128,128,128,.06))}
.umsm-card-label{font-size:12px;opacity:.65}
.umsm-card-value{font-size:20px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
.umsm-card-note{font-size:11px;opacity:.6;margin-top:2px}
.umsm-tier{display:flex;align-items:center;gap:8px;font-size:12px;padding:6px 10px;border-radius:8px;background:var(--dsw-specific-tip,rgba(128,128,128,.06))}
.umsm-dot{width:7px;height:7px;border-radius:50%;background:#2fb344;flex:none}
.umsm-dot.peak{background:#e8a33d}
.umsm-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.umsm-table th,.umsm-table td{text-align:right;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}
.umsm-table th:first-child,.umsm-table td:first-child{text-align:left}
.umsm-table th{font-weight:500;opacity:.65}
.umsm-table tr.umsm-active td{font-weight:600}
.umsm-section-title{font-size:12px;font-weight:600;opacity:.75;margin-top:4px}
.umsm-breakdown{display:flex;flex-direction:column;gap:4px;font-size:12px}
.umsm-row{display:flex;align-items:baseline;gap:8px}
.umsm-row .umsm-k{opacity:.7}
.umsm-row .umsm-v{margin-left:auto;font-variant-numeric:tabular-nums}
.umsm-err{font-size:12px;padding:8px 10px;border-radius:8px;background:rgba(220,80,80,.12);color:var(--dsw-alias-state-error-primary,#d05)}
.umsm-foot{font-size:11px;opacity:.55;margin-top:auto}
`;

		const STYLE_TAG_ID = '@local/dsh-usage-monitor/panel.css';
		function ensureStyle() {
			if (typeof document === 'undefined') return;
			if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return;
			const tag = document.createElement('style');
			tag.dataset.plugin = '@local/dsh-usage-monitor';
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		ensureStyle();

		// ───────────────────────── 组件 ─────────────────────────
		/** 单个数值卡片。 */
		function Card({ label, value, note }) {
			return h(
				'div',
				{ className: 'umsm-card' },
				h('div', { className: 'umsm-card-label' }, label),
				h('div', { className: 'umsm-card-value' }, value),
				note ? h('div', { className: 'umsm-card-note' }, note) : null,
			);
		}

		/** 用量明细行。 */
		function Row({ k, v }) {
			return h(
				'div',
				{ className: 'umsm-row' },
				h('span', { className: 'umsm-k' }, k),
				h('span', { className: 'umsm-v' }, v),
			);
		}

		/**
		 * 解析并跟随当前模型。
		 *
		 * 首选**响应式**路径：订阅界面模型选择器的共享状态
		 * （`ctx.modelDirectories.directoryFor(sessionId).store`，一个 uSES 安全的
		 * snapshot store），因此界面上切换模型**即时生效**——不轮询、不刷新页面。
		 *
		 * 只有该服务不可用（订阅建立失败，例如会话尚未就绪）时才退回
		 * RPC 解析 + 60 秒低频兜底，并在 token 用量变化时补一次解析。
		 * @param {object} props - 槽注入面（sessionId / initialModel / resolveModel / modelDirectories）。
		 * @param {object} usage - 当前会话 token 用量（仅兜底路径用作变化信号）。
		 * @returns {{name: string, resolved: boolean}} 模型状态。
		 */
		function useResolvedModel(props, usage) {
			const sessionId = props.sessionId;
			const [modelState, setModelState] = React.useState({ name: props.initialModel ?? '', resolved: false });
			const lastResolveRef = React.useRef(0);

			React.useEffect(() => {
				let alive = true;
				const apply = (model) => {
					if (!alive || typeof model !== 'string' || model === '') return;
					setModelState((prev) =>
						prev.name === model && prev.resolved ? prev : { name: model, resolved: true },
					);
				};

				// ── 首选：订阅模型选择器的共享 store（事件驱动，零轮询） ──
				try {
					const resolvers = props.modelDirectories;
					if (resolvers && typeof resolvers.directoryFor === 'function') {
						const directory = resolvers.directoryFor(sessionId);
						const store = directory?.store;
						if (store && typeof store.subscribe === 'function') {
							const read = () => {
								try {
									apply(store.getSnapshot?.()?.current?.model);
								} catch {
									/* 快照读取失败：保持上一次的值 */
								}
							};
							read();
							// 首次订阅时拉取一次最新目录（幂等：内部 generation 保证旧响应不覆盖新值）。
							void Promise.resolve(directory.load?.()).catch(() => {});
							const stop = store.subscribe(read);
							return () => {
								alive = false;
								try {
									stop?.();
								} catch {
									/* 释放失败不影响卸载 */
								}
							};
						}
					}
				} catch {
					/* 服务不可用或会话未就绪：走下面的兜底路径 */
				}

				// ── 兜底：RPC 解析 + 低频轮询（仅在无法订阅时启用） ──
				const resolve = () => {
					if (typeof props.resolveModel !== 'function') return;
					lastResolveRef.current = Date.now();
					props.resolveModel().then(apply).catch(() => {});
				};
				resolve();
				const timer = setInterval(resolve, 60_000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [
				sessionId,
				usage.uncachedInputTokens,
				usage.cacheReadTokens,
				usage.cacheWriteTokens,
				usage.outputTokens,
			]);

			return modelState;
		}

		/**
		 * 每个会话最近一次上报的用量签名。模块级共享，使「用量」面板与常驻
		 * dock 条同时挂载时也只上报一次（服务端本身按增量计价，也是幂等的）。
		 */
		const reportedSignatures = new Map();

		/**
		 * 每会话最近一次已知的账本记录（含 costCNY 与按模型分桶 byModel）。
		 * 模块级缓存：组件重新挂载（切 tab、切走再切回）时可直接复用，
		 * 不至于因为"这次没重新上报"而退回本地估算。
		 */
		const ledgerRecordCache = new Map();

		/**
		 * 订阅「账本里该会话的已计价记录」。
		 * @param {object} props - 槽注入面（sessionId）。
		 * @returns {[object|null, (record:object)=>void]} 记录与写入函数。
		 */
		function useLedgerSession(props) {
			const sessionId = props.sessionId;
			const [record, setRecord] = React.useState(() =>
				sessionId && ledgerRecordCache.has(sessionId) ? ledgerRecordCache.get(sessionId) : null,
			);
			React.useEffect(() => {
				if (!sessionId) {
					setRecord(null);
					return;
				}
				setRecord(ledgerRecordCache.has(sessionId) ? ledgerRecordCache.get(sessionId) : null);
			}, [sessionId]);
			const remember = React.useCallback(
				(next) => {
					if (!sessionId || !next || typeof next !== 'object') return;
					const merged = { ...(ledgerRecordCache.get(sessionId) ?? {}), ...next, id: sessionId };
					ledgerRecordCache.set(sessionId, merged);
					setRecord(merged);
				},
				[sessionId],
			);
			return [record, remember];
		}

		/**
		 * 把本会话累计用量同步给宿主账本（跨会话累计的数据来源）。
		 *
		 * 挂在常驻的 dock 条上，因此**不依赖用户是否打开「用量」面板**；
		 * 同一用量只上报一次，变化后延迟 1.2 秒发送（合并流式期间的频繁更新）；
		 * 首次挂载该会话时强制立刻上报一次——这样**即使用量没变化**，也能马上
		 * 拿到账本里的已计价金额（用于跨模型准确的「本会话花费」显示）。
		 * @param {object} props - 槽注入面（sessionId）。
		 * @param {object} usage - 当前会话 token 用量（四桶）。
		 * @param {string} model - 当前模型 id。
		 * @param {(result: object) => void} [onReport] - 上报成功后的回调（携带 costCNY 与 totals）。
		 */
		function useUsageReporter(props, usage, model, onReport) {
			const sessionId = props.sessionId;
			const onReportRef = React.useRef(onReport);
			onReportRef.current = onReport;

			React.useEffect(() => {
				if (!sessionId) return undefined;
				const payload = {
					uncachedInputTokens: usage.uncachedInputTokens ?? 0,
					cacheReadTokens: usage.cacheReadTokens ?? 0,
					cacheWriteTokens: usage.cacheWriteTokens ?? 0,
					outputTokens: usage.outputTokens ?? 0,
				};
				if (totalTokens(payload) <= 0) return undefined;
				const signature = `${payload.uncachedInputTokens}|${payload.cacheReadTokens}|${payload.cacheWriteTokens}|${payload.outputTokens}|${model}`;
				// 首次挂载：没有缓存签名 → 立即上报（取回账本金额）；否则按签名去重。
				const isFirst = !reportedSignatures.has(sessionId);
				if (!isFirst && reportedSignatures.get(sessionId) === signature) return undefined;
				const timer = setTimeout(() => {
					reportedSignatures.set(sessionId, signature);
					reportUsage(sessionId, model, payload)
						.then((result) => {
							if (result) onReportRef.current?.(result);
						})
						.catch(() => {
							// 上报失败：清掉签名，下一次用量变化会重试。
							if (reportedSignatures.get(sessionId) === signature) reportedSignatures.delete(sessionId);
						});
				}, isFirst ? 0 : 1200);
				return () => clearTimeout(timer);
			}, [
				sessionId,
				model,
				usage.uncachedInputTokens,
				usage.cacheReadTokens,
				usage.cacheWriteTokens,
				usage.outputTokens,
			]);
		}

		/** 主面板：余额 + 本会话 + 累计 + 定价。 */
		function UsagePanel(props) {
			const useProjection = props.useProjection;
			const sessionId = props.sessionId;
			// 会话 token 用量投影（token-meter 提供；字段为四个互不重叠的桶）。
			const projection = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
			const usage = projection ?? {};
			// 模型名：跟随模型切换自动更新（与界面模型选择器同源，无需刷新页面）。
			const modelState = useResolvedModel(props, usage);
			const model = modelState.name;
			// 仪表盘数据来自模块级共享 store：面板与 dock 条始终显示同一份，
			// 面板上的「刷新」会让 dock 条同时更新（不再各持一份 state）。
			const dashboard = useDashboard(sessionId);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			const refresh = React.useCallback(
				async (force) => {
					setBusy(true);
					try {
						// 带上 sessionId：服务端会一并返回该会话在账本里的已计价金额。
						await dashboardStore.load(sessionId, force);
						setError(null);
					} catch (err) {
						setError(err?.message ?? String(err));
					} finally {
						setBusy(false);
					}
				},
				[sessionId],
			);

			// 首次挂载与定时刷新（余额侧有 60 秒 TTL，30 秒轮询即可）。
			React.useEffect(() => {
				refresh(false);
				const timer = setInterval(() => refresh(false), 30_000);
				return () => clearInterval(timer);
			}, [refresh]);

			// 账本里该会话的已计价记录（含按模型分桶）：模块级缓存先到先用，
			// 上报响应到达时更新——两者都不依赖另一方先加载。
			const [ledgerSession, rememberLedger] = useLedgerSession(props);
			// 用量变化时上报（与常驻 dock 共享去重；面板打开与否都会上报）。
			useUsageReporter(props, usage, model, (result) => {
				if (typeof result?.costCNY === 'number') {
					rememberLedger({ costCNY: result.costCNY, byModel: result.byModel ?? null, usage: result.usage ?? null });
				}
				if (result?.totals) dashboardStore.merge({ totals: result.totals });
			});

			const now = dashboard?.now ? new Date(dashboard.now) : new Date();
			const peak = dashboard?.tier?.peak ?? isPeak(now);
			const session = computeCost(usage, { model, at: now });
			// 显示金额：账本优先（跨模型准确），账本缺该会话时退回本地估算。
			const sessionCost = sessionCostOf(dashboard?.session ?? ledgerSession, session.costCNY);
			const balance = dashboard?.balance;
			const totals = dashboard?.totals;
			const hitRate = cacheHitRate(usage);
			const pricing = dashboard?.pricing ?? PRICING;
			const activeModelKey = session.modelKey;
			// 按模型明细：来自账本的 byModel 分桶（本功能上线后开始记录）。
			const ledgerByModel = dashboard?.session?.byModel ?? ledgerSession?.byModel ?? null;
			const modelRows = ledgerByModel
				? Object.entries(ledgerByModel)
						.map(([key, bucket]) => ({
							key,
							label: PRICING[key]?.label ?? key,
							tokens: totalTokens(bucket?.usage ?? {}),
							cost: Number(bucket?.costCNY ?? 0),
						}))
						.sort((a, b) => b.cost - a.cost)
				: [];

			const balanceValue =
				balance?.state === 'ok' ? formatCNY(balance.total) : balance?.state === 'loading' ? '读取中…' : '--';
			const balanceNote =
				balance?.state === 'ok'
					? `充值 ${formatCNY(balance.toppedUp)} · 赠金 ${formatCNY(balance.granted)}`
					: balance?.state === 'no-credential'
						? '未找到 DEEPSEEK_API_KEY'
						: balance?.state === 'error'
							? `读取失败：${balance.error ?? ''}`.slice(0, 80)
							: '正在查询余额';

			return h(
				'div',
				{ className: 'umsm-root' },
				h(
					'div',
					{ className: 'umsm-head' },
					h('span', { className: 'umsm-title' }, '用量与余额'),
					h('span', { className: 'umsm-sub' }, '按官方定价实时估算'),
					h(
						'button',
						{ className: 'umsm-refresh', onClick: () => refresh(true), disabled: busy },
						busy ? '刷新中…' : '刷新',
					),
				),

				error ? h('div', { className: 'umsm-err' }, `数据读取失败：${error}`) : null,

				h(
					'div',
					{ className: 'umsm-cards' },
					h(Card, { label: '账户余额', value: balanceValue, note: balanceNote }),
					h(Card, {
						label: '本会话花费',
						value: formatCNY(sessionCost.cost),
						note: `${formatTokens(totalTokens(usage))} tokens${hitRate === null ? '' : ` · 缓存命中 ${(hitRate * 100).toFixed(0)}%`}${sessionCost.fromLedger ? '' : ' · 估算'}`,
					}),
					h(Card, {
						label: '累计花费',
						value: totals ? formatCNY(totals.costCNY) : '--',
						note: totals
							? `${totals.sessionCount} 个会话 · ${formatTokens(totals.tokenTotal)} tokens`
							: '账本读取中…',
					}),
				),

				h(
					'div',
					{ className: 'umsm-tier' },
					h('span', { className: `umsm-dot${peak ? ' peak' : ''}` }),
					h('span', null, `当前 ${tierLabel(peak)}`),
					h(
						'span',
						{ style: { marginLeft: 'auto', opacity: 0.6 } },
						`${PRICING[activeModelKey]?.label ?? activeModelKey}${modelState.resolved ? '' : ' · 按 Flash 估算'}`,
					),
				),

				h('div', { className: 'umsm-section-title' }, '本会话用量明细'),
				h(
					'div',
					{ className: 'umsm-breakdown' },
					h(Row, {
						k: `缓存命中输入（${formatTokens(session.tokens.cacheRead)}）`,
						v: formatCNY(session.parts.cacheRead),
					}),
					h(Row, {
						k: `缓存未命中输入（${formatTokens(session.tokens.uncachedInput)}）`,
						v: formatCNY(session.parts.uncachedInput),
					}),
					session.tokens.cacheWrite > 0
						? h(Row, {
								k: `写入缓存输入（${formatTokens(session.tokens.cacheWrite)}）`,
								v: formatCNY(session.parts.cacheWrite),
							})
						: null,
					h(Row, { k: `输出（${formatTokens(session.tokens.output)}）`, v: formatCNY(session.parts.output) }),
				),

				modelRows.length > 0 ? h('div', { className: 'umsm-section-title' }, '按模型明细（账本累计）') : null,
				modelRows.length > 0
					? h(
							'table',
							{ className: 'umsm-table' },
							h(
								'thead',
								null,
								h('tr', null, h('th', null, '模型'), h('th', null, 'tokens'), h('th', null, '金额')),
							),
							h(
								'tbody',
								null,
								modelRows.map((row) =>
									h(
										'tr',
										{ key: row.key, className: row.key === activeModelKey ? 'umsm-active' : undefined },
										h('td', null, row.label),
										h('td', null, formatTokens(row.tokens)),
										h('td', null, formatCNY(row.cost)),
									),
								),
							),
						)
					: null,
				!ledgerByModel && sessionCost.fromLedger
					? h(
							'div',
							{ className: 'umsm-foot' },
							'该会话的用量产生于「按模型拆分」上线之前，暂无模型维度明细（新用量会开始分桶）。',
						)
					: null,

				h('div', { className: 'umsm-section-title' }, '官方定价（元 / 百万 tokens）'),
				h(
					'table',
					{ className: 'umsm-table' },
					h(
						'thead',
						null,
						h(
							'tr',
							null,
							h('th', null, '模型'),
							h('th', null, '缓存命中'),
							h('th', null, '未命中'),
							h('th', null, '输出'),
						),
					),
					h(
						'tbody',
						null,
						Object.entries(pricing).map(([key, tier]) =>
							h(
								'tr',
								{ key, className: key === activeModelKey ? 'umsm-active' : undefined },
								h('td', null, tier.label ?? key),
								h('td', null, (peak ? tier.cacheHit.peak : tier.cacheHit.offPeak).toString()),
								h('td', null, (peak ? tier.cacheMiss.peak : tier.cacheMiss.offPeak).toString()),
								h('td', null, (peak ? tier.output.peak : tier.output.offPeak).toString()),
							),
						),
					),
				),

				h(
					'div',
					{ className: 'umsm-foot' },
					`高峰时段为北京时间周一至周五 9:00-12:00、14:00-18:00，其余为空闲时段（价格为高峰的一半）。本会话与累计金额取自本地账本（按各阶段模型与时段增量计价），token 数来自提供方精确用量；与平台账单口径一致，可能有极小的取整差异。`,
				),
			);
		}

		/** 输入框上方 dock 条：常驻显示余额与本会话花费。 */
		function UsageDock(props) {
			const useProjection = props.useProjection;
			const sessionId = props.sessionId;
			const projection = typeof useProjection === 'function' ? useProjection('tokenUsage') : undefined;
			const usage = projection ?? {};
			// 模型名：解析权威值（与界面模型选择器同源），失败时按 Flash 兜底。
			// 模型名：跟随模型切换自动更新（无需刷新页面）。
			const modelState = useResolvedModel(props, usage);
			const model = modelState.name;
			// 仪表盘数据来自与「用量」面板共享的 store：「刷新」按钮、面板轮询、
			// 上报回执任一处的更新都会立刻反映到这条常驻 dock 上。
			const dashboard = useDashboard(sessionId);

			// 账本里该会话的已计价记录：模块级缓存先到先用（重挂载也不会退回估算）。
			const [ledgerSession, rememberLedger] = useLedgerSession(props);

			// 常驻上报：dock 条始终渲染，因此即使不打开「用量」面板，
			// 累计账本也会跟着用量实时更新（与面板共享去重，不会重复计数）。
			useUsageReporter(props, usage, model, (result) => {
				if (typeof result?.costCNY === 'number') {
					rememberLedger({ costCNY: result.costCNY, byModel: result.byModel ?? null, usage: result.usage ?? null });
				}
			});

			React.useEffect(() => {
				// 首屏取数：与面板共享缓存/in-flight，两个挂载点同时出现也只请求一次。
				// 取数失败时静默保留上一份数据（余额侧本就有 60 秒 TTL）。
				dashboardStore.load(sessionId).catch(() => {});
				// 兜底轮询：面板没打开时 dock 仍是唯一的数据入口。共享缓存下
				// 两个挂载点同时存在也只产生一次真实请求。
				const timer = setInterval(() => {
					dashboardStore.load(sessionId).catch(() => {});
				}, 60_000);
				return () => clearInterval(timer);
			}, [sessionId]);

			const now = dashboard?.now ? new Date(dashboard.now) : new Date();
			const peak = dashboard?.tier?.peak ?? isPeak(now);
			const session = computeCost(usage, { model, at: now });
			// 本会话花费：账本金额优先（切换模型不跳变），否则本地估算。
			const sessionCost = sessionCostOf(dashboard?.session ?? ledgerSession, session.costCNY);
			const balance = dashboard?.balance;
			const spendable = balance?.state === 'ok' ? formatCNY(balance.total) : balance?.state === 'loading' ? '…' : '--';
			// 当前模型在当前时段的实时单价：随模型选择与高峰/空闲自动变化。
			const pricing = dashboard?.pricing ?? PRICING;
			const tier = pricing[session.modelKey] ?? PRICING[FALLBACK_MODEL];
			const pick = (row) => (peak ? row.peak : row.offPeak);
			const modelLabel = modelState.resolved
				? String(tier?.label ?? session.modelKey).replace(/^DeepSeek-/, '')
				: 'Flash(估算)';
			const unitLine = `命中 ¥${pick(tier.cacheHit)} · 未命中 ¥${pick(tier.cacheMiss)} · 输出 ¥${pick(tier.output)}（元 / 百万 tokens）`;
			// 空会话（还没有任何 token 用量）时省略「本会话」一段：
			// 新会话的 dock 容器更窄，少一段就不会被挤到折行/裁切。
			const hasSpend = sessionCost.cost > 0 || totalTokens(usage) > 0;

			return h(
				'div',
				{
					className: 'umsm-dock',
					title: `当前模型：${tier?.label ?? session.modelKey}${modelState.resolved ? '' : '（未识别，按 Flash 估算）'}\n计价时段：${tierLabel(peak)}\n单价（元 / 百万 tokens）：${unitLine}\n本会话：${formatTokens(totalTokens(usage))} tokens`,
					style: {
						display: 'flex',
						alignItems: 'center',
						// 关键：单行不折行，且锁定行高与最小高度——
						// 否则父级 flex 容器会把这一条压扁，文字只露出上半部分。
						flexWrap: 'nowrap',
						flexShrink: 0,
						columnGap: 8,
						width: '100%',
						boxSizing: 'border-box',
						fontSize: 12,
						lineHeight: '18px',
						minHeight: 20,
						padding: '1px 10px',
						opacity: 0.85,
						fontVariantNumeric: 'tabular-nums',
					},
				},
				h('span', { className: `umsm-dot${peak ? ' peak' : ''}`, style: { flexShrink: 0 } }),
				h('span', { style: { flexShrink: 0 } }, `余额 ${spendable}`),
				hasSpend ? h('span', { style: { opacity: 0.5, flexShrink: 0 } }, '·') : null,
				hasSpend ? h('span', { style: { flexShrink: 0 } }, `本会话 ${formatCNY(sessionCost.cost)}`) : null,
				h('span', { style: { opacity: 0.5, flexShrink: 0 } }, '·'),
				// 单价段是唯一允许收缩的部分：容器再窄也优先保住余额与时段，
				// 收缩时以省略号结尾，而不是硬裁掉。
				h(
					'span',
					{
						style: {
							opacity: 0.9,
							minWidth: 0,
							flexShrink: 1,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						},
					},
					`${modelLabel} 命中¥${pick(tier.cacheHit)}/未命中¥${pick(tier.cacheMiss)}/输出¥${pick(tier.output)}`,
				),
				h('span', { style: { opacity: 0.5, flexShrink: 0 } }, '·'),
				h('span', { style: { opacity: 0.75, flexShrink: 0 } }, peak ? '高峰时段' : '空闲半价'),
			);
		}

		// ───────────────────────── 插件体 ─────────────────────────
		/** 需要的客户端服务：插槽注册表与会话访问。 */
		const inject = ['slots', 'sessions'];

		/**
		 * 收集可用的「模型目录」客户端 API。
		 *
		 * 模型的权威来源是宿主的 `session.models` RPC，它挂在 connection 的 api
		 * 客户端上（界面模型选择器正是经 `ctx.get('connection').api.sessions`
		 * 调用它的：`new ModelDirectory(ctx.get("connection").api.sessions, ...)`）；
		 * `ctx.sessions` 只作为兜底尝试。
		 * @param {object} ctx - 客户端根上下文。
		 * @returns {object[]} 可用的 API 候选（按优先级）。
		 */
		function modelApiCandidates(ctx) {
			const apis = [];
			const push = (api) => {
				if (api && typeof api.models === 'function') apis.push(api);
			};
			try {
				push(ctx.get?.('connection')?.api?.sessions);
			} catch {
				/* connection 不可用时忽略 */
			}
			try {
				push(ctx.get?.('sessions'));
			} catch {
				/* 兜底候选不可用时忽略 */
			}
			return apis;
		}

		/**
		 * 解析本会话当前模型（与界面模型选择器同源）。
		 * @param {object} ctx - 客户端根上下文。
		 * @param {string} sessionId - 会话 id。
		 * @returns {Promise<string>} 模型 id；无法解析时返回空串，由定价兜底。
		 */
		async function resolveSessionModel(ctx, sessionId) {
			for (const api of modelApiCandidates(ctx)) {
				try {
					const outcome = await api.models({ sessionId });
					const result = outcome?.result ?? outcome;
					if (!result || result.ok === false) continue;
					const current = result.value?.current;
					const model = current?.model ?? current?.id;
					if (typeof model === 'string' && model !== '') return model;
				} catch {
					/* 该候选失败，换下一个 */
				}
			}
			return '';
		}

		/** 从会话快照尽力取一个模型初值（解析完成前的占位，取不到则留空）。 */
		function initialModelOf(ctx, sessionId) {
			try {
				const session = ctx.sessions.binding(sessionId)?.session;
				const snapshot = session?.getSnapshot?.();
				return snapshot?.header?.model ?? snapshot?.header?.request?.model ?? snapshot?.model ?? '';
			} catch {
				return '';
			}
		}

		/**
		 * 注册用量面板（主视图 tab）与输入框 dock 条。
		 * @param {object} ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			/**
			 * 取界面模型选择器的共享状态服务（可订阅，用于响应式跟随模型）。
			 * 用 ctx.get 动态取而不是硬 inject：服务缺失时插件仍能激活。
			 */
			const modelDirectoriesOf = () => {
				try {
					return ctx.get?.('modelDirectories');
				} catch {
					return undefined;
				}
			};

			/** 两个槽共用的注入面：会话 id、模型初值、解析函数、共享模型状态服务。 */
			const slotInject = (sessionId) => ({
				sessionId,
				initialModel: initialModelOf(ctx, sessionId),
				resolveModel: () => resolveSessionModel(ctx, sessionId),
				modelDirectories: modelDirectoriesOf(),
			});

			// 主视图 tab：「对话 / 轨迹」之外的第三个视图。
			ctx.slots.inject('conversation.view', () =>
				ctx.slots.register(
					{
						name: 'conversation.view',
						id: 'usage',
						order: 20,
						label: () => '用量',
						inject: slotInject,
					},
					UsagePanel,
				),
			);

			// 输入框上方 dock 条：常驻一眼可见。
			ctx.slots.inject('conversation.input.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.dock',
						id: 'usage-monitor',
						order: 20,
						inject: slotInject,
					},
					UsageDock,
				),
			);
		}

		exports.UsagePanel = UsagePanel;
		exports.UsageDock = UsageDock;
		exports.apply = apply;
		exports.inject = inject;
		// 内部面：供离线校验脚本核对客户端内联定价与服务端 lib/pricing.js 是否一致。
		exports.__internal = { PRICING, computeCost, normalizeModel, isPeak, totalTokens, cacheHitRate, sessionCostOf, dashboardStore };
		return module.exports;
	},
});
