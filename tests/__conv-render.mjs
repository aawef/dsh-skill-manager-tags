// 「对话 → 管理标签」— 页面渲染测试（无浏览器 / 无真实 DOM）
//
// 验证三件事：
//   1. 会话行「...」菜单走**官方槽位** sidebar.workspaces.session.menu.item 注册，点它打开对话版浮层并关闭菜单；
//   2. 对话版双列界面：左列条件 + 「继承工作区配置」按钮，右列技能三件套，保存目标指向对话；
//   3. 「继承工作区配置」真的打 /conversations/inherit，且保存表达式打 /conversations/expression。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, "..", "lib", "client.js"), "utf8");
const FRAGMENT = Symbol("Fragment");

const TAGS = [{ tagId: "t-a", name: "A" }, { tagId: "t-b", name: "B" }];
const TEMPLATES = [{ templateId: "tpl-1", name: "前端组", expression: "A+B*C" }];
const UNIVERSE = ["alpha", "beta", "gamma"];

/**
 * 假后端：对话版端点 + 工作区版端点（继承来源）。
 * 记录每条调用，供断言"打的是对话端点而不是工作区端点"。
 */
function makeFetcher(log, opts = {}) {
	const state = {
		expression: opts.expression ?? "",
		manualSkills: [...(opts.manualSkills ?? [])],
		disabledSkills: [...(opts.disabledSkills ?? [])],
		// 注意用 in 判定：显式传 null（未继承）不能被 ?? 吃掉
		sourceWorkspaceId: "sourceWorkspaceId" in opts ? opts.sourceWorkspaceId : "ws-1",
		inheritedAt: "inheritedAt" in opts ? opts.inheritedAt : "2026-10-20T12:00:00.000Z",
	};
	const view = () => {
		const hasFilter = state.expression.trim() !== "";
		const matched = hasFilter ? UNIVERSE.filter((n) => n === "alpha") : UNIVERSE.slice();
		const visible = [];
		for (const n of matched) if (!state.disabledSkills.includes(n)) visible.push(n);
		for (const n of state.manualSkills) if (!state.disabledSkills.includes(n) && !visible.includes(n)) visible.push(n);
		return { hasFilter, matched, manual: state.manualSkills.slice(), disabled: state.disabledSkills.slice(), visible };
	};
	const payload = () => ({
		ok: true,
		conversationId: "sess-1",
		workspaceId: state.sourceWorkspaceId,
		// 该对话是否已有自己的配置快照（own）。false = 从未配置过。
		configured: "configured" in opts ? opts.configured : true,
		// 服务端只读体检：已冻结的表达式是否还引用了存在的标签
		expressionIssue: opts.expressionIssue ?? { ok: true, message: null },
		expression: state.expression,
		config: state.expression === "" ? { orTags: [], andGroups: [] } : { orTags: ["t-a"], andGroups: [] },
		manualSkills: state.manualSkills.slice(),
		disabledSkills: state.disabledSkills.slice(),
		inheritedAt: state.inheritedAt,
		sourceWorkspaceId: state.sourceWorkspaceId,
		candidates: state.expression === "" ? [] : ["alpha"],
		universe: UNIVERSE,
		view: view(),
	});
	const body = () => JSON.parse(log.lastBody ?? "{}");

	const respond = (p) => {
		if (p === "/state") {
			return { ok: true, tags: TAGS, skillLinks: [{ skillId: "alpha", tagIds: ["t-a"] }], templates: TEMPLATES, workspaces: [], conversations: [] };
		}
		// 工作区版端点（只用于「工作区版没有继承按钮」的对照测试）
		if (p === "/workspaces/skills") {
			return {
				ok: true, workspaceId: "ws-1", expression: "A",
				config: { orTags: ["t-a"], andGroups: [] },
				manualSkills: [], disabledSkills: [],
				candidates: ["alpha"], universe: UNIVERSE,
				view: { hasFilter: true, matched: ["alpha"], manual: [], disabled: [], visible: ["alpha"] },
			};
		}
		if (p === "/workspaces/expression") return { ok: true, workspace: {} };
		if (p === "/conversations/config") return payload();
		if (p === "/conversations/inherit") {
			state.expression = "A+B*C";
			state.manualSkills = ["gamma"];
			state.disabledSkills = ["beta"];
			return payload();
		}
		if (p === "/conversations/expression") { state.expression = body().expression ?? ""; return { ok: true, conversation: {} }; }
		if (p === "/conversations/skills/add") { state.manualSkills.push(body().skillName); return { ok: true, conversation: {} }; }
		if (p === "/conversations/skills/disable") {
			const n = body().skillName;
			state.disabledSkills.push(n);
			state.manualSkills = state.manualSkills.filter((s) => s !== n);
			return { ok: true, conversation: {} };
		}
		if (p === "/conversations/skills/enable") { state.disabledSkills = state.disabledSkills.filter((s) => s !== body().skillName); return { ok: true, conversation: {} }; }
		if (p === "/conversations/skills/remove") { state.manualSkills = state.manualSkills.filter((s) => s !== body().skillName); return { ok: true, conversation: {} }; }
		if (p === "/templates/validate") {
			const b = body();
			if (String(b.expression ?? "").trim() === "") {
				return { ok: true, validation: { ok: true, errors: [], warnings: [], normalized: "", config: { orTags: [], andGroups: [] } } };
			}
			return { ok: true, validation: { ok: true, errors: [], warnings: [], normalized: b.expression, config: { orTags: ["t-a"], andGroups: [] } } };
		}
		return { ok: false, error: "not found " + p };
	};

	return async (url, init) => {
		const p = String(url).replace("/skill-tag/api", "");
		log.calls.push({ path: p, body: init?.body ? JSON.parse(init.body) : null });
		if (init?.body) log.lastBody = init.body;
		const out = respond(p);
		return { json: async () => out };
	};
}

/** 迷你 React 运行时（与 __manage-render.mjs 同一套思路：hook 按组件分桶） */
function makeRuntime() {
	const stores = new Map();
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

	function renderComponent(Comp, props) {
		const s = storeOf(Comp);
		s.cursor = 0;
		s.effects = {};
		const prev = react.__cur;
		react.__cur = Comp;
		try { return Comp(props); } finally { react.__cur = prev; }
	}

	function drainEffects() {
		const fns = pendingEffects.splice(0, pendingEffects.length);
		for (const fn of fns) { try { fn(); } catch { /* 忽略 */ } }
		return fns.length;
	}

	function expand(node, depth = 0) {
		if (node === null || node === undefined || node === false) return node;
		if (typeof node !== "object") return node;
		if (depth > 40) return node;
		if (typeof node.type === "function") return expand(renderComponent(node.type, node.props), depth + 1);
		return { ...node, children: (node.children ?? []).map((c) => expand(c, depth + 1)) };
	}

	async function settle(Comp, props, rounds = 8, box = null) {
		let tree = null;
		for (let r = 0; r < rounds; r += 1) {
			pendingEffects.length = 0;
			tree = expand(renderComponent(Comp, props));
			drainEffects();
			if (box) { flushTimers(box); tree = expand(renderComponent(Comp, props)); }
			await new Promise((res) => setTimeout(res, 0));
			await new Promise((res) => setTimeout(res, 0));
		}
		tree = expand(renderComponent(Comp, props));
		if (box) { flushTimers(box); tree = expand(renderComponent(Comp, props)); }
		await new Promise((res) => setTimeout(res, 0));
		return expand(renderComponent(Comp, props));
	}

	return { react, settle, expand, drainEffects };
}

function load() {
	const box = { registered: {}, fetch: null, timers: [] };
	const sandbox = {
		console,
		setTimeout: (fn) => { box.timers.push(fn); return box.timers.length; },
		clearTimeout: (id) => { if (id) box.timers[id - 1] = null; },
		fetch: (...a) => box.fetch(...a),
		window: { confirm: () => true, __ModuleLoader__: { load: () => {} } },
	};
	sandbox.globalThis = sandbox;
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	return { sandbox, box };
}

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
	for (const c of node.children ?? []) walk(c, visit, depth + 1);
}
const texts = (node) => { const out = []; walk(node, (n) => { if (typeof n === "string") out.push(n); else if (typeof n === "number") out.push(String(n)); }); return out; };
const allText = (node) => texts(node).join("|");
const find = (node, pred) => { const hits = []; walk(node, (n) => { if (n && typeof n === "object" && n.type !== undefined && pred(n)) hits.push(n); }); return hits; };
const btnByText = (node, label) => find(node, (n) => n.type === "button" && texts(n).join("").trim() === label);

/** 载入 client.js 并取回 apply 注册的两个组件（overlay + 会话菜单项） */
async function boot(opts = {}) {
	const rt = makeRuntime();
	const { sandbox, box } = load();
	const log = { calls: [], lastBody: null };
	box.fetch = makeFetcher(log, opts);
	const slots = {};
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		slots.helpers = exp.__test;
		// commandUi 贡献位收集器：让测试能看到「+」菜单里注册了什么
		const contributions = [];
		const commandUi = {
			contributions,
			register: (c) => { contributions.push(c); return () => {}; },
			decorate: () => () => {},
		};
		const ctx = {
			effect: (fn) => fn(),
			slots: {
				inject: (_n, fn) => fn(),
				register: (o, C) => { slots[o.name] = { options: o, component: C }; },
			},
		};
		if (opts.withCommandUi !== false) {
			ctx.inject = (names, fn) => {
				if (Array.isArray(names) && names.includes("commandUi")) return fn({ commandUi, effect: (f) => f() });
				return undefined;
			};
			ctx.get = (n) => (n === "commandUi" ? commandUi : undefined);
			slots.commandUi = commandUi;
		}
		exp.apply(ctx);
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	return { rt, box, log, slots };
}

// ── 入口：会话行菜单走官方槽位 ────────────────────────────────────────────

test("会话行菜单项注册在官方槽位 sidebar.workspaces.session.menu.item，排在宿主项之后", async () => {
	const { slots } = await boot();
	const entry = slots["sidebar.workspaces.session.menu.item"];
	assert.ok(entry, "必须注册到会话行菜单槽位");
	assert.equal(entry.options.id, "dsh-skill-tag.manage-tags-session");
	// 宿主已占 100/200/300/400/450；插件必须让开，排在后面
	assert.ok(entry.options.order > 450, `order 应在宿主项之后，实际 ${entry.options.order}`);
	assert.equal(typeof entry.component, "function");
});

test("点会话菜单项：打开对话版浮层（带 conversationId）并关闭宿主菜单", async () => {
	const { rt, box, slots } = await boot();
	const Item = slots["sidebar.workspaces.session.menu.item"].component;

	let closedWith = null;
	const tree = rt.expand(rt.react.createElement(Item, {
		sessionId: "sess-1",
		displayTitle: "看板重构",
		useMenuOpenState: () => [true, (v) => { closedWith = v; }],
	}));
	assert.match(allText(tree), /管理标签/);
	const btn = find(tree, (n) => n.type === "button" && n.props.role === "menuitem");
	assert.equal(btn.length, 1, "必须是 role=menuitem 的 button");

	btn[0].props.onClick();
	assert.equal(closedWith, false, "行动后必须关掉宿主菜单");
	const st = slots.helpers.manage;
	assert.equal(st.open, true);
	assert.equal(st.conversationId, "sess-1");
	assert.equal(st.workspaceId, "", "对话入口不该带 workspaceId，否则会渲染成工作区版");
	void box;
});

test("宿主没给 useMenuOpenState 时不崩（降级为无法关闭）", async () => {
	const { rt, slots } = await boot();
	const Item = slots["sidebar.workspaces.session.menu.item"].component;
	const tree = rt.expand(rt.react.createElement(Item, { sessionId: "sess-1", displayTitle: "x" }));
	assert.match(allText(tree), /管理标签/);
	const btn = find(tree, (n) => n.type === "button");
	assert.equal(btn[0].props.onClick(), undefined, "缺 hook 时点击不应抛错");
});

// ── 对话版双列界面 ─────────────────────────────────────────────────────────

test("对话版双列：打的是对话端点，左列有「继承工作区配置」，右列技能三件套", async () => {
	const { rt, box, slots, log } = await boot({ expression: "A", manualSkills: ["gamma"] });
	slots.helpers.manageSet({ open: true, conversationId: "sess-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);

	const text = allText(tree);
	assert.match(text, /管理标签（对话）/);
	assert.match(text, /管理标签/);
	assert.match(text, /标签配置/);
	assert.match(text, /当前对话的标签条件/, "左列文案应指向对话而非工作区");
	assert.match(text, /继承工作区配置/, "对话版必须有继承按钮");
	assert.match(text, /查看 tag/);
	assert.match(text, /禁用/);
	assert.match(text, /精细化添加技能/);
	assert.match(text, /查看被禁用的技能/);

	// 打的是对话端点
	const loads = log.calls.filter((c) => c.path === "/conversations/config");
	assert.equal(loads.length >= 1, true, "应通过 /conversations/config 加载");
	assert.equal(loads[0].body.conversationId, "sess-1");
	assert.equal(log.calls.some((c) => c.path === "/workspaces/skills"), false, "对话版不该打工作区端点");
});

test("对话版左列显示继承来源与时间（让用户知道条件从哪来）", async () => {
	const { rt, box, slots } = await boot({ expression: "A", sourceWorkspaceId: "ws-9", inheritedAt: "2026-10-20T12:34:56.000Z" });
	slots.helpers.manageSet({ open: true, conversationId: "sess-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	const text = allText(tree);
	assert.match(text, /继承来源: ws-9/);
	assert.match(text, /2026-10-20 12:34:56/, "时间应格式化到秒");
	assert.match(text, /改动不影响工作区/);
});

test("对话无条件且从未配置时：说「尚未配置过」而不是显示 ∅", async () => {
	const { rt, box, slots } = await boot({
		expression: "", sourceWorkspaceId: null, inheritedAt: null, configured: false,
	});
	slots.helpers.manageSet({ open: true, conversationId: "sess-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	const text = allText(tree);
	assert.match(text, /无条件 — 该对话掌握全部技能/);
	// 2026-10-31：own 为 null 的语义是「从未配置过 = 空条件 = 掌握全部技能」，
	// 不能说成「继承了 null 工作区」（那是旧口径的措辞，会误导成"继承坏了"）。
	assert.match(text, /尚未配置过/);
	assert.doesNotMatch(text, /∅/, "空条件不能显示成 ∅（与「掌握全部技能」矛盾）");
});

test("对话有独立配置但未继承时：说「该对话有独立配置」", async () => {
	const { rt, box, slots } = await boot({
		expression: "A", sourceWorkspaceId: null, inheritedAt: null, configured: true,
	});
	slots.helpers.manageSet({ open: true, conversationId: "sess-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	assert.match(allText(tree), /该对话有独立配置（未继承工作区）/);
});

test("已冻结的表达式引用了已删除标签时：界面给出只读提示", async () => {
	const { rt, box, slots } = await boot({
		expression: "已删除的标签",
		configured: true,
		expressionIssue: { ok: false, message: "标签不存在: '已删除的标签'" },
	});
	slots.helpers.manageSet({ open: true, conversationId: "sess-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	const text = allText(tree);
	assert.match(text, /引用了已不存在的标签/, "必须提示，否则用户不知道该条件已失效");
	assert.match(text, /标签不存在/);
});

// ── 继承按钮 ───────────────────────────────────────────────────────────────

test("点「继承工作区配置」→ 打 /conversations/inherit 并刷新", async () => {
	const { rt, box, slots, log } = await boot({ expression: "A" });
	slots.helpers.manageSet({ open: true, conversationId: "sess-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);

	const inheritBtn = btnByText(tree, "继承工作区配置");
	assert.equal(inheritBtn.length, 1);
	inheritBtn[0].props.onClick();
	const after = await rt.settle(slots["shell.overlay"].component, {}, 8, box);

	const call = log.calls.filter((c) => c.path === "/conversations/inherit").pop();
	assert.ok(call, "应调用 /conversations/inherit");
	assert.equal(call.body.conversationId, "sess-1");
	// 假后端继承后的表达式是 A+B*C
	assert.match(allText(after), /已从工作区继承配置/);
});

test("工作区版没有「继承工作区配置」按钮（只有对话版才有）", async () => {
	const { rt, box, slots } = await boot();
	slots.helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	assert.equal(btnByText(tree, "继承工作区配置").length, 0);
	assert.match(allText(tree), /当前工作区的标签条件/);
});

// ── tag 设置（对话版保存目标） ─────────────────────────────────────────────

test("对话版 tag 设置：回显条件，保存按钮指向对话且打 /conversations/expression", async () => {
	const { rt, box, slots, log } = await boot({ expression: "A" });
	slots.helpers.manageSet({ open: true, conversationId: "sess-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);

	btnByText(tree, "tag 设置")[0].props.onClick();
	const opened = await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	const text = allText(opened);
	assert.match(text, /保存到当前对话/);
	assert.match(text, /添加标签组/);

	// 回显已有表达式
	const ta = find(opened, (n) => n.type === "textarea");
	assert.equal(ta[0].props.value, "A", "必须回显对话已保存的表达式");

	// 载入标签组 → 可继续编辑
	const sel = find(opened, (n) => n.type === "select").find((n) => (n.children ?? []).some((c) => texts(c).join("").includes("前端组")));
	assert.ok(sel);
	sel.props.onChange({ target: { value: "tpl-1" } });
	const loaded = await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	assert.equal(find(loaded, (n) => n.type === "textarea")[0].props.value, "A+B*C");

	// 保存 → /conversations/expression（不是 /workspaces/expression）
	const saveBtn = btnByText(loaded, "保存到对话");
	assert.equal(saveBtn.length, 1);
	saveBtn[0].props.onClick();
	await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	const call = log.calls.filter((c) => c.path === "/conversations/expression").pop();
	assert.ok(call, "应调用 /conversations/expression");
	assert.equal(call.body.conversationId, "sess-1");
	assert.equal(call.body.expression, "A+B*C");
	assert.equal(log.calls.some((c) => c.path === "/workspaces/expression"), false, "对话版不该写工作区");
});

test("对话版空条件：不报错、可保存、提交空串", async () => {
	const { rt, box, slots, log } = await boot({ expression: "" });
	slots.helpers.manageSet({ open: true, conversationId: "sess-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	btnByText(tree, "tag 设置")[0].props.onClick();
	const opened = await rt.settle(slots["shell.overlay"].component, {}, 8, box);

	assert.doesNotMatch(allText(opened), /表达式不能为空/);
	assert.doesNotMatch(allText(opened), /✗/);
	const saveBtn = btnByText(opened, "保存到对话");
	assert.equal(saveBtn[0].props.disabled, false);
	saveBtn[0].props.onClick();
	await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	const call = log.calls.filter((c) => c.path === "/conversations/expression").pop();
	assert.equal(call.body.expression, "");
});

// ── 右列操作 ───────────────────────────────────────────────────────────────

test("对话版禁用技能：打 /conversations/skills/disable", async () => {
	const { rt, box, slots, log } = await boot({ expression: "" });
	slots.helpers.manageSet({ open: true, conversationId: "sess-1" });
	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);

	const btns = btnByText(tree, "禁用");
	assert.equal(btns.length, UNIVERSE.length, "每个技能一个禁用按钮");
	btns[1].props.onClick();
	const after = await rt.settle(slots["shell.overlay"].component, {}, 8, box);

	const call = log.calls.filter((c) => c.path === "/conversations/skills/disable").pop();
	assert.ok(call, "应调用对话版禁用端点");
	assert.equal(call.body.conversationId, "sess-1");
	assert.equal(log.calls.some((c) => c.path === "/workspaces/skills/disable"), false);
	assert.match(allText(after), /已禁用/);
	assert.equal(btnByText(after, "禁用").length, UNIVERSE.length - 1, "被禁用的技能从右列消失");
});

// ── 入口二：聊天框左下角「+」→ / 命令菜单 ─────────────────────────────────

test("「+」菜单注册了 /skill-tag-manage 贡献（action 型，不发消息）", async () => {
	const { slots } = await boot();
	const list = slots.commandUi.contributions;
	assert.equal(list.length, 1, "应只注册一条贡献");
	const c = list[0];
	assert.equal(c.name, "skill-tag-manage");
	assert.equal(c.ui.kind, "action", "必须是 action：选中即执行，不往输入框写字");
	assert.equal(typeof c.ui.run, "function");
	assert.equal(c.label(), "管理对话标签");
	assert.match(c.description(), /标签/);
	assert.equal(c.available({ sessionId: "sess-1" }), true);
});

test("点「+」里的管理对话标签：打开对话版浮层并带上 sessionId", async () => {
	const { rt, box, slots } = await boot();
	const c = slots.commandUi.contributions[0];

	c.ui.run({ sessionId: "sess-9" });
	// 浮层此时应指向 sess-9
	assert.equal(slots.helpers.manage.open, true);
	assert.equal(slots.helpers.manage.conversationId, "sess-9");

	const tree = await rt.settle(slots["shell.overlay"].component, {}, 8, box);
	assert.match(allText(tree), /管理标签（对话）/);
	assert.match(allText(tree), /tag 设置/);
});

test("没有 commandUi 服务时插件照常加载，不抛错", async () => {
	const { slots } = await boot({ withCommandUi: false });
	assert.ok(slots["shell.overlay"], "其它槽位仍应注册成功");
	assert.equal(slots.commandUi, undefined);
});

