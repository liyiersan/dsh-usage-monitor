/**
 * 客户端 bundle 验证：在模拟的浏览器环境里加载 lib/client.js，
 * 用 mock 的 React / ctx 驱动 apply()，检查注册参数与组件渲染，
 * 无需真实浏览器、无需重启 DSH。
 *
 * 用法：node scripts/client-check.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'lib', 'client.js');
const source = readFileSync(clientPath, 'utf8');

const failures = [];
const check = (label, condition, detail = '') => {
	console.log(`${condition ? '  ✔' : '  ✗'} ${label}${detail ? ' — ' + detail : ''}`);
	if (!condition) failures.push(label);
};

/** 只取元素树里的可见文本（忽略 title 等属性），用于断言用户实际看到的内容。 */
function flattenText(node) {
	if (node === null || node === undefined || typeof node === 'boolean') return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(flattenText).join('');
	if (typeof node === 'object') return flattenText(node.children);
	return '';
}

// ── 1. 模拟浏览器环境执行 bundle ───────────────────────────────────────
const registrations = [];
const windowMock = {
	__ModuleLoader__: {
		load: (registration) => registrations.push(registration),
	},
};
/** 记录组件注册的定时器（用 mock 避免真实调度，并可断言清理彻底）。 */
let timerSeq = 0;
const liveTimers = new Map();
const context = vm.createContext({
	window: windowMock,
	console,
	document: undefined,
	setTimeout: (fn, ms) => {
		const id = ++timerSeq;
		liveTimers.set(id, { fn, ms, kind: 'timeout' });
		return id;
	},
	clearTimeout: (id) => liveTimers.delete(id),
	setInterval: (fn, ms) => {
		const id = ++timerSeq;
		liveTimers.set(id, { fn, ms, kind: 'interval' });
		return id;
	},
	clearInterval: (id) => liveTimers.delete(id),
	fetch: undefined,
});
vm.runInContext(source, context, { filename: 'client.js' });

console.log('\n[1] bundle 注册');
check('调用了一次 window.__ModuleLoader__.load', registrations.length === 1, `实际 ${registrations.length}`);
const reg = registrations[0];
check('id 与包名一致', reg?.id === '@local/dsh-usage-monitor', String(reg?.id));
check('factory 是函数', typeof reg?.factory === 'function');

// ── 2. mock require + React ────────────────────────────────────────────
function createElement(type, props, ...children) {
	return { $$element: true, type, props: props ?? {}, children };
}
/** 记录所有 setState 写入（用于断言响应式更新）。 */
const stateWrites = [];
/** 记录 React effect 的清理函数（测试末尾统一释放，避免定时器挂住进程）。 */
const pendingEffects = [];
const ReactMock = {
	createElement,
	useState: (init) => {
		let value = typeof init === 'function' ? init() : init;
		return [
			value,
			(next) => {
				value = typeof next === 'function' ? next(value) : next;
				stateWrites.push(value);
			},
		];
	},
	// 同步执行 effect（模拟挂载），以便验证订阅是否真的建立。
	useEffect: (fn) => {
		const cleanup = fn();
		if (typeof cleanup === 'function') pendingEffects.push(cleanup);
	},
	useRef: (init) => ({ current: init }),
	useCallback: (fn) => fn,
	memo: (fn) => fn,
};
const requireMock = (spec) => {
	if (spec === 'react') return ReactMock;
	throw new Error(`Unexpected require("${spec}") — 只能使用运行时静态表里的模块`);
};

const exportsObject = reg.factory(requireMock);
console.log('\n[2] factory 执行');
check('导出 apply', typeof exportsObject.apply === 'function');
check('导出 inject', Array.isArray(exportsObject.inject), JSON.stringify(exportsObject.inject));
check(
	'inject 只含确定存在的服务（slots/sessions）',
	exportsObject.inject.every((s) => s === 'slots' || s === 'sessions'),
	JSON.stringify(exportsObject.inject),
);

// ── 3. mock ctx 驱动 apply ─────────────────────────────────────────────
const slotRegistrations = [];
const injectedSlots = [];
/** 记录宿主模型服务被调用的会话 id（验证模型解析确实走了官方接口）。 */
const modelCalls = [];
/** 记录 directoryFor 的调用（验证订阅式跟随走了模型选择器的共享服务）。 */
const directoryCalls = [];
/** 模拟界面模型选择器的共享 store（可订阅，切换模型时会通知订阅者）。 */
const storeListeners = [];
let storeCurrent = { provider: 'deepseek', model: 'deepseek-flash' };
const mockDirectory = {
	store: {
		getSnapshot: () => ({
			current: storeCurrent,
			routable: true,
			groups: [],
			failures: [],
			status: 'ready',
			error: null,
		}),
		subscribe: (callback) => {
			storeListeners.push(callback);
			return () => {
				const index = storeListeners.indexOf(callback);
				if (index >= 0) storeListeners.splice(index, 1);
			};
		},
	},
	load: async () => ({}),
};
const ctxMock = {
	slots: {
		inject: (name, callback) => {
			injectedSlots.push(name);
			return callback();
		},
		register: (options, component) => {
			slotRegistrations.push({ options, component });
			return () => {};
		},
	},
	sessions: {
		binding: (sessionId) => ({
			session: {
				getSnapshot: () => ({ header: { model: 'deepseek-flash' }, views: new Map() }),
			},
		}),
	},
	// 模型目录服务实际挂在 connection 的 api 客户端上（已核实的真实结构：
	// ui-model-selection 用 new ModelDirectory(ctx.get("connection").api.sessions, ...)）。
	connection: {
		api: {
			sessions: {
				models: async ({ sessionId }) => {
					modelCalls.push({ via: 'connection', sessionId });
					return { result: { ok: true, value: { current: { provider: 'deepseek', model: 'deepseek-v4-pro' } } } };
				},
			},
		},
	},
	// 界面模型选择器的共享状态服务（响应式跟随模型的入口）。
	modelDirectories: {
		directoryFor: (sessionId) => {
			directoryCalls.push(sessionId);
			return mockDirectory;
		},
	},
	// cordis 的可选服务读取入口。
	get(name) {
		return this[name];
	},
};

console.log('\n[3] apply() 注册行为');
try {
	exportsObject.apply(ctxMock);
	check('apply 未抛错', true);
} catch (error) {
	check('apply 未抛错', false, error?.message);
}

check('等待了 conversation.view 槽', injectedSlots.includes('conversation.view'), injectedSlots.join(', '));
check('等待了 conversation.input.dock 槽', injectedSlots.includes('conversation.input.dock'), injectedSlots.join(', '));
check('共注册 2 个条目', slotRegistrations.length === 2, `实际 ${slotRegistrations.length}`);

for (const { options, component } of slotRegistrations) {
	const isList = options.name === 'conversation.view' || options.name === 'conversation.input.dock';
	console.log(`  · slot=${options.name} id=${options.id} order=${options.order}`);
	check(`  ${options.name} 是 list 槽且提供 id`, isList ? typeof options.id === 'string' : true);
	check(`  ${options.name} 的 label 是字符串或函数`, options.label === undefined || ['string', 'function'].includes(typeof options.label));
	check(`  ${options.name} 组件是函数`, typeof component === 'function');
}

// ── 4. 渲染组件（模拟框架注入的 props） ────────────────────────────────
console.log('\n[4] 组件渲染（mock props）');
const usageProjection = { uncachedInputTokens: 60_000, cacheReadTokens: 1_940_000, cacheWriteTokens: 0, outputTokens: 41_700 };
for (const { options, component } of slotRegistrations) {
	let injectedProps = {};
	try {
		injectedProps = options.inject ? options.inject('session-test-1') : {};
	} catch (error) {
		check(`${options.name} 的 inject() 未抛错`, false, error?.message);
		continue;
	}
	check(`${options.name} 的 inject() 返回对象`, injectedProps !== null && typeof injectedProps === 'object');
	const props = {
		...injectedProps,
		useProjection: (key) => (key === 'tokenUsage' ? usageProjection : undefined),
		useSession: () => ({}),
		sessionId: 'session-test-1',
		t: (key) => key,
	};
	try {
		const tree = component(props);
		check(`${options.name} 组件渲染成功`, tree !== null && tree !== undefined && tree.$$element === true);
	} catch (error) {
		check(`${options.name} 组件渲染成功`, false, error?.message);
	}
	// 能力缺失时的降级（框架未注入 useProjection）
	try {
		const tree = component({ ...injectedProps, sessionId: 'session-test-1' });
		check(`${options.name} 在无 useProjection 时安全降级`, tree !== null && tree !== undefined);
	} catch (error) {
		check(`${options.name} 在无 useProjection 时安全降级`, false, error?.message);
	}
}

// ── 5. 定价口径抽查（客户端内联副本） ─────────────────────────────────
console.log('\n[5] 定价口径抽查');
{
	// 直接取组件树里的数字不方便，改为验证模块内联的定价函数行为：
	// 通过渲染结果里出现的金额字符串间接核对（Flash 空闲、2M 输入 97% 命中、41.7k 输出）
	const panel = slotRegistrations.find((r) => r.options.name === 'conversation.view');
	const props = {
		...(panel.options.inject ? panel.options.inject('s') : {}),
		useProjection: () => usageProjection,
		sessionId: 's',
	};
	const tree = panel.component(props);
	const flat = JSON.stringify(tree);
	// 手算：命中 1.94M×0.02=0.0388 + 未命中 0.06M×1=0.06 + 输出 0.0417M×4=0.1668 → 0.2656 → 显示 ¥0.27
	check('面板显示本会话金额 ¥0.27（与手算一致）', flat.includes('¥0.27'), flat.match(/¥[0-9.]+/g)?.slice(0, 6).join(' '));
	check('面板显示当前时段标签', flat.includes('时段'), '');

	// dock 条：应显示当前模型名与其三项单价（本次改进的核心诉求）
	const dock = slotRegistrations.find((r) => r.options.name === 'conversation.input.dock');
	const dockTree = dock.component({
		...(dock.options.inject ? dock.options.inject('s') : {}),
		useProjection: () => usageProjection,
		sessionId: 's',
	});
	const dockFlat = JSON.stringify(dockTree);
	check(
		'dock 条显示当前模型单价（命中/未命中/输出）',
		dockFlat.includes('命中¥') && dockFlat.includes('未命中¥') && dockFlat.includes('输出¥'),
		dockFlat.match(/命中¥[0-9.]+\/未命中¥[0-9.]+\/输出¥[0-9.]+/)?.[0] ?? '',
	);
	check('dock 条标注计价基准模型', dockFlat.includes('Flash'), '');
	check('dock 条保留余额与本会话花费', dockFlat.includes('余额') && dockFlat.includes('本会话'), '');
	const dockStyle = dockTree.props?.style ?? {};
	check(
		'dock 条锁定行高与最小高度（不被父级压扁）',
		dockStyle.lineHeight !== undefined && dockStyle.minHeight !== undefined,
		`lineHeight=${dockStyle.lineHeight} minHeight=${dockStyle.minHeight}`,
	);
	check('dock 条不参与 flex 收缩（flexShrink: 0）', dockStyle.flexShrink === 0, String(dockStyle.flexShrink));
	check(
		'单价段是唯一可收缩部分（省略号结尾）',
		(dockTree.children ?? []).some((child) => child?.props?.style?.textOverflow === 'ellipsis'),
		'',
	);
	// 空会话（无 token 用量）：省略「本会话」段，避免在更窄的新会话容器里折行
	const emptyDockTree = dock.component({
		...(dock.options.inject ? dock.options.inject('s') : {}),
		useProjection: () => ({}),
		sessionId: 's',
	});
	const emptyText = flattenText(emptyDockTree);
	check('空会话时省略「本会话」段', !emptyText.includes('本会话') && emptyText.includes('余额'), emptyText.slice(0, 110));
	check('空会话仍显示单价与时段', emptyText.includes('命中¥') && emptyText.includes('半价'), '');
}

// ── 6. 模型解析（ctx.sessions.models 官方途径） ────────────────────────
console.log('\n[6] 模型解析');
{
	const panel = slotRegistrations.find((r) => r.options.name === 'conversation.view');
	const injected = panel.options.inject('session-model-test');
	check('inject 提供 initialModel', 'initialModel' in injected, String(injected.initialModel));
	check('inject 提供 resolveModel 函数', typeof injected.resolveModel === 'function');
	const resolved = await injected.resolveModel();
	check('解析出权威模型 deepseek-v4-pro', resolved === 'deepseek-v4-pro', String(resolved));
	check(
		'经 connection.api.sessions 调用（与模型选择器同源）',
		modelCalls.some((c) => c.via === 'connection' && c.sessionId === 'session-model-test'),
		JSON.stringify(modelCalls),
	);
	// 模型服务不可用时应安全降级为空串（由定价兜底 Flash），而不是抛错
	const savedConnection = ctxMock.connection;
	ctxMock.connection = undefined;
	const degraded = await injected.resolveModel();
	check('模型服务不可用时安全降级', degraded === '', String(degraded));
	ctxMock.connection = savedConnection;
}

// ── 7. 客户端内联定价与服务端 lib/pricing.js 一致性 ────────────────────
console.log('\n[7] 定价副本一致性（防止两份副本漂移）');
{
	const clientPricing = exportsObject.__internal;
	check('客户端导出了内部定价面', clientPricing !== undefined && typeof clientPricing.computeCost === 'function');
	if (clientPricing) {
		const serverPricing = await import('../lib/pricing.js');
		const usage = {
			uncachedInputTokens: 60_000,
			cacheReadTokens: 1_940_000,
			cacheWriteTokens: 12_345,
			outputTokens: 41_700,
		};
		for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'unknown-model-x']) {
			for (const at of [new Date('2026-09-02T02:00:00Z'), new Date('2026-09-02T05:00:00Z')]) {
				const a = clientPricing.computeCost(usage, { model, at });
				const b = serverPricing.computeCost(usage, { model, at });
				check(
					`${model} @ ${b.peak ? '高峰' : '空闲'} 金额一致`,
					Math.abs(a.costCNY - b.costCNY) < 1e-12,
					`client=${a.costCNY.toFixed(6)} server=${b.costCNY.toFixed(6)}`,
				);
			}
		}
		// V4-Pro 空闲手算：命中 1.94×0.15 + 未命中 0.06×4.5 + 写入 0.012345×4.5 + 输出 0.0417×13.5
		const pro = clientPricing.computeCost(usage, { model: 'deepseek-v4-pro', at: new Date('2026-09-02T05:00:00Z') });
		const expected = 0.291 + 0.27 + 0.0555525 + 0.56295;
		check(
			'V4-Pro 空闲金额与手算一致',
			Math.abs(pro.costCNY - expected) < 1e-9,
			`${pro.costCNY.toFixed(6)} vs ${expected.toFixed(6)}`,
		);
	}
}

// ── 8. 响应式模型跟随（订阅模型选择器的 store，零轮询） ─────────────────
console.log('\n[8] 响应式模型跟随（切换模型即时生效）');
{
	const dock = slotRegistrations.find((r) => r.options.name === 'conversation.input.dock');
	const props = {
		...(dock.options.inject ? dock.options.inject('s-live') : {}),
		useProjection: () => usageProjection,
		sessionId: 's-live',
	};
	check(
		'inject 提供 modelDirectories 服务',
		props.modelDirectories !== undefined && typeof props.modelDirectories.directoryFor === 'function',
	);
	const listenersBefore = storeListeners.length;
	const writesBefore = stateWrites.length;
	dock.component(props); // 渲染 → effect 运行 → 建立订阅
	check('经 directoryFor 取得共享 directory', directoryCalls.includes('s-live'), directoryCalls.join(','));
	check('渲染后新增了 store 订阅', storeListeners.length > listenersBefore, `${listenersBefore} → ${storeListeners.length}`);

	// 模拟用户在界面上把模型切到 V4-Pro：store 变化 → 订阅回调通知 → 状态即时更新
	storeCurrent = { provider: 'deepseek', model: 'deepseek-v4-pro' };
	for (const listener of [...storeListeners]) listener();
	const writes = stateWrites.slice(writesBefore);
	const last = writes.at(-1);
	check('切换模型后模型状态即时更新为 v4-pro', last?.name === 'deepseek-v4-pro', JSON.stringify(last));
	check('更新由订阅回调驱动（无需轮询）', writes.length > 0, `${writes.length} 次 setState`);
}

// 释放 React effect（清理各组件注册的定时器，避免挂住进程）
for (const cleanup of pendingEffects.splice(0)) {
	try {
		cleanup();
	} catch {
		/* 忽略释放异常 */
	}
}

console.log(`\n结论：${failures.length === 0 ? '✅ 全部通过' : `❌ ${failures.length} 项失败：` + failures.join(' | ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
