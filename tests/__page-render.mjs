// 页面渲染测试：不依赖浏览器 / DOM，用最小 React 桩执行 lib/client.js 里真实的
// TemplateGroupPage，验证「标签组配置」页的上下两区结构、表达式回显与点击插入。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "..", "lib", "client.js");
const SOURCE = fs.readFileSync(CLIENT, "utf8");

const FRAGMENT = Symbol("Fragment");

/** 用给定 react 桩和 Section 初始 state 载入 client.js，返回已注册的 Section 组件 */
function boot(react, initialSectionState) {
	const registered = {};
	let section = null;
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		fetch: () => Promise.reject(new Error("no network in test")),
		window: {
			__ModuleLoader__: {
				load: ({ factory }) => {
					const exp = factory((name) => (name === "react" ? react : {}));
					const ctx = {
						effect: (fn) => fn(),
						slots: {
							inject: (_n, fn) => fn(),
							// 现在注册两个槽位：settings.section 与 shell.overlay，按 name 分流
							register: (opts, Comp) => { registered[opts.name] = Comp; if (opts.name === "settings.section") section = Comp; },
						},
					};
					exp.apply(ctx);
				},
			},
			confirm: () => true,
		},
	};
	sandbox.globalThis = sandbox;
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	if (initialSectionState === undefined) return { Section: section, registered };

	// 第二次载入：Section 的 useState 初值换成受控 fixture，并记录 setState 调用
	const calls = [];
	const react2 = {
		...react,
		useState: (init) => {
			if (init && typeof init === "object" && "loading" in init) return [initialSectionState, (fn) => calls.push(fn)];
			return [init, () => {}];
		},
	};
	const sandbox2 = { ...sandbox, window: { ...sandbox.window, __ModuleLoader__: { load: () => {} } } };
	vm.runInNewContext(SOURCE, sandbox2, { filename: "lib/client.js" });
	let section2 = null;
	sandbox2.window.__ModuleLoader__.load = ({ factory }) => {
		const exp = factory((name) => (name === "react" ? react2 : {}));
		exp.apply({
			effect: (fn) => fn(),
			slots: { inject: (_n, fn) => fn(), register: (o, Comp) => { if (o.name === "settings.section") section2 = Comp; } },
		});
	};
	vm.runInNewContext(SOURCE, sandbox2, { filename: "lib/client.js" });
	return { Section: section2, calls };
}

const plainReact = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
	Fragment: FRAGMENT,
	useRef: (init) => ({ current: init ?? null }),
	useEffect: () => {},
	useMemo: (fn) => fn(),
	useCallback: (fn) => fn(),
	useState: (init) => [init, () => {}],
};

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

const baseState = (over = {}) => ({
	loading: false, error: null,
	data: { tags: TAGS, templates: TEMPLATES, skillLinks: [], workspaces: [], conversations: [] },
	skills: [],
	// 失效关联（有标签但当前发现不到）：计数口径与提示条都依赖它
	stale: [],
	newTagName: "", busy: false, notice: null, view: "templates",
	linkTagId: null, tagSearch: "", skillSearch: "", pickOpen: false, pickSearch: "",
	linkSkillName: null, skillTagSearch: "", skillPickSearch: "", skillTagPickOpen: false,
	wsId: "", wsDraft: null, convId: "", convWsId: "",
	tplId: null, tplIsNew: false, tplName: "", tplExpression: "",
	...over,
});

/**
 * 深度优先遍历。createElement 桩不会执行函数组件，所以这里手动展开：
 * 遇到 type 是函数就把 props 灌进去拿到真实子树，再继续下钻。
 * 这样测试跑的是 client.js 里的真实渲染代码，而不是它的复刻版。
 */
function walk(node, visit, depth = 0) {
	if (node === null || node === undefined || node === false) return;
	if (typeof node !== "object") { visit(node); return; }
	if (depth > 60) return;
	visit(node);
	if (typeof node.type === "function") {
		walk(node.type(node.props), visit, depth + 1);
		return;
	}
	for (const c of node.children ?? []) walk(c, visit, depth + 1);
}
const texts = (node) => {
	const out = [];
	walk(node, (n) => { if (typeof n === "string") out.push(n); else if (typeof n === "number") out.push(String(n)); });
	return out;
};
const allText = (node) => texts(node).join("|");
const find = (node, pred) => {
	const hits = [];
	walk(node, (n) => { if (n && typeof n === "object" && n.type !== undefined && pred(n)) hits.push(n); });
	return hits;
};

test("主页面有「编辑标签组」入口按钮，点击切到标签组配置视图", () => {
	const { Section, calls } = boot(plainReact, baseState({ view: "main" }));
	const tree = Section(baseState({ view: "main" }));
	const btn = find(tree, (n) => n.type === "button" && texts(n).join("") === "编辑标签组");
	assert.equal(btn.length, 1, "应有一个「编辑标签组」按钮");
	const before = calls.length;
	btn[0].props.onClick();
	assert.equal(calls.length, before + 1, "点击应触发一次 setState");
	const patch = calls[calls.length - 1]({ view: "main", tplId: "x", tplIsNew: true, tplName: "n", tplExpression: "E" });
	assert.equal(patch.view, "templates");
	assert.equal(patch.tplId, null);
	assert.equal(patch.tplIsNew, false);
	assert.equal(patch.tplExpression, "", "进入页面应清空上次编辑态（避免串组）");
});

test("标签组配置页：标题 + 上方已有标签区 + 下方表达式区", () => {
	const { Section } = boot(plainReact, baseState());
	const tree = Section(baseState());
	const text = allText(tree);
	assert.match(text, /标签组配置/);
	assert.match(text, /已有标签 \(5\)/);
	assert.match(text, /表达式/);

	const tagButtons = find(tree, (n) => n.type === "button" && TAGS.some((t) => t.name === texts(n).join("")));
	assert.equal(tagButtons.length, TAGS.length, "每个已有标签都应是可点击按钮");

	const names = find(tree, (n) => n.type === "strong").map((n) => texts(n).join(""));
	assert.deepEqual(names.sort(), TEMPLATES.map((t) => t.name).sort(), "列表应展示所有标签组");
});

test("再次编辑回显已保存表达式（关键需求 3）", () => {
	for (const tpl of TEMPLATES) {
		const st = baseState({ tplId: tpl.templateId, tplName: tpl.name, tplExpression: tpl.expression });
		const { Section } = boot(plainReact, st);
		const tree = Section(st);
		const ta = find(tree, (n) => n.type === "textarea");
		assert.equal(ta.length, 1, "应有表达式输入框");
		assert.equal(ta[0].props.value, tpl.expression, `打开「${tpl.name}」应回显 ${tpl.expression}`);
		const nameInput = find(tree, (n) => n.type === "input" && String(n.props.placeholder ?? "").includes("标签组名称"));
		assert.equal(nameInput.length, 1);
		assert.equal(nameInput[0].props.value, tpl.name, "名称也应回显");
	}
});

test("未选中标签组时不渲染输入框，并给出引导文案", () => {
	const { Section } = boot(plainReact, baseState());
	const tree = Section(baseState());
	assert.equal(find(tree, (n) => n.type === "textarea").length, 0);
	assert.match(allText(tree), /未在编辑/);
	assert.match(allText(tree), /将回显已保存的表达式/);
});

test("点击已有标签会把「插入表达式」写进表达式（含自动补 + 与引号）", () => {
	const st = baseState({ tplId: "tpl-1", tplName: "前端组", tplExpression: "A" });
	const { Section, calls } = boot(plainReact, st);
	const tree = Section(st);
	const btnB = find(tree, (n) => n.type === "button" && texts(n).join("") === "B");
	assert.equal(btnB.length, 1);
	btnB[0].props.onClick();
	assert.ok(calls.length > 0, "点击标签应触发 setState");
	const patch = calls[calls.length - 1](st);
	assert.equal(patch.tplExpression, "A + B", "光标在末尾时应自动补 + 再插入标签");

	// 含空格的名字自动加引号
	const st2 = baseState({ tplId: "tpl-1", tplName: "前端组", tplExpression: "A" });
	const boot2 = boot(plainReact, st2);
	const tree2 = boot2.Section(st2);
	const btnMT = find(tree2, (n) => n.type === "button" && texts(n).join("") === "my tag");
	btnMT[0].props.onClick();
	const patch2 = boot2.calls[boot2.calls.length - 1](st2);
	assert.equal(patch2.tplExpression, 'A + "my tag"');
});

test("运算符工具条插入 + / * / ( / )", () => {
	const st = baseState({ tplId: "tpl-1", tplName: "g", tplExpression: "" });
	const { Section, calls } = boot(plainReact, st);
	const tree = Section(st);
	const plusBtn = find(tree, (n) => n.type === "button" && texts(n).join("") === "+ OR");
	assert.equal(plusBtn.length, 1);
	plusBtn[0].props.onClick();
	const patch = calls[calls.length - 1](st);
	assert.equal(patch.tplExpression, "+", "空表达式插入运算符不该自动补 +");

	const lparen = find(tree, (n) => n.type === "button" && texts(n).join("") === "(");
	assert.equal(lparen.length, 1);
});

test("保存按钮在校验通过前禁用；校验通过后可点", () => {
	const st = baseState({ tplId: "tpl-1", tplName: "前端组", tplExpression: "A+B" });
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const save = find(tree, (n) => n.type === "button" && texts(n).join("") === "保存");
	assert.equal(save.length, 1);
	// 初始（还没拿到 validation）应禁用，防止保存未校验的表达式
	assert.equal(save[0].props.disabled, true);
});

test("新建态显示「保存新建」，编辑态显示「保存」+「删除标签组」", () => {
	const newSt = baseState({ tplIsNew: true });
	const g1 = boot(plainReact, newSt);
	const t1 = g1.Section(newSt);
	assert.equal(find(t1, (n) => n.type === "button" && texts(n).join("") === "保存新建").length, 1);
	assert.equal(find(t1, (n) => n.type === "button" && texts(n).join("") === "删除标签组").length, 0);

	const editSt = baseState({ tplId: "tpl-1", tplName: "前端组", tplExpression: "A" });
	const g2 = boot(plainReact, editSt);
	const t2 = g2.Section(editSt);
	assert.equal(find(t2, (n) => n.type === "button" && texts(n).join("") === "保存").length, 1);
	assert.equal(find(t2, (n) => n.type === "button" && texts(n).join("") === "删除标签组").length, 1);
});

test("helpers.quoteTagName：特殊字符名自动加引号", () => {
	const section = boot(plainReact);
	void section;
	// 用 Section 的模块导出取纯函数
	let helpers = null;
	const sandbox = { console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error("x")), window: { __ModuleLoader__: { load: ({ factory }) => { helpers = factory(() => plainReact).__test; } }, confirm: () => true } };
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	assert.equal(helpers.quoteTagName("A"), "A");
	assert.equal(helpers.quoteTagName("my tag"), '"my tag"');
	assert.equal(helpers.quoteTagName("a+b"), '"a+b"');
	assert.equal(helpers.quoteTagName("("), '"("');
	assert.equal(helpers.quoteTagName("已经带了"), "已经带了");
	assert.equal(helpers.quoteTagName("a-b"), "a-b", "连字符不是运算符，无需引号");
});

// ── 本轮新增：导航改名 + skill 联系 tag 页 + 打开文件夹按钮 ─────────────────

function loadHelpers(over = {}) {
	let helpers = null;
	const sandbox = {
		console, setTimeout, clearTimeout,
		fetch: over.fetch ?? (() => Promise.reject(new Error("x"))),
		window: {
			__ModuleLoader__: { load: ({ factory }) => { helpers = factory(() => plainReact).__test; } },
			confirm: () => true,
			alert: over.alert ?? (() => {}),
		},
	};
	vm.runInNewContext(SOURCE, sandbox, { filename: "lib/client.js" });
	return helpers;
}

test("主页面导航：只保留 tag 联系 skill / skill 联系 tag / 编辑标签组 三个按钮", () => {
	const st = baseState({ view: "main" });
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const nav = find(tree, (n) => n.type === "button").map((n) => texts(n).join(""));
	assert.ok(nav.includes("tag 联系 skill"), "原「Skill 关联」应改名为「tag 联系 skill」");
	assert.ok(nav.includes("skill 联系 tag"), "应新增「skill 联系 tag」按钮");
	assert.ok(nav.includes("编辑标签组"), "标签组入口保留");
	assert.ok(!nav.includes("Skill 关联"), "旧文案不得残留");
});

// 主页面（设置页）已经砍掉工作区/对话两块编辑器：它们在该页面上没人用，
// 真正的配置入口是工作区行菜单与会话行菜单里的「管理标签」。
test("主页面不再渲染工作区布尔配置 / 对话编辑器", () => {
	const st = baseState({ view: "main" });
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const text = allText(tree);
	assert.ok(!text.includes("工作区布尔配置"), "不得出现「工作区布尔配置」卡片");
	assert.ok(!text.includes("对话 ID(=项目路径)"), "不得出现对话编辑器的输入框占位符");
	assert.ok(!/对话 \(\d+\)/.test(text), "不得出现「对话 (N)」卡片标题");
	// 但页面主体还在：标题 / 三个导航按钮 / 新建标签 / 标签列表
	assert.ok(text.includes("Skill 标签管理"));
	assert.ok(text.includes("新建标签"));
	assert.ok(text.includes(`标签 (${TAGS.length})`));
});

test("已有标签默认折叠：只显示数量，不列出技能名", () => {
	const links = [
		{ skillId: "alpha", tagIds: ["t-a"] },
		{ skillId: "beta", tagIds: ["t-a"] },
		{ skillId: "gamma", tagIds: ["t-a"] },
	];
	const st = baseState({ view: "main", data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: links } });
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const text = allText(tree);
	assert.ok(text.includes("3 个 Skill"), "应显示「3 个 Skill」计数");
	assert.ok(!text.includes("alpha"), "折叠时不得出现技能名");
	assert.ok(!text.includes("beta"));
	assert.ok(!text.includes("gamma"));
	// 行里应该有折叠箭头
	assert.equal(find(tree, (n) => n.props?.["data-skill-tag-toggle"] === "t-a").length, 1, "t-a 行应有展开按钮");
});

test("点展开按钮 toggle 该标签的展开态；默认折叠、展开后才列出技能", () => {
	const links = [
		{ skillId: "alpha", tagIds: ["t-a"] },
		{ skillId: "beta", tagIds: ["t-a"] },
	];
	const base = { view: "main", data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: links } };

	// 折叠态：不出现技能名
	{
		const { Section } = boot(plainReact, baseState(base));
		assert.ok(!allText(Section(baseState(base))).includes("alpha"), "折叠时不得列出技能名");
	}

	// 点 ▸ → 应把该标签标成展开
	{
		const st = baseState(base);
		const { Section, calls } = boot(plainReact, st);
		const toggle = find(Section(st), (n) => n.props?.["data-skill-tag-toggle"] === "t-a")[0];
		toggle.props.onClick();
		const patch = calls[calls.length - 1](st);
		assert.equal(patch.openTags["t-a"], true, "点击应把该标签标成展开");
		// 不影响别的标签（t-b 无关联，这里只需保证 map 不整体翻转）
		assert.equal(patch.openTags["t-b"], undefined, "只影响被点击的标签");
	}

	// 展开态：列出技能名，且每行仍带「打开文件夹」
	{
		const st = baseState({ ...base, openTags: { "t-a": true } });
		const { Section, calls } = boot(plainReact, st);
		const tree = Section(st);
		const text = allText(tree);
		assert.ok(text.includes("alpha"), "展开后应列出技能名");
		assert.ok(text.includes("beta"));
		assert.equal(find(tree, (n) => n.props?.["data-skill-tag-reveal"] === "alpha").length, 1, "展开行仍应保留 📁 按钮");
		// 再点一次应收起
		find(tree, (n) => n.props?.["data-skill-tag-toggle"] === "t-a")[0].props.onClick();
		assert.equal(calls[calls.length - 1](st).openTags["t-a"], false, "再点应收起");
	}
});

test("没有关联技能的标签不渲染展开箭头，显示「无 Skill 关联」", () => {
	const st = baseState({ view: "main", data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: [] } });
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	assert.ok(allText(tree).includes("无 Skill 关联"));
	assert.equal(find(tree, (n) => n.props?.["data-skill-tag-toggle"]).length, 0, "空标签不应有展开按钮");
});

test("点击「skill 联系 tag」切到 skilltags 视图并清空上次选中", () => {
	const st = baseState({ view: "main", linkSkillName: "old", skillPickSearch: "x" });
	const { Section, calls } = boot(plainReact, st);
	const tree = Section(st);
	const btn = find(tree, (n) => n.type === "button" && texts(n).join("") === "skill 联系 tag");
	assert.equal(btn.length, 1);
	btn[0].props.onClick();
	const patch = calls[calls.length - 1](st);
	assert.equal(patch.view, "skilltags");
	assert.equal(patch.linkSkillName, null);
	assert.equal(patch.skillPickSearch, "");
});

test("skill 联系 tag 页：左列技能 / 右列标签，未选中时给引导", () => {
	const skills = [
		{ name: "alpha", path: "C:\\s\\alpha\\SKILL.md" },
		{ name: "beta", path: "C:\\s\\beta\\SKILL.md" },
	];
	const st = baseState({
		view: "skilltags", skills,
		data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: [{ skillId: "alpha", tagIds: ["t-a"] }] },
	});
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const text = allText(tree);
	assert.match(text, /skill 联系 tag/);
	assert.match(text, /技能 \(2\)/);
	assert.match(text, /先在左侧选中一个技能/, "未选中技能时应给引导");
	// 每行技能都带「打开文件夹」（这里是 📁 简写）
	assert.equal(find(tree, (n) => n.props?.["data-skill-tag-reveal"] === "alpha").length, 1);
	assert.equal(find(tree, (n) => n.props?.["data-skill-tag-reveal"] === "beta").length, 1);
});

test("skill 联系 tag 页：选中技能后右列勾选其已有标签，勾选即保存", () => {
	const skills = [{ name: "alpha", path: "C:\\s\\alpha\\SKILL.md" }];
	const st = baseState({
		view: "skilltags", skills, linkSkillName: "alpha",
		data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: [{ skillId: "alpha", tagIds: ["t-a", "t-c"] }] },
	});
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const boxes = find(tree, (n) => n.type === "input" && n.props?.type === "checkbox");
	assert.equal(boxes.length, TAGS.length, "每个标签一个勾选框");
	const checkedNames = boxes.filter((b) => b.props.checked).length;
	assert.equal(checkedNames, 2, "已有 2 个标签应处于勾选态");
	assert.match(allText(tree), /已拥有: A, C/);
	// 勾选框必须带 onChange（"勾选即保存"，没有保存按钮）
	assert.equal(boxes.filter((b) => typeof b.props.onChange === "function").length, TAGS.length);
	// 清空按钮：已有标签时可点
	const clear = find(tree, (n) => n.type === "button" && texts(n).join("") === "清空标签");
	assert.equal(clear.length, 1);
	assert.equal(clear[0].props.disabled, false);
});

test("「打开文件夹」按钮：有 path 时把它发给 /skills/reveal", async () => {
	const sent = [];
	// fetch 必须注入 sandbox（client.js 在 vm 上下文里，看不到 globalThis.fetch）
	const helpers = loadHelpers({
		fetch: async (url, init) => {
			sent.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
			return { json: async () => ({ ok: true }) };
		},
	});
	const skills = [{ name: "alpha", path: "C:\\s\\alpha\\SKILL.md" }];
	const btn = helpers.RevealButton({ skillName: "alpha", skills });
	assert.equal(btn.props["data-skill-tag-reveal"], "alpha");

	await btn.props.onClick({ stopPropagation() {} });
	assert.equal(sent.length, 1);
	assert.match(sent[0].url, /\/skill-tag\/api\/skills\/reveal$/);
	assert.equal(sent[0].body.path, "C:\\s\\alpha\\SKILL.md");
});

test("「打开文件夹」按钮：没有 path 时退回按 skillName 查询，失败弹 alert", async () => {
	const sent = [];
	const alerts = [];
	const helpers = loadHelpers({
		fetch: async (url, init) => {
			sent.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
			return { json: async () => ({ ok: false, error: "技能文件不存在" }) };
		},
		alert: (m) => alerts.push(m),
	});
	const btn = helpers.RevealButton({ skillName: "ghost", skills: [] });
	await btn.props.onClick({ stopPropagation() {} });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].body.skillName, "ghost");
	assert.equal(sent[0].body.path, undefined, "不知道 path 时不能瞎猜");
	assert.equal(alerts.length, 1, "失败必须让用户看到，不能静默");
	assert.match(alerts[0], /技能文件不存在/);
});

test("helpers.skillPathOf：名字 → 路径，未扫描到的返回 null", () => {
	const helpers = loadHelpers();
	const skills = [{ name: "alpha", path: "C:\\a\\SKILL.md" }, "beta"];
	assert.equal(helpers.skillPathOf(skills, "alpha"), "C:\\a\\SKILL.md");
	assert.equal(helpers.skillPathOf(skills, "beta"), null, "字符串条目没有 path");
	assert.equal(helpers.skillPathOf(skills, "ghost"), null);
	assert.equal(helpers.skillPathOf(undefined, "alpha"), null);
});

test("skill 联系 tag 页：技能已拥有的标签排在前面（分区稳定，内部保持原序）", () => {
	const skills = [{ name: "alpha", path: "C:\s\alpha\SKILL.md" }];
	// TAGS 原序：A, B, C, my tag, a+b；alpha 拥有 t-c 与 t-plus（原本都在末尾）→ 应前移
	const st = baseState({
		view: "skilltags", skills, linkSkillName: "alpha",
		data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: [{ skillId: "alpha", tagIds: ["t-c", "t-plus"] }] },
	});
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const labels = find(tree, (n) => n.type === "label").map((n) => texts(n).join(""));
	assert.deepEqual(labels, ["C", "a+b", "A", "B", "my tag"], "已拥有标签前移，未拥有的仍按原顺序");
	// 勾选态不受排序影响
	const boxes = find(tree, (n) => n.type === "input" && n.props?.type === "checkbox");
	assert.deepEqual(boxes.map((b) => b.props.checked), [true, true, false, false, false]);
});

test("skill 联系 tag 页：搜索时「已拥有优先」依然成立", () => {
	const skills = [{ name: "alpha", path: "C:\s\alpha\SKILL.md" }];
	// 搜 "a" 命中 A / my tag? no → A(t-a)、a+b(t-plus)；alpha 拥有 t-plus → a+b 应排第一
	const st = baseState({
		view: "skilltags", skills, linkSkillName: "alpha", skillTagSearch: "a",
		data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: [{ skillId: "alpha", tagIds: ["t-plus"] }] },
	});
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const labels = find(tree, (n) => n.type === "label").map((n) => texts(n).join(""));
	// 搜 "a" 命中 A / my tag（含字母 a）/ a+b，已拥有的 a+b 排到最前
	assert.deepEqual(labels, ["a+b", "A", "my tag"], "过滤后仍先列已拥有的");
});

test("helpers.ownedTagsFirst：纯分区，不改内容也不丢项", () => {
	const helpers = loadHelpers();
	const tags = [{ tagId: "a" }, { tagId: "b" }, { tagId: "c" }];
	// 注意：返回值是 vm 沙箱里的数组，跨 realm 的 deepStrictEqual 会失败，统一比 JSON
	const ids = (out) => JSON.stringify(out.map((t) => t.tagId));
	assert.equal(ids(helpers.ownedTagsFirst(tags, ["c"])), '["c","a","b"]');
	assert.equal(ids(helpers.ownedTagsFirst(tags, ["a", "c"])), '["a","c","b"]');
	assert.equal(ids(helpers.ownedTagsFirst(tags, [])), '["a","b","c"]', "没有标签时顺序不变");
	assert.equal(ids(helpers.ownedTagsFirst(tags, undefined)), '["a","b","c"]');
	// 拥有的 id 在 tags 里不存在（幽灵/已删标签）不得凭空插入
	assert.equal(ids(helpers.ownedTagsFirst(tags, ["zzz"])), '["a","b","c"]');
	assert.equal(ids(helpers.ownedTagsFirst([], ["a"])), "[]");
});
// ── 刷新技能列表 / 失效关联（2026-10-31） ────────────────────────────────
//
// 用户场景：某些技能由别的插件 provider 注册，根本不落在文件系统根里。那个
// 插件被 disable 后技能立刻消失，但 skillLinks 记录还在 —— 旧实现把幽灵技能
// 也算进「技能 (N)」，于是数字永远不降（本机 82 真 + 25 幽灵 = 107）。

test("主页面有「刷新技能列表」按钮，且带稳定的 data 钩子", () => {
	const { Section } = boot(plainReact, baseState({ view: "main" }));
	const tree = Section(baseState({ view: "main" }));
	const btn = find(tree, (n) => n.props?.["data-skill-tag-refresh"] === "1");
	assert.equal(btn.length, 1, "主页面应有一个刷新按钮");
	assert.equal(texts(btn[0]).join(""), "刷新技能列表");
	assert.equal(typeof btn[0].props.onClick, "function", "按钮必须可点");
});

test("主页面：没有失效关联时不渲染提示条", () => {
	const st = baseState({ view: "main", stale: [] });
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	assert.equal(find(tree, (n) => n.props?.["data-skill-tag-purge"] === "1").length, 0);
	assert.ok(!allText(tree).includes("当前发现不到"));
});

test("主页面：有失效关联时渲染提示条 + 清理按钮，且给出条数", () => {
	const stale = [{ skillId: "gone-a", tagIds: ["t-a"] }, { skillId: "gone-b", tagIds: ["t-b", "t-c"] }];
	const st = baseState({ view: "main", stale });
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const text = allText(tree);
	assert.match(text, /有 2 个技能仍有标签关联，但当前发现不到/);
	const purge = find(tree, (n) => n.props?.["data-skill-tag-purge"] === "1");
	assert.equal(purge.length, 1);
	assert.equal(texts(purge[0]).join(""), "清理失效关联");
	assert.equal(purge[0].props.disabled, false, "不 busy 时清理按钮可点");
});

test("skill 联系 tag 页：技能计数只算真实技能，失效单独计数", () => {
	const skills = [{ name: "alpha" }, { name: "beta" }];
	const stale = [{ skillId: "gone-a", tagIds: ["t-a"] }, { skillId: "gone-b", tagIds: [] }];
	const st = baseState({
		view: "skilltags", skills, stale,
		data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: [{ skillId: "alpha", tagIds: ["t-a"] }] },
	});
	const { Section } = boot(plainReact, st);
	const text = allText(Section(st));
	assert.match(text, /技能 \(2\)/, "计数必须是 2（真实技能），不含幽灵");
	assert.match(text, /失效 2/, "失效数量单独显示");
	assert.ok(!/技能 \(4\)/.test(text), "不得把幽灵算进总数");
});

test("skill 联系 tag 页：失效技能单列且不混进真实技能行", () => {
	const skills = [{ name: "alpha" }];
	const stale = [{ skillId: "gone-a", tagIds: ["t-a"] }];
	const st = baseState({
		view: "skilltags", skills, stale,
		data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: [{ skillId: "gone-a", tagIds: ["t-a"] }] },
	});
	const { Section } = boot(plainReact, st);
	const tree = Section(st);
	const text = allText(tree);
	assert.match(text, /失效 1 个（有标签关联，但当前发现不到）/);
	assert.match(text, /gone-a/);
	// 失效技能不给「打开文件夹」（本机没有这个文件，点了必然失败）
	assert.equal(find(tree, (n) => n.props?.["data-skill-tag-reveal"] === "gone-a").length, 0);
});

test("skill 联系 tag 页：选中已失效的技能时给出解释而不是空白", () => {
	const stale = [{ skillId: "gone-a", tagIds: ["t-a"] }];
	const st = baseState({
		view: "skilltags", skills: [{ name: "alpha" }], stale, linkSkillName: "gone-a",
		data: { tags: TAGS, templates: [], workspaces: [], conversations: [], skillLinks: [{ skillId: "gone-a", tagIds: ["t-a"] }] },
	});
	const { Section } = boot(plainReact, st);
	const text = allText(Section(st));
	assert.match(text, /「gone-a」当前发现不到/);
	assert.match(text, /重新启用插件后自动恢复可见/);
});
