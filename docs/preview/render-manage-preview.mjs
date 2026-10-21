// 生成「管理标签」界面的可视化预览（不依赖浏览器控制扩展）
//
// 做法：复用 tests/__manage-render.mjs 里的迷你 React 运行时，真正执行 lib/client.js
// 中的 ManageTagsDialog / TagSettingsDialog，把渲染结果序列化成 HTML，再用 headless
// Edge 截图。这样预览图和真实组件同源，不会"图文不符"。
//
// 用法：node docs/preview/render-manage-preview.mjs
// 产物：docs/preview/管理标签-preview.html

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
	const view = () => {
		const hasFilter = state.expression.trim() !== "";
		const hit = (name) => {
			const ids = new Set((LINKS.find((l) => l.skillId === name)?.tagIds) ?? []);
			if (!hasFilter) return true;
			// 简化：命中 = 含「前端」或（含「测试」且含「文档」）
			return ids.has("t-a") || (ids.has("t-b") && ids.has("t-c"));
		};
		const matched = hasFilter ? UNIVERSE.filter(hit) : UNIVERSE.slice();
		const visible = [];
		for (const n of matched) if (!state.disabledSkills.includes(n)) visible.push(n);
		for (const n of state.manualSkills) if (!state.disabledSkills.includes(n) && !visible.includes(n)) visible.push(n);
		return { hasFilter, matched, manual: state.manualSkills.slice(), disabled: state.disabledSkills.slice(), visible };
	};
	const respond = (p) => {
		if (p === "/state") return { ok: true, tags: TAGS, skillLinks: LINKS, templates: TEMPLATES, workspaces: [], conversations: [] };
		if (p === "/workspaces/skills") {
			// config 跟随 expression，让左列「解析结果」能真实显示
			const expr = state.expression.trim();
			const config = expr === ""
				? { orTags: [], andGroups: [] }
				: { orTags: ["t-a"], andGroups: [{ groupId: "g1", tagIds: ["t-b", "t-c"] }] };
			return {
				ok: true, workspaceId: "ws-1", expression: state.expression,
				config,
				manualSkills: state.manualSkills, disabledSkills: state.disabledSkills,
				candidates: [], universe: UNIVERSE, view: view(),
			};
		}
		if (p === "/templates/validate") {
			// 与真实服务端同语义：allowEmpty=true 时空表达式合法（无条件）
			const empty = String(state.expression).trim() === "";
			if (empty) {
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
		if (p === "/workspaces/expression") { state.expression = JSON.parse(state.lastBody ?? "{}").expression ?? ""; return { ok: true, workspace: {} }; }
		return { ok: true };
	};
	return async (url, init) => {
		const p = String(url).replace("/skill-tag/api", "");
		if (init?.body) state.lastBody = init.body;
		const payload = respond(p);
		return { json: async () => payload };
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
		useEffect(fn) {
			const s = storeOf(react.__cur);
			s.cursor++;
			pendingEffects.push(fn);
		},
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
	async function settle(Comp, props, rounds = 8) {
		let tree = null;
		for (let r = 0; r < rounds; r += 1) {
			pendingEffects.length = 0;
			tree = renderComponent(Comp, props);
			tree = expand(tree);
			drain();
			await new Promise((res) => setTimeout(res, 0));
			await new Promise((res) => setTimeout(res, 0));
		}
		return tree;
	}
	function expand(node, depth = 0) {
		if (node === null || node === undefined || node === false) return node;
		if (typeof node !== "object") return node;
		if (depth > 40) return node;
		if (typeof node.type === "function") return expand(renderComponent(node.type, node.props), depth + 1);
		return { ...node, children: (node.children ?? []).map((c) => expand(c, depth + 1)) };
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

function frame(title, bodyHtml) {
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { margin:0; background:#0e1117; color:#d7dce5; font-family:"Microsoft YaHei",ui-sans-serif,system-ui; }
  .cap { padding:12px 20px 4px; font-size:13px; color:#8b93a7; }
  .cap b { color:#e6ebf5; font-weight:600; }
  .shot { padding:10px 20px 22px; }
  /* 让浮层在静态预览里居中显示，而不是固定定位溢出 */
  .shot > div { position:static !important; background:transparent !important; }
  button, select, input, textarea { font-family:inherit; }
</style></head><body>${bodyHtml}</body></html>`;
}

async function renderScene({ runtime, Dialog, helpers, state, steps, title, file }) {
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	let tree = await runtime.settle(Dialog, {});
	await steps(tree, () => runtime.settle(Dialog, {}));
	const html = frame(title, `<div class="cap"><b>${esc(title)}</b></div><div class="shot">${toHtml(tree)}</div>`);
	fs.writeFileSync(path.join(HERE, file), html);
	return html;
}

const htmls = [];

// 场景①：双列主界面（工作区已有条件 前端+测试*文档）
{
	const rt = makeRuntime();
	const state = { expression: "前端+测试*文档", manualSkills: ["xlsx"], disabledSkills: ["pdf"], lastBody: null };
	const sandbox = { console, setTimeout, clearTimeout, fetch: makeFetcher(state), window: { confirm: () => true, __ModuleLoader__: { load: () => {} } } };
	sandbox.globalThis = sandbox;
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	let Dialog = null, helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({ effect: (fn) => fn(), slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } } });
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	const tree = await rt.settle(Dialog, {});
	htmls.push(frame("场景① 双列主界面", `<div class="cap"><b>场景①</b> 工作区已有条件 <code>前端+测试*文档</code>，pdf 被禁用、xlsx 为手动添加</div><div class="shot">${toHtml(tree)}</div>`));
}

// 场景②：tag 设置弹窗（载入标签组后）
{
	const rt = makeRuntime();
	const state = { expression: "", manualSkills: [], disabledSkills: [], lastBody: null };
	const sandbox = { console, setTimeout, clearTimeout, fetch: makeFetcher(state), window: { confirm: () => true, __ModuleLoader__: { load: () => {} } } };
	sandbox.globalThis = sandbox;
	let Dialog = null, helpers = null;
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? rt.react : {}));
		helpers = exp.__test;
		exp.apply({ effect: (fn) => fn(), slots: { inject: (_n, fn) => fn(), register: (o, C) => { if (o.name === "shell.overlay") Dialog = C; } } });
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	helpers.manageSet({ open: true, workspaceId: "ws-1" });
	let tree = await rt.settle(Dialog, {});
	// 点「tag 设置」
	const walk = (n, f) => { if (!n || typeof n !== "object") return; f(n); for (const c of n.children ?? []) walk(c, f); };
	const btn = [];
	walk(tree, (n) => { if (n.type === "button" && (n.children ?? []).join("").includes("tag 设置")) btn.push(n); });
	if (btn[0]) btn[0].props.onClick();
	tree = await rt.settle(Dialog, {});
	htmls.push(frame("场景② tag 设置弹窗", `<div class="cap"><b>场景②</b> 「tag 设置」：可选择标签组载入运算、点击已有标签插入、实时校验</div><div class="shot">${toHtml(tree)}</div>`));
}

const out = htmls.join("");
fs.writeFileSync(path.join(HERE, "管理标签-preview.html"), `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>管理标签 · 界面预览</title>
<style>
 body{margin:0;background:#0e1117;color:#d7dce5;font-family:"Microsoft YaHei",ui-sans-serif,system-ui;padding:18px 0 30px}
 .cap{padding:10px 24px 4px;font-size:13px;color:#8b93a7} .cap b{color:#e6ebf5}
 .shot{padding:8px 24px 26px}
 .shot>div{position:static!important;display:block!important;background:transparent!important;inset:auto!important}
 .shot>div>div{margin:0 auto}
 h1{font-size:16px;padding:0 24px;margin:8px 0 4px}
</style></head><body><h1>管理标签 · 界面预览</h1>${htmls.map((h) => h.replace(/^[\s\S]*<body>/, "").replace(/<\/body>[\s\S]*$/, "")).join("")}</body></html>`);
console.log("wrote docs/preview/管理标签-preview.html");
