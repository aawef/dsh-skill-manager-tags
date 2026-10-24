// 「管理标签」双列界面 — 页面渲染测试（无浏览器 / 无真实 DOM）
//
// 用一个能真正驱动 hook 的迷你 React 运行时执行 lib/client.js 里真实的
// ManageTagsDialog / TagSettingsDialog / SkillAddDialog / DisabledSkillsDialog，
// 验证双列结构、按钮文案、以及「添加标签组载入运算区」这条关键交互。
//
// 与 __page-render.mjs 的差别：那个只渲染一次（Section 的 state 由 fixture 注入）；
// 这里组件内部有 useState + useEffect + fetch，必须循环「渲染 → 执行 effect →
// flush promise → 再渲染」才能拿到稳定结果。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");
const FRAGMENT = Symbol("Fragment");

const TAGS = [
	{ tagId: "t-a", name: "A" },
	{ tagId: "t-b", name: "B" },
];
const TEMPLATES = [
	{ templateId: "tpl-1", name: "前端组", expression: "A+B*C" },
];

/** 假后端：按路由返回固定 payload，可记录调用 */
function makeFetcher(log) {
	const state = {
		expression: "",
		manualSkills: [],
		disabledSkills: [],
		universe: ["alpha", "beta", "gamma"],
	};
	const view = () => {
		const hasFilter = state.expression.trim() !== "";
		const matched = hasFilter ? state.universe.filter((n) => n === "alpha") : state.universe.slice();
		const visible = [];
		for (const n of matched) if (!state.disabledSkills.includes(n)) visible.push(n);
		for (const n of state.manualSkills) if (!state.disabledSkills.includes(n) && !visible.includes(n)) visible.push(n);
		return { hasFilter, matched, manual: state.manualSkills.slice(), disabled: state.disabledSkills.slice(), visible };
	};
	const respond = (path) => {
		if (path === "/state") {
			return { ok: true, tags: TAGS, skillLinks: [{ skillId: "alpha", tagIds: ["t-a"] }], templates: TEMPLATES, workspaces: [], conversations: [] };
		}
		if (path === "/workspaces/skills") {
			return {
				ok: true, workspaceId: "ws-1", expression: state.expression,
				config: state.expression === "" ? { orTags: [], andGroups: [] } : { orTags: ["t-a"], andGroups: [] },
				manualSkills: state.manualSkills, disabledSkills: state.disabledSkills,
				candidates: state.expression === "" ? [] : ["alpha"],
				universe: state.universe, view: view(),
			};
		}
		if (path === "/templates/validate") {
			// 忠实模拟服务端语义：只有显式传 allowEmpty 时空表达式才合法。
			// 这样若客户端漏传 allowEmpty，测试就会像用户那样看到「表达式不能为空」。
			const body = log.lastBody ? JSON.parse(log.lastBody) : {};
			const expr = String(body.expression ?? "");
			const allowEmpty = body.allowEmpty === true || body.allowEmpty === "true";
			if (expr.trim() === "" && !allowEmpty) {
				return { ok: true, validation: { ok: false, errors: [{ code: "EMPTY", message: "表达式不能为空：请点击上方标签写入，或用 A+B*C 的形式输入", position: 0, length: 0 }], warnings: [] } };
			}
			if (expr.trim() === "") {
				return { ok: true, validation: { ok: true, errors: [], warnings: [], normalized: "", config: { orTags: [], andGroups: [] } } };
			}
			return { ok: true, validation: { ok: true, errors: [], warnings: [], normalized: expr, config: { orTags: ["t-a"], andGroups: [] } } };
		}
		if (path === "/workspaces/expression") { state.expression = JSON.parse(log.lastBody ?? "{}").expression ?? ""; return { ok: true, workspace: {} }; }
		if (path === "/workspaces/skills/add") { state.manualSkills.push(JSON.parse(log.lastBody).skillName); return { ok: true, workspace: {} }; }
		if (path === "/workspaces/skills/disable") { state.disabledSkills.push(JSON.parse(log.lastBody).skillName); state.manualSkills = state.manualSkills.filter((s) => s !== JSON.parse(log.lastBody).skillName); return { ok: true, workspace: {} }; }
		if (path === "/workspaces/skills/enable") { state.disabledSkills = state.disabledSkills.filter((s) => s !== JSON.parse(log.lastBody).skillName); return { ok: true, workspace: {} }; }
		if (path === "/workspaces/skills/remove") { state.manualSkills = state.manualSkills.filter((s) => s !== JSON.parse(log.lastBody).skillName); return { ok: true, workspace: {} }; }
		return { ok: false, error: "not found " + path };
	};
	return async (url, init) => {
		const path = String(url).replace("/skill-tag/api", "");
		log.calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
		if (init?.body) log.lastBody = init.body;
		// 立刻求值（而不是等到 .json()），这样测试里的 `await fetcher(...)` 预置调用
		// 能真正改变 state；否则状态变更被推迟到 .json() 才发生。
		const payload = respond(path);
		return { json: async () => payload };
	};
}

/**
 * 迷你 React 运行时。
 *
 * 关键点：真实 React 给**每个组件实例**独立的 hook 槽位，而 createElement 桩不会
 * 执行函数组件。所以这里把 hook 存储按组件函数分桶（WeakMap），并提供一个
 * renderComponent() 在遍历时手动执行函数组件——否则内层组件的 useState 会和
 * 外层共用 cursor，导致 loading 永远停在初值。
 */
function makeRuntime() {
	const stores = new Map();       // componentFn -> { hooks: [], cursor, effects: {} }
	const pendingEffects = [];

	function storeOf(Comp) {
		let s = stores.get(Comp);
		if (!s) { s = { hooks: [], cursor: 0, effects: {} }; stores.set(Comp, s); }
		return s;
	}

	const react = {
		createElement: (type, props, ...children) => ({
			type, props: props ?? {},
			children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
		}),
		Fragment: FRAGMENT,
		useState(init) {
			const s = storeOf(react.__cur);
			const i = s.cursor++;
			if (!(i in s.hooks)) s.hooks[i] = typeof init === "function" ? init() : init;
			return [s.hooks[i], (next) => { s.hooks[i] = typeof next === "function" ? next(s.hooks[i]) : next; }];
		},
		useRef(init) {
			const s = storeOf(react.__cur);
			const i = s.cursor++;
			if (!(i in s.hooks)) s.hooks[i] = { current: init ?? null };
			return s.hooks[i];
		},
		useEffect(fn) {
			const s = storeOf(react.__cur);
			const i = s.cursor++;
			s.effects[i] = fn;
			pendingEffects.push(fn);
		},
		useMemo(fn) { storeOf(react.__cur).cursor++; return fn(); },
		useCallback(fn) { storeOf(react.__cur).cursor++; return fn; },
	};

	/** 执行一个函数组件：独立 cursor，返回其子树 */
	function renderComponent(Comp, props) {
		const s = storeOf(Comp);
		s.cursor = 0;
		s.effects = {};
		const prev = react.__cur;
		react.__cur = Comp;
		try {
			return Comp(props);
		} finally {
			react.__cur = prev;
		}
	}

	/** 清空待执行 effect 队列（每次 settle 轮次开始前调用） */
	function drainEffects() {
		const fns = pendingEffects.splice(0, pendingEffects.length);
		for (const fn of fns) {
			try {
				const cleanup = fn();
				if (typeof cleanup === "function") { /* 精简：不追踪清理 */ }
			} catch { /* effect 异常不影响结构断言 */ }
		}
		return fns.length;
	}

	/** 渲染到稳定：多轮执行以让 setState + fetch + 防抖定时器落地 */
	async function settle(Comp, props, rounds = 8, box = null) {
		let tree = null;
		for (let r = 0; r < rounds; r += 1) {
			pendingEffects.length = 0;
			// 1) 先渲染顶层（hook 入桶），2) 展开内层函数组件（此时内层 effect 才入队），
			//    3) 再统一 drain —— 顺序颠倒会导致内层 effect 永远不执行（loading 卡住）
			tree = renderComponent(Comp, props);
			tree = expand(tree);
			drainEffects();
			// 4) 让 250ms 防抖的校验回调到期（假计时器）
			if (box) {
				flushTimers(box);
				tree = expand(renderComponent(Comp, props));
			}
			await new Promise((res) => setTimeout(res, 0));
			await new Promise((res) => setTimeout(res, 0));
		}
		// 收尾：drain 里设的 setState（如 checking=true）要等 await 之后才回落，
		// 上面的 tree 是"等待前"的快照，这里再渲染一次才是稳定态。
		tree = expand(renderComponent(Comp, props));
		if (box) { flushTimers(box); tree = expand(renderComponent(Comp, props)); }
		await new Promise((res) => setTimeout(res, 0));
		tree = expand(renderComponent(Comp, props));
		return tree;
	}

	/** 深度展开函数组件（每层独立 hook 桶），保留 props 供事件断言 */
	function expand(node, depth = 0) {
		if (node === null || node === undefined || node === false) return node;
		if (typeof node !== "object") return node;
		if (depth > 40) return node;
		if (typeof node.type === "function") {
			return expand(renderComponent(node.type, node.props), depth + 1);
		}
		return {
			...node,
			children: (node.children ?? []).map((c) => expand(c, depth + 1)),
		};
	}

	return { react, settle, expand, drainEffects };
}

/**
 * 载入 client.js，返回 { registered, helpers, setFetch }。
 *
 * 假计时器：client 里用 250ms 防抖做实时校验，真实定时器会让 settle 永远等不到。
 * 这里把 setTimeout 变成立即入队，并在 settle 每轮 flush 时执行——
 * 从而让防抖回调能在断言前落地（可控且确定）。
 */
function load() {
	const box = { registered: {}, helpers: null, fetch: null, timers: [] };
	const fakeSetTimeout = (fn) => {
		box.timers.push(fn);
		return box.timers.length;
	};
	const sandbox = {
		console,
		setTimeout: fakeSetTimeout,
		clearTimeout: (id) => { if (id) box.timers[id - 1] = null; },
		fetch: (...a) => box.fetch(...a),
		window: { confirm: () => true, __ModuleLoader__: { load: () => {} } },
	};
	sandbox.globalThis = sandbox;
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	return { sandbox, box };
}

/** 执行并清空假计时器队列（模拟防抖到期） */
function flushTimers(box) {
	const pending = box.timers.splice(0, box.timers.length).filter(Boolean);
	for (const fn of pending) { try { fn(); } catch { /* 忽略 */ } }
	return pending.length;
}

function walk(node, visit, depth = 0) {
	if (node === null || node === undefined || node === false) return;
	if (typeof node !== "object") { visit(node); return; }
	if (depth > 80) return;
	visit(node);
	if (typeof node.type === "function") { walk(node.type(node.props), visit, depth + 1); return; }
	for (const c of node.children ?? []) walk(c, visit, depth + 1);
}
const texts = (node) => { const out = []; walk(node, (n) => { if (typeof n === "string") out.push(n); else if (typeof n === "number") out.push(String(n)); }); return out; };
const allText = (node) => texts(node).join("|");
const find = (node, pred) => { const hits = []; walk(node, (n) => { if (n && typeof n === "object" && n.type !== undefined && pred(n)) hits.push(n); }); return hits; };
const btnByText = (node, label) => find(node, (n) => n.type === "button" && texts(n).join("").trim() === label);

// ── 测试 ────────────────────────────────────────────────────────────────────

test("双列界面：左列标签条件 + tag 设置，右列技能 + 三个按钮", async () => {
	const rt = makeRuntime();
	const { sandbox, box } = load();
	box.fetch = makeFetcher({ calls: [] });
	let overlay = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		box.helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") overlay = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	const tree = await rt.settle(overlay, {}, 8, box);
	assert.equal(tree, null, "默认关闭时不渲染任何 DOM");
});

test("双列界面：打开后左列显示表达式与 tag 设置按钮，右列列出技能与操作按钮", async () => {
	const rt = makeRuntime();
	const { sandbox, box } = load();
	const log = { calls: [] };
	box.fetch = makeFetcher(log);
	let Dialog = null;
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });

	// 通过模块级 store 打开浮层（等价于点击菜单项）
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(Dialog, {}, 8, box);

	const text = allText(tree);
	assert.match(text, /管理标签/);
	assert.match(text, /标签配置/);
	assert.match(text, /技能 \(3\)/);
	assert.match(text, /无条件 — 该工作区掌握全部技能/);
	assert.match(text, /tag 设置/);
	assert.match(text, /精细化添加技能/);
	assert.match(text, /查看被禁用的技能/);
	assert.match(text, /查看 tag/);
	assert.match(text, /禁用/);

	// 右列每行技能都有一个「禁用」按钮
	const disableBtns = btnByText(tree, "禁用");
	assert.equal(disableBtns.length, 3, "三个技能各有一个禁用按钮");
});

test("tag 设置弹窗：回显当前表达式，并可从标签组载入运算", async () => {
	const rt = makeRuntime();
	const { sandbox, box } = load();
	const log = { calls: [] };
	box.fetch = makeFetcher(log);
	let Dialog = null;
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(Dialog, {}, 8, box);

	// 点开 tag 设置
	btnByText(tree, "tag 设置")[0].props.onClick();
	const opened = await rt.settle(Dialog, {}, 8, box);
	const text = allText(opened);
	assert.match(text, /添加标签组/);
	assert.match(text, /保存到当前工作区/);
	assert.match(text, /前端组 — A\+B\*C/);

	// 输入框回显当前工作区表达式（初始为空 → 空串）
	const ta = find(opened, (n) => n.type === "textarea");
	assert.equal(ta.length, 1);
	assert.equal(ta[0].props.value, "");

	// 选择标签组 → 表达式被载入运算区
	const sel = find(opened, (n) => n.type === "select").find((n) => (n.children ?? []).some((c) => texts(c).join("").includes("前端组")));
	assert.ok(sel, "应有标签组下拉框");
	sel.props.onChange({ target: { value: "tpl-1" } });
	const loaded = await rt.settle(Dialog, {}, 8, box);
	const ta2 = find(loaded, (n) => n.type === "textarea");
	assert.equal(ta2[0].props.value, "A+B*C", "载入标签组后运算区应显示其表达式");
	assert.match(allText(loaded), /已载入标签组「前端组」的运算/);
});

test("tag 设置弹窗：空表达式不得报错，且可直接保存（用户报告的 bug）", async () => {
	// 回归：曾出现"一边说表达式不能为空，一边说空 = 掌握全部技能"的自相矛盾。
	// 断言三点：① 空表达式无错误提示；② 显示"无条件"语义；③ 保存按钮可用且能提交空串。
	const rt = makeRuntime();
	const { sandbox, box } = load();
	const log = { calls: [] };
	box.fetch = makeFetcher(log);
	let Dialog = null;
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(Dialog, {}, 8, box);
	btnByText(tree, "tag 设置")[0].props.onClick();
	const opened = await rt.settle(Dialog, {}, 8, box);

	const text = allText(opened);
	// ① 不得出现空表达式错误
	assert.doesNotMatch(text, /表达式不能为空/, "空条件不该被判定为错误");
	assert.doesNotMatch(text, /✗/, "空条件不该出现任何错误行");
	// ② 提示空 = 无条件
	assert.match(text, /空条件 — 该工作区掌握全部技能|无条件/, "应提示空表达式 = 无条件");
	// ③ 保存按钮可用
	const saveBtn = btnByText(opened, "保存到工作区");
	assert.equal(saveBtn.length, 1);
	assert.equal(saveBtn[0].props.disabled, false, "空条件应允许保存");

	// 真点保存，确认提交的是空串
	saveBtn[0].props.onClick();
	await rt.settle(Dialog, {}, 8, box);
	const exprCall = log.calls.filter((c) => c.path === "/workspaces/expression").pop();
	assert.ok(exprCall, "应调用 /workspaces/expression");
	assert.equal(exprCall.body.expression, "", "提交的应为空表达式");
});

test("tag 设置弹窗：旧服务端不认 allowEmpty 时，空表达式仍不得报错", async () => {
	// 兼容性回归：本机桌面进程可能是旧版（validate 不认 allowEmpty，空串一律回 EMPTY）。
	// 客户端必须对空表达式短路，否则用户仍会看到"表达式不能为空"的自相矛盾。
	const rt = makeRuntime();
	const { sandbox, box } = load();
	const log = { calls: [] };
	const oldServer = makeFetcher(log);
	box.fetch = async (url, init) => {
		const path = String(url).replace("/skill-tag/api", "");
		if (path === "/templates/validate") {
			// 模拟旧服务端：无论 allowEmpty 是什么，空串都报 EMPTY
			const body = init?.body ? JSON.parse(init.body) : {};
			if (String(body.expression ?? "").trim() === "") {
				return { json: async () => ({ ok: true, validation: { ok: false, errors: [{ code: "EMPTY", message: "表达式不能为空：请点击上方标签写入，或用 A+B*C 的形式输入", position: 0, length: 0 }], warnings: [] } }) };
			}
		}
		return oldServer(url, init);
	};
	let Dialog = null;
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(Dialog, {}, 8, box);
	btnByText(tree, "tag 设置")[0].props.onClick();
	const opened = await rt.settle(Dialog, {}, 8, box);

	const text = allText(opened);
	assert.doesNotMatch(text, /表达式不能为空/, "客户端必须对空表达式短路，不依赖服务端");
	const saveBtn = btnByText(opened, "保存到工作区");
	assert.equal(saveBtn[0].props.disabled, false, "旧服务端下也应允许保存空条件");
});

test("tag 设置弹窗：已有表达式时再次打开必须回显（不能为空或重置）", async () => {
	const rt = makeRuntime();
	const { sandbox, box } = load();
	const log = { calls: [] };
	const fetcher = makeFetcher(log);
	// 预置工作区已有条件
	await fetcher("/skill-tag/api/workspaces/expression", { body: JSON.stringify({ expression: "A+B*C" }) });
	box.fetch = fetcher;
	let Dialog = null;
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(Dialog, {}, 8, box);
	// 左列应显示已保存的表达式
	assert.match(allText(tree), /A\+B\*C/);

	btnByText(tree, "tag 设置")[0].props.onClick();
	const opened = await rt.settle(Dialog, {}, 8, box);
	const ta = find(opened, (n) => n.type === "textarea");
	assert.equal(ta[0].props.value, "A+B*C", "再次打开必须回显已保存表达式");
});

test("添加技能弹窗：排除已有技能与被禁用的技能", async () => {
	const rt = makeRuntime();
	const { sandbox, box } = load();
	const log = { calls: [] };
	const fetcher = makeFetcher(log);
	// 先设标签条件（命中 alpha），再把 alpha 禁用、beta 手动添加
	// → 可见 = {beta}，universe 里只剩 gamma 可添加
	await fetcher("/skill-tag/api/workspaces/expression", { body: JSON.stringify({ expression: "A" }) });
	await fetcher("/skill-tag/api/workspaces/skills/disable", { body: JSON.stringify({ skillName: "alpha" }) });
	await fetcher("/skill-tag/api/workspaces/skills/add", { body: JSON.stringify({ skillName: "beta" }) });
	box.fetch = fetcher;
	let Dialog = null;
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(Dialog, {}, 8, box);

	// 打开添加技能弹窗
	const addBtn = find(tree, (n) => n.type === "button" && texts(n).join("").includes("精细化添加技能"));
	assert.equal(addBtn.length, 1);
	addBtn[0].props.onClick();
	const opened = await rt.settle(Dialog, {}, 8, box);
	const text = allText(opened);
	assert.match(text, /精细化添加技能/);
	assert.match(text, /已排除工作区已有的技能与被禁用的技能/);

	// 可勾选的技能里不应出现 alpha（禁用）与 beta（已有/手动）
	const labels = find(opened, (n) => n.type === "label").map((n) => texts(n).join(""));
	assert.ok(labels.includes("gamma"), "gamma 应可添加");
	assert.ok(!labels.includes("alpha"), "被禁用的 alpha 不应出现在待添加列表");
	assert.ok(!labels.includes("beta"), "已有的 beta 不应出现在待添加列表");
});

test("被禁用技能弹窗：列出禁用的技能并可恢复", async () => {
	const rt = makeRuntime();
	const { sandbox, box } = load();
	const log = { calls: [] };
	const fetcher = makeFetcher(log);
	await fetcher("/skill-tag/api/workspaces/skills/disable", { body: JSON.stringify({ skillName: "beta" }) });
	box.fetch = fetcher;
	let Dialog = null;
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(Dialog, {}, 8, box);

	const openBtn = find(tree, (n) => n.type === "button" && texts(n).join("").includes("查看被禁用的技能"));
	assert.equal(openBtn.length, 1);
	assert.match(texts(openBtn[0]).join(""), /\(1\)/, "按钮上应显示禁用数量");
	openBtn[0].props.onClick();
	const opened = await rt.settle(Dialog, {}, 8, box);
	const text = allText(opened);
	assert.match(text, /被禁用的技能 \(1\)/);
	const restore = btnByText(opened, "恢复");
	assert.equal(restore.length, 1, "每个被禁用的技能都有一个恢复按钮");
});

test("从 data-row-key 反推 workspaceId；ungrouped 组返回 null", async () => {
	const { sandbox, box } = load();
	box.fetch = makeFetcher({ calls: [] });
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => { helpers = factory(() => makeRuntime().react).__test; };
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	assert.equal(helpers.workspaceIdOfRowKey("workspace:abc-123"), "abc-123");
	assert.equal(helpers.workspaceIdOfRowKey("workspace:"), null, "ungrouped 组为空 id");
	assert.equal(helpers.workspaceIdOfRowKey("session:s-1"), null);
	assert.equal(helpers.workspaceIdOfRowKey(null), null);
});

test("菜单识别：只有「重命名 + 删除工作区」两项才注入，其它菜单不碰", async () => {
	const { sandbox, box } = load();
	box.fetch = makeFetcher({ calls: [] });
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => { helpers = factory(() => makeRuntime().react).__test; };
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	assert.equal(helpers.isWorkspaceMenu(["重命名", "删除工作区"]), true);
	assert.equal(helpers.isWorkspaceMenu(["Rename", "Delete workspace"]), true);
	assert.equal(helpers.isWorkspaceMenu(["重命名"]), false, "会话菜单项数不同");
	assert.equal(helpers.isWorkspaceMenu(["重命名", "删除工作区", "其他"]), false);
	assert.equal(helpers.isWorkspaceMenu(["归档", "删除"]), false);
	assert.equal(helpers.isWorkspaceMenu([]), false);
});

test("作用域互斥：开过对话管理后再开工作区，必须仍打开工作区版（用户报告的 bug）", async () => {
	const { sandbox, box } = load();
	box.fetch = makeFetcher({ calls: [] });
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => { helpers = factory(() => makeRuntime().react).__test; };
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });

	// 1) 先从「会话行菜单」打开对话版
	helpers.manageSet({ open: true, workspaceId: "", workspaceTitle: "", conversationId: "conv-1", sessionTitle: "某对话" });
	assert.equal(helpers.manageScope(helpers.manage.workspaceId, helpers.manage.conversationId).isConv, true);

	// 2) 再从「工作区行菜单」打开 —— 该入口只传 workspaceId / workspaceTitle
	helpers.manageSet({ open: true, workspaceId: "ws-1", workspaceTitle: "dsh test" });
	assert.equal(helpers.manage.conversationId, "", "开工作区作用域时必须清掉残留的 conversationId");
	const scope = helpers.manageScope(helpers.manage.workspaceId, helpers.manage.conversationId);
	assert.equal(scope.isConv, false, "否则工作区入口会错误打开「管理标签（对话）」");
	assert.equal(scope.id, "ws-1");
	assert.equal(scope.title, "管理标签");

	// 3) 反向：开过工作区后再开对话，同样不得残留 workspaceId
	helpers.manageSet({ open: true, conversationId: "conv-2", sessionTitle: "另一个对话" });
	assert.equal(helpers.manage.workspaceId, "", "开对话作用域时必须清掉残留的 workspaceId");
	const scope2 = helpers.manageScope(helpers.manage.workspaceId, helpers.manage.conversationId);
	assert.equal(scope2.isConv, true);
	assert.equal(scope2.id, "conv-2");
});

// ── 右列技能搜索框 ─────────────────────────────────────────────────────────

/** 按 placeholder 找输入框（工作区版与对话版共用同一个组件） */
const inputByPlaceholder = (node, ph) => find(node, (n) => n.type === "input" && n.props?.placeholder === ph);

test("右列技能搜索框：置于列表顶部，过滤显示而不改变可见技能总数", async () => {
	const rt = makeRuntime();
	const { sandbox, box } = load();
	box.fetch = makeFetcher({ calls: [] });
	let Dialog = null;
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(Dialog, {}, 8, box);

	const search = inputByPlaceholder(tree, "搜索技能…");
	assert.equal(search.length, 1, "右列顶部应有搜索框");
	assert.equal(allText(tree).includes("技能 (3)"), true, "未搜索时标题显示总数");

	// 输入 "alp" → 只剩 alpha
	search[0].props.onChange({ target: { value: "alp" } });
	const filtered = await rt.settle(Dialog, {}, 8, box);
	const text = allText(filtered);
	assert.match(text, /技能 \(1\/3\)/, "过滤后标题应显示 匹配/总数");
	assert.match(text, /alpha/);
	assert.doesNotMatch(text, /beta/);
	assert.doesNotMatch(text, /gamma/);

	// 大小写不敏感
	inputByPlaceholder(filtered, "搜索技能…")[0].props.onChange({ target: { value: "GAMMA" } });
	const upper = await rt.settle(Dialog, {}, 8, box);
	assert.match(allText(upper), /gamma/);
	assert.doesNotMatch(allText(upper), /alpha|beta/, "大小写不敏感，且仍只显示 gamma");

	// 无匹配 → 提示行，且不出现"没有技能"那条（那是给空集合的）
	inputByPlaceholder(upper, "搜索技能…")[0].props.onChange({ target: { value: "zzz" } });
	const none = await rt.settle(Dialog, {}, 8, box);
	assert.match(allText(none), /没有匹配/);
	assert.doesNotMatch(allText(none), /没有技能。可在下方/);

	// 「清除」把搜索词还原为空
	const clearBtn = btnByText(none, "清除");
	assert.equal(clearBtn.length, 1);
	clearBtn[0].props.onClick();
	const cleared = await rt.settle(Dialog, {}, 8, box);
	assert.match(allText(cleared), /技能 \(3\)/);
	assert.equal(inputByPlaceholder(cleared, "搜索技能…")[0].props.value, "");
	assert.equal(btnByText(cleared, "清除").length, 0, "空搜索词时不显示清除按钮");
});

test("窗口尺寸固定：搜索让右列行数变少时，浮层高度不跟着缩", async () => {
	const rt = makeRuntime();
	const { sandbox, box } = load();
	box.fetch = makeFetcher({ calls: [] });
	let Dialog = null;
	let helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });

	// 浮层主体（overlay 的唯一直接子 div）必须带确定高度，而不是只靠 maxHeight 撑开
	const modalOf = (tree) => {
		const overlay = find(tree, (n) => n.props?.style?.position === "fixed")[0];
		assert.ok(overlay, "应渲染浮层遮罩");
		const modal = (overlay.children ?? [])[0];
		assert.ok(modal && typeof modal === "object", "遮罩里应有浮层主体");
		return modal;
	};

	const before = await rt.settle(Dialog, {}, 8, box);
	const h0 = modalOf(before).props.style.height;
	assert.equal(h0, "82vh", "未搜索时浮层高度应为固定的 82vh（不能只给 maxHeight）");

	// 搜到只剩 1 个技能：高度必须与搜索前一致
	inputByPlaceholder(before, "搜索技能…")[0].props.onChange({ target: { value: "alp" } });
	const after = await rt.settle(Dialog, {}, 8, box);
	assert.match(allText(after), /技能 \(1\/3\)/);
	assert.equal(modalOf(after).props.style.height, h0, "过滤后窗口高度不得变小");

	// 搜到 0 个：同样不变
	inputByPlaceholder(after, "搜索技能…")[0].props.onChange({ target: { value: "zzz" } });
	const none = await rt.settle(Dialog, {}, 8, box);
	assert.match(allText(none), /没有匹配/);
	assert.equal(modalOf(none).props.style.height, h0, "无匹配时窗口高度不得变小");
});
