/**
 * 会话日志探查工具：找出「模型名」在持久会话日志里的位置，
 * 用于实现服务端侧的模型解析（不依赖浏览器）。
 *
 * 用法：node scripts/inspect-session.mjs [会话文件路径]
 *   不带参数时自动取 sessions 目录下最新的 session.jsonl.zstd。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const sessionsRoot = join(home, 'sessions');

/** 递归找出所有 session.jsonl.zstd，按修改时间倒序。 */
function findSessions(dir, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			findSessions(full, acc);
		} else if (entry.name === 'session.jsonl.zstd') {
			acc.push({ path: full, mtime: statSync(full).mtimeMs });
		}
	}
	return acc.sort((a, b) => b.mtime - a.mtime);
}

const target = process.argv[2] ?? findSessions(sessionsRoot)[0]?.path;
if (!target) {
	console.log('未找到会话文件');
	process.exit(1);
}
console.log('会话文件:', target);

/** 流式解压：DSH 的会话日志是多个 zstd 帧追加而成，同步 API 只能解出第一帧。 */
async function decompressAll(buffer) {
	return await new Promise((resolve, reject) => {
		const chunks = [];
		const decoder = createZstdDecompress();
		decoder.on('data', (chunk) => chunks.push(chunk));
		decoder.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		decoder.on('error', reject);
		Readable.from([buffer]).pipe(decoder);
	});
}

const text = await decompressAll(readFileSync(target));
const lines = text.split('\n').filter((line) => line.trim() !== '');
console.log('解压长度:', text.length, '| 事件行数:', lines.length);

/** 收集所有出现 model 字样的路径。 */
const modelPaths = new Map();
/** request/header 事件的样本。 */
const headers = [];

function walk(value, path, out) {
	if (value === null || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		value.slice(0, 3).forEach((item, i) => walk(item, `${path}[${i}]`, out));
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		const next = path ? `${path}.${key}` : key;
		if (/model/i.test(key) && (typeof child === 'string' || typeof child === 'number')) {
			out.set(next, child);
		}
		walk(child, next, out);
	}
}

for (const line of lines) {
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		continue;
	}
	if (event?.type === 'request/header') {
		if (headers.length < 2) {
			const found = new Map();
			walk(event, '', found);
			headers.push({ event, found });
		}
	}
	const found = new Map();
	walk(event, '', found);
	for (const [path, value] of found) {
		if (!modelPaths.has(path)) modelPaths.set(path, { count: 0, sample: value });
		modelPaths.get(path).count += 1;
	}
}

console.log('\n=== 全部含 model 的字段路径（按出现次数） ===');
[...modelPaths.entries()]
	.sort((a, b) => b[1].count - a[1].count)
	.slice(0, 15)
	.forEach(([path, info]) => console.log(`  ${path}  ×${info.count}  例: ${JSON.stringify(info.sample)}`));

console.log('\n=== request/header 事件结构 ===');
for (const { event, found } of headers) {
	console.log('  顶层键:', Object.keys(event).join(', '));
	if (event.data) console.log('  data 键:', Object.keys(event.data).slice(0, 25).join(', '));
	if (event.data?.config) console.log('  data.config 键:', Object.keys(event.data.config).join(', '));
	console.log('  该事件内 model 字段:');
	for (const [path, value] of found) console.log(`    ${path} = ${JSON.stringify(value)}`);
}
