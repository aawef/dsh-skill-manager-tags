// 生成「对话 → 管理标签」界面的可视化预览（不依赖浏览器控制扩展）
//
// 做法同 render-manage-preview.mjs：用迷你 React 运行时真正执行 lib/client.js 里的
// ManageTagsDialog（对话作用域）与 TagSettingsDialog，序列化成 HTML，再用 headless Edge 截图。
//
// 用法：node docs/preview/render-conv-preview.mjs
// 产物：docs/preview/对话管理标签-preview.html

import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
const FRAGMENT = Symbol("Fragment");

const TAGS = [
	{ tagId: "t-a", name: "前端" },
	{ tagId: "t-b", name: "测试" },
	{ tagId: "t-c", name: "文档" },
];
const TEMPLATES = [
	{ templateId: "tpl-1", name: "前端组", expression: "前端+测试*文档" },
	{ templateId: "tpl-2", name: "纯后端", expression: "(前端+测试)*文档" },
];
const UNIVERSE = ["code-review", "tdd", "docx", "xlsx", "pdf", "webapp-testing"];
const LINKS = [
	{ skillId: "code-review", tagIds: ["t-a"] },
	{ skillId: "tdd", tagIds: ["t-b"] },
	{ skillId: "docx", tagIds: ["t-c"] },
	{ skillId: "pdf", tagIds: ["t-c"] },
];

function makeFetcher(state) {
	const hasFilter = () => state.expression.trim() !== "";
	const hit = (name) => {
		const ids = new Set((LINKS.find((l) => l.skillId === name)?.tagIds) ?? []);
		if (!hasFilter()) return true;
		return ids.has("t-a") || (ids.has("t-b") && ids.has("t-c"));
	};
	const view = () => {
		const f = hasFilter();
		const matched = f ? UNIVERSE.filter(hit) : UNIVERSE.slice();
		const visible = [];
		for (const n of matched) if (!state.disabledSkills.includes(n)) visible.push(n);
		for (const n of state.manualSkills) if (!state.disabledSkills.includes(n) && !visible.includes(n)) visible.push(n);
		return { hasFilter: f, matched, manual: state.manualSkills.slice(), disabled: state.disabledSkills.slice(), visible };
	};
	const payload = () => ({
		ok: true,
		conversationId: state.conversationId,
		workspaceId: state.sourceWorkspaceId,
		expression: state.expression,
		config: hasFilter() ? { orTags: ["t-a"], andGroups: [{ groupId: "g1", tagIds: ["t-b", "t-c"] }] } : { orTags: [], andGroups: [] },
		manualSkills: state.manualSkills.slice(),
		disabledSkills: state.disabledSkills.slice(),
		inheritedAt: state.inheritedAt,
		sourceWorkspaceId: state.sourceWorkspaceId,
		candidates: hasFilter() ? UNIVERSE.filter(hit) : [],
		universe: UNIVERSE,
		view: view(),
	});
	const respond = (p) => {
		if (p === "/state") return { ok: true, tags: TAGS, skillLinks: LINKS, templates: TEMPLATES, workspaces: [], conversations: [] };
		if (p === "/conversations/config") return payload();
		if (p === "/conversations/inherit") {
			// 假装工作区那份配置：前端+测试*文档 / 手动 xlsx / 禁用 pdf
			state.expression = "前端+测试*文档";
			state.manualSkills = ["xlsx"];
			state.disabledSkills = ["pdf"];
			state.sourceWorkspaceId = "ws-1";
			state.inheritedAt = new Date().toISOString();
			return payload();
		}
		if (p === "/conversations/expression") { state.expression = JSON.parse(state.lastBody ?? "{}").expression ?? ""; return { ok: true, conversation: {} }; }
		if (p === "/conversations/skills/disable") {
			const n = JSON.parse(state.lastBody ?? "{}").skillName;
			state.disabledSkills.push(n);
			state.manualSkills = state.manualSkills.filter((s) => s !== n);
			return { ok: true, conversation: {} };
		}
		if (p === "/conversations/skills/enable") {
			const n = JSON.parse(state.lastBody ?? "{}").skillName;
			state.disabledSkills = state.disabledSkills.filter((s) => s !== n);
			return { ok: true, conversation: {} };
		}
		if (p === "/conversations/skills/add") { state.manualSkills.push(JSON.parse(state.lastBody ?? "{}").skillName); return { ok: true, conversation: {} }; }
		if (p === "/templates/validate") {
			if (state.expression.trim() === "") {
				return { ok: true, validation: { ok: true, errors: [], warnings: [], normalized: "", config: { orTags: [], andGroups: [] } } };
			}
			return {
				ok: true,
				validation: {
					ok: true, errors: [], warnings: [], normalized: state.expression,
					config: { orTags: ["t-a"], andGroups: [{ groupId: "g1", tagIds: ["t-b", "t-c"] }] },
				},
			};
		}
		return { ok: true };
	};
	return async (url, init) => {
		const p = String(url).replace("/skill-tag/api", "");
		if (init?.body) state.lastBody = init.body;
		const out = respond(p);
		return { json: async () => out };
	};
}

function makeRuntime() {
	const stores = new Map();
	const pendingEffects = [];
	function storeOf(Comp) {
		let s = stores.get(Comp);
		if (!s) { s = { hooks: [], cursor: 0 }; stores.set(Comp, s); }
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
			return [s.hooks[i], (n) => { s.hooks[i] = typeof n === "function" ? n(s.hooks[i]) : n; }];
		},
		useRef(init) {
			const s = storeOf(react.__cur);
			const i = s.cursor++;
			if (!(i in s.hooks)) s.hooks[i] = { current: init ?? null };
			return s.hooks[i];
		},
		useEffect(fn) { storeOf(react.__cur).cursor++; pendingEffects.push(fn); },
		useMemo(fn) { storeOf(react.__cur).cursor++; return fn(); },
		useCallback(fn) { storeOf(react.__cur).cursor++; return fn; },
	};
	function renderComponent(Comp, props) {
		const s = storeOf(Comp);
		s.cursor = 0;
		const prev = react.__cur;
		react.__cur = Comp;
		try { return Comp(props); } finally { react.__cur = prev; }
	}
	function drain() {
		for (const fn of pendingEffects.splice(0)) { try { fn(); } catch { /* 忽略 */ } }
	}
	function expand(node, depth = 0) {
		if (node === null || node === undefined || node === false) return node;
		if (typeof node !== "object") return node;
		if (depth > 40) return node;
		if (typeof node.type === "function") return expand(renderComponent(node.type, node.props), depth + 1);
		return { ...node, children: (node.children ?? []).map((c) => expand(c, depth + 1)) };
	}
	/** 注意：必须 expand 之后才 drain，否则子组件（TagSettingsDialog）的 effect 不会入队 */
	async function settle(Comp, props, rounds = 10) {
		let tree = null;
		for (let r = 0; r < rounds; r += 1) {
			pendingEffects.length = 0;
			tree = expand(renderComponent(Comp, props));
			drain();
			await new Promise((res) => setTimeout(res, 0));
			await new Promise((res) => setTimeout(res, 0));
		}
		pendingEffects.length = 0;
		tree = expand(renderComponent(Comp, props));
		drain();
		return tree;
	}
	return { react, settle };
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

function toHtml(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node !== "object") return esc(node);
	const { type, props = {}, children = [] } = node;
	if (typeof type === "function") return "";
	const inner = children.map(toHtml).join("");
	const tag = typeof type === "string" ? type : "div";
	const attrs = [];
	const p = props ?? {};
	if (p.style && typeof p.style === "object") {
		attrs.push(`style="${esc(Object.entries(p.style).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`).join(";"))}"`);
	}
	if (p.className) attrs.push(`class="${esc(p.className)}"`);
	if (tag === "input") {
		if (p.value !== undefined) attrs.push(`value="${esc(p.value)}"`);
		if (p.placeholder) attrs.push(`placeholder="${esc(p.placeholder)}"`);
		if (p.type) attrs.push(`type="${esc(p.type)}"`);
		if (p.checked) attrs.push("checked");
		return `<input ${attrs.join(" ")}>`;
	}
	if (tag === "textarea") {
		if (p.value !== undefined) attrs.push(`value="${esc(p.value)}"`);
		return `<textarea ${attrs.join(" ")}>${esc(p.value ?? "")}</textarea>`;
	}
	if (tag === "select") {
		const opts = children.map((c) => {
			if (!c || typeof c !== "object" || c.type !== "option") return toHtml(c);
			const sel = c.props?.value === p.value ? " selected" : "";
			return `<option value="${esc(c.props?.value ?? "")}"${sel}>${esc((c.children ?? []).map(toHtml).join(""))}</option>`;
		}).join("");
		return `<select ${attrs.join(" ")}>${opts}</select>`;
	}
	if (tag === "option") return `<option>${inner}</option>`;
	if (tag === "button") {
		if (p.disabled) attrs.push("disabled");
		return `<button ${attrs.join(" ")}>${inner}</button>`;
	}
	return `<${tag} ${attrs.join(" ")}>${inner}</${tag}>`;
}

const walk = (n, f) => { if (!n || typeof n !== "object") return; f(n); for (const c of n.children ?? []) walk(c, f); };
const findBtn = (tree, label) => {
	const out = [];
	walk(tree, (n) => {
		if (n.type === "button" && (n.children ?? []).map(String).join("").trim() === label) out.push(n);
	});
	return out;
};

/** 载入 client.js，取回 shell.overlay 组件与 __test 助手 */
function boot(rt, state) {
	const sandbox = { console, setTimeout, clearTimeout, fetch: makeFetcher(state), window: { confirm: () => true, __ModuleLoader__: { load: () => {} } } };
	sandbox.globalThis = sandbox;
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	const out = { Dialog: null, helpers: null };
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		out.helpers = exp.__test;
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") out.Dialog = C; } },
		});
	};
	// 再跑一次源码，这次 load 已就位，模块才会真正执行并注册槽位
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	return out;
}

function scene(title, note, bodyHtml) {
	return `<div class="cap"><b>${esc(title)}</b> ${note}</div><div class="shot">${bodyHtml}</div>`;
}

const htmls = [];

// 场景①：对话已继承工作区配置（条件 + 手动添加 + 禁用一起搬过来），可在其上继续改
{
	const rt = makeRuntime();
	const state = {
		conversationId: "sess-7f3a", expression: "前端+测试*文档",
		manualSkills: ["xlsx"], disabledSkills: ["pdf"],
		sourceWorkspaceId: "ws-1", inheritedAt: new Date().toISOString(), lastBody: null,
	};
	const { Dialog, helpers } = boot(rt, state);
	helpers.manageSet({ open: true, workspaceId: "", conversationId: "sess-7f3a" });
	const tree = await rt.settle(Dialog, {});
	htmls.push(scene(
		"场景① 对话双列（已继承工作区）",
		"左列多出「继承工作区配置」按钮，并标注继承来源与时间；右列技能同样可查看 tag / 禁用 / 添加",
		`<div class="shot">${toHtml(tree)}</div>`,
	));
}

// 场景②：对话尚未继承任何工作区（独立配置）
{
	const rt = makeRuntime();
	const state = {
		conversationId: "sess-9c11", expression: "",
		manualSkills: [], disabledSkills: [],
		sourceWorkspaceId: null, inheritedAt: null, lastBody: null,
	};
	const { Dialog, helpers } = boot(rt, state);
	helpers.manageSet({ open: true, workspaceId: "", conversationId: "sess-9c11" });
	const tree = await rt.settle(Dialog, {});
	htmls.push(scene(
		"场景② 对话双列（未继承，独立配置）",
		"空条件 = 该对话掌握全部技能；点击「继承工作区配置」会把工作区那份整体搬过来",
		`<div class="shot">${toHtml(tree)}</div>`,
	));
}

// 场景③：对话版「tag 设置」—— 载入标签组后可继续编辑，保存目标是「对话」而不是工作区
{
	const rt = makeRuntime();
	const state = {
		conversationId: "sess-9c11", expression: "前端+测试",
		manualSkills: [], disabledSkills: [],
		sourceWorkspaceId: "ws-1", inheritedAt: new Date().toISOString(), lastBody: null,
	};
	const { Dialog, helpers } = boot(rt, state);
	helpers.manageSet({ open: true, workspaceId: "", conversationId: "sess-9c11" });
	let tree = await rt.settle(Dialog, {});
	findBtn(tree, "tag 设置")[0]?.props?.onClick?.();
	tree = await rt.settle(Dialog, {});
	// 载入标签组「前端组」的运算
	let sel = null;
	walk(tree, (n) => { if (n.type === "select" && (n.children ?? []).some((c) => (c.children ?? []).map(String).join("").includes("前端组"))) sel = n; });
	sel?.props?.onChange?.({ target: { value: "tpl-1" } });
	tree = await rt.settle(Dialog, {});
	htmls.push(scene(
		"场景③ 对话版「tag 设置」",
		"载入标签组「前端组」的运算到运算区后可继续编辑；底部按钮是 <b>保存到对话</b>，不会改工作区",
		`<div class="shot">${toHtml(tree)}</div>`,
	));
}

const head = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>对话管理标签 · 界面预览</title>
<style>
 body{margin:0;background:#0e1117;color:#d7dce5;font-family:"Microsoft YaHei",ui-sans-serif,system-ui;padding:14px 0 30px}
 .cap{padding:12px 24px 4px;font-size:13px;color:#8b93a7} .cap b{color:#e6ebf5}
 /* 静态预览：把浮层的 fixed/absolute 全部拍平，否则嵌套的「tag 设置」会脱离文档流留下一大段空白 */
 .shot *{position:static!important}
 .shot>div{display:block!important;background:transparent!important}
 .shot>div>div{margin:0 auto}
 h1{font-size:16px;padding:0 24px;margin:8px 0 4px}
 code{background:#1b2130;padding:1px 5px;border-radius:4px}
</style></head><body><h1>对话 → 管理标签 · 界面预览</h1>`;
fs.writeFileSync(path.join(HERE, "对话管理标签-preview.html"), head + htmls.join("") + "</body></html>");
console.log("wrote docs/preview/对话管理标签-preview.html");
