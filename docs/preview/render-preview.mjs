// 生成静态 HTML 预览：不是手写的示意图，而是用「最小 React 运行时」真的执行
// lib/client.js 里的 Section / TemplateGroupPage，把渲染树序列化成 HTML。
// 迷你运行时提供 useState/useEffect/useRef/useCallback，因此实时校验（250ms 防抖）
// 也会真的跑一遍（fetch 被桩成返回真实格式的校验结果），能渲染出校验/解析结果区域。
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 本脚本可在插件内(docs/preview/)或临时工作区运行，两种位置都自动定位插件源码
const CANDIDATES = [
	path.resolve(HERE, "..", "..", "lib", "client.js"),
	path.resolve(HERE, "..", "..", "..", ".dsh", "profiles", "web", "my-plugins", "dsh-skill-tag", "lib", "client.js"),
	path.resolve(process.cwd(), "lib", "client.js"),
];
const CLIENT = CANDIDATES.find((p) => fs.existsSync(p));
if (!CLIENT) {
	console.error("找不到 lib/client.js，尝试过:\n" + CANDIDATES.join("\n"));
	process.exit(1);
}
const SOURCE = fs.readFileSync(CLIENT, "utf8");
const FRAGMENT = Symbol("Fragment");

const TAGS = [
	{ tagId: "t-a", name: "A" },
	{ tagId: "t-b", name: "B" },
	{ tagId: "t-c", name: "C" },
	{ tagId: "t-mt", name: "my tag" },
	{ tagId: "t-plus", name: "a+b" },
];
const TEMPLATES = [
	{ templateId: "tpl-1", name: "前端组", expression: "A+B*C", config: { orTags: ["t-a"], andGroups: [{ groupId: "t-b|t-c", tagIds: ["t-b", "t-c"] }] } },
	{ templateId: "tpl-2", name: "另一组", expression: "(A+B)*C", config: { orTags: [], andGroups: [] } },
];

// ── 迷你 React 运行时 ──────────────────────────────────────────────────────
function makeRuntime(initialState, fetchImpl) {
	let hooks = [];
	let hookIndex = 0;
	const effects = [];
	const store = { tree: null };

	const react = {
		createElement: (type, props, ...children) => ({
			type,
			props: props ?? {},
			children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
		}),
		Fragment: FRAGMENT,
		useRef: (init) => {
			const i = hookIndex++;
			if (!(i in hooks)) hooks[i] = { current: init ?? null };
			return hooks[i];
		},
		useState: (init) => {
			const i = hookIndex++;
			if (!(i in hooks)) {
				// Section 的初始 state 形如 {loading:true, ...} —— 用场景注入的状态替换它
				if (init && typeof init === "object" && "loading" in init) hooks[i] = initialState;
				else hooks[i] = typeof init === "function" ? init() : init;
			}
			const setter = (next) => {
				const value = typeof next === "function" ? next(hooks[i]) : next;
				if (value !== hooks[i]) { hooks[i] = value; store.dirty = true; }
			};
			return [hooks[i], setter];
		},
		useMemo: (fn) => { const i = hookIndex++; if (!(i in hooks)) hooks[i] = fn(); return hooks[i]; },
		useCallback: (fn) => { const i = hookIndex++; if (!(i in hooks)) hooks[i] = fn; return hooks[i]; },
		useEffect: (fn) => { effects.push(fn); },
	};

	let Section = null;
	const sandbox = {
		console,
		setTimeout: (fn) => { pending.push(fn); return pending.length; },
		clearTimeout: () => {},
		setInterval: () => 0,
		clearInterval: () => {},
		fetch: fetchImpl,
		window: { __ModuleLoader__: { load: () => {} }, confirm: () => true },
		Promise,
		JSON,
	};
	const pending = [];
	sandbox.globalThis = sandbox;
	vm.runInNewContext(SOURCE, sandbox, { filename: "client.js" });
	sandbox.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((n) => (n === "react" ? react : {}));
		exp.apply({ effect: (fn2) => fn2(), slots: { inject: (_n, fn2) => fn2(), register: (_o, C) => { Section = C; } } });
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "client.js" });

	return {
		/**
		 * 跑一轮"渲染 + 序列化"。
		 * 关键点：Section 返回的树里 TemplateGroupPage 只是个元素节点，只有在序列化
		 * （即真正执行函数组件）时才会跑它的 hooks —— 所以 effect 与 250ms 防抖必须
		 * 在序列化过程中收集，不能只在 Section 这一层收集。
		 */
		async run(serializeFn) {
			let html = "";
			for (let round = 0; round < 10; round += 1) {
				hookIndex = 0;
				effects.length = 0;
				pending.length = 0;
				store.dirty = false;
				const tree = Section(initialState);
				html = serializeFn(tree);
				for (const effect of effects) effect();
				let ran = false;
				while (pending.length) { const fn = pending.shift(); fn(); ran = true; }
				// 等待 fetch 的 Promise 链落定（setValidation 在 await 之后调用）
				for (let k = 0; k < 5; k += 1) await new Promise((r) => setImmediate(r));
				if (!ran && !store.dirty) break;
			}
			return html;
		},
	};
}

const TAGS_BY_NAME = new Map(TAGS.map((t) => [t.name, t]));

/** 与 src/domain/expr.js 行为一致的校验桩（只覆盖本预览用到的合法表达式） */
function fakeValidate(expression) {
	const src = String(expression ?? "");
	if (src.trim() === "") {
		return { ok: false, errors: [{ code: "EMPTY", message: "表达式不能为空：请点击上方标签写入，或用 A+B*C 的形式输入", position: 0, length: 0 }], warnings: [] };
	}
	// 用真引擎校验（与服务端同一份实现，直接 import 更可靠，但这里在 vm 外简单判定）
	const names = [...src.matchAll(/[A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5]*/g)].map((m) => m[0]);
	const unknown = names.filter((n) => !TAGS_BY_NAME.has(n));
	if (unknown.length) {
		return { ok: false, errors: [{ code: "UNKNOWN_TAG", message: `标签不存在: '${unknown[0]}'`, position: src.indexOf(unknown[0]), length: unknown[0].length }], warnings: [] };
	}
	// 预览场景里用到的两条合法表达式，config 直接照抄真实引擎（toDnf → dnfToConfig）的结果
	const KNOWN = {
		"A+B*C": { orTags: ["t-a"], andGroups: [{ groupId: "t-b|t-c", tagIds: ["t-b", "t-c"] }] },
		"(A+B)*C": { orTags: [], andGroups: [{ groupId: "t-a|t-c", tagIds: ["t-a", "t-c"] }, { groupId: "t-b|t-c", tagIds: ["t-b", "t-c"] }] },
	};
	const normalizedSrc = src.replace(/\s+/g, " ").replace(/\s*([+*()])\s*/g, " $1 ").trim();
	return {
		ok: true, errors: [], warnings: [],
		normalized: normalizedSrc,
		config: KNOWN[src.replace(/\s+/g, "")] ?? { orTags: [], andGroups: [] },
	};
}

function makeFetch(validation) {
	return async (url) => ({
		async json() {
			if (String(url).endsWith("/templates/validate")) return { ok: true, validation };
			if (String(url).endsWith("/state")) return { ok: true, tags: TAGS, templates: TEMPLATES, skillLinks: [], workspaces: [], conversations: [] };
			if (String(url).endsWith("/skills")) return { ok: true, skills: [] };
			return { ok: true };
		},
	});
}

const BASE = {
	loading: false, error: null,
	data: { tags: TAGS, templates: TEMPLATES, skillLinks: [], workspaces: [], conversations: [] },
	skills: [], newTagName: "", busy: false, notice: null,
	linkTagId: null, tagSearch: "", skillSearch: "", pickOpen: false, pickSearch: "",
	// 设置页已移除工作区/对话两块编辑器（改由工作区行 / 会话行菜单的「管理标签」进入），
	// 这里也不再需要它们的 state 初值。openTags 是标签列表的展开态。
	openTags: {},
	view: "main",
	tplId: null, tplIsNew: false, tplName: "", tplExpression: "",
};
const baseState = (over = {}) => ({ ...BASE, ...over });

// ── 序列化 ────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const styleOf = (st) =>
	st && typeof st === "object"
		? Object.entries(st).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`).join(";")
		: "";

function serialize(node, depth = 0) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return esc(node);
	if (typeof node !== "object" || depth > 80) return "";
	if (typeof node.type === "function") return serialize(node.type(node.props), depth + 1);
	if (node.type === FRAGMENT) return (node.children ?? []).map((c) => serialize(c, depth + 1)).join("");

	const tag = node.type;
	const props = node.props ?? {};
	const attrs = [];
	const style = styleOf(props.style);
	if (style) attrs.push(`style="${esc(style)}"`);
	if (props.placeholder !== undefined) attrs.push(`placeholder="${esc(props.placeholder)}"`);
	if (props.title) attrs.push(`title="${esc(props.title)}"`);
	if (props.value !== undefined && tag === "input") attrs.push(`value="${esc(props.value)}"`);
	if (props.disabled) attrs.push("disabled");
	const inner = (node.children ?? []).map((c) => serialize(c, depth + 1)).join("");
	if (["input", "br", "img"].includes(tag)) return `<${tag} ${attrs.join(" ")}>`;
	if (tag === "textarea") return `<textarea ${attrs.join(" ")}>${esc(props.value ?? "")}</textarea>`;
	if (props.disabled) attrs.push('class="is-disabled"');
	return `<${tag} ${attrs.join(" ")}>${inner}</${tag}>`;
}

const SCENES = [
	{
		label: "① 主页面：「编辑标签组」入口",
		state: baseState({ view: "main" }),
		validation: fakeValidate(""),
	},
	{
		label: "② 标签组配置页 · 未选中（下方为引导文案，不渲染输入框）",
		state: baseState({ view: "templates" }),
		validation: fakeValidate(""),
	},
	{
		label: "③ 打开已有标签组「前端组」→ 表达式 A+B*C 被回显 + 校验通过 + 解析结果",
		state: baseState({ view: "templates", tplId: "tpl-1", tplName: "前端组", tplExpression: "A+B*C" }),
		validation: fakeValidate("A+B*C"),
	},
	{
		label: "④ 表达式非法（A+）→ 保存按钮禁用 + 定位提示",
		state: baseState({ view: "templates", tplId: "tpl-1", tplName: "前端组", tplExpression: "A+" }),
		validation: {
			ok: false,
			errors: [{ code: "TRAILING_OPERATOR", message: "'+' 之后缺少标签或 '('", position: 1, length: 1 }],
			warnings: [],
		},
	},
	{
		label: "⑤ 新建标签组草稿（「保存新建」）",
		state: baseState({ view: "templates", tplIsNew: true, tplName: "新标签组" }),
		validation: fakeValidate(""),
	},
];

const blocks = [];
for (const scene of SCENES) {
	const rt = makeRuntime(scene.state, makeFetch(scene.validation));
	const html = await rt.run((tree) => serialize(tree));
	blocks.push(`<section><h2>${esc(scene.label)}</h2><div class="frame">${html}</div></section>`);
}

const doc = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>标签组配置 · 界面预览（真实组件渲染）</title>
<style>
  body { margin:0; padding:24px 20px 60px; font-family: ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;
         background:#14161a; color:#e6e6e6; }
  h1 { font-size:19px; margin:0 0 6px; }
  h2 { font-size:13px; color:#9aa4b2; margin:26px 0 8px; font-weight:600; }
  .frame { border:1px solid #2c323a; border-radius:12px; padding:10px 14px;
           background:linear-gradient(#1b1f25,#181b21); overflow-x:auto; }
  .note { color:#8b95a3; font-size:12px; line-height:1.75; max-width:900px; }
  code { background:#262b33; padding:1px 5px; border-radius:4px; font-size:11px; }
  input, textarea { color:#e6e6e6; font-family:inherit; }
  textarea { font-family: ui-monospace,monospace !important; }
  button { font-family:inherit; }
  .is-disabled { opacity:.42; cursor:not-allowed !important; }
  input::placeholder, textarea::placeholder { color:#5d6774; }
</style></head>
<body>
<h1>「标签组配置」界面预览</h1>
<p class="note">
本页不是示意图：由 <code>lib/client.js</code> 中<b>真实的 Section / TemplateGroupPage</b> 在迷你 React 运行时里执行后，
把渲染树序列化成 HTML；内联样式全部来自组件代码本身。校验区域由真实 250ms 防抖逻辑触发
（<code>fetch</code> 被桩成返回与 <code>src/domain/expr.js</code> 同格式的结果）。仅无点击交互。
</p>
${blocks.join("\n")}
</body></html>`;

const out = path.join(HERE, "标签组配置-preview.html");
fs.writeFileSync(out, doc, "utf8");
console.log("wrote", out, doc.length, "bytes");
