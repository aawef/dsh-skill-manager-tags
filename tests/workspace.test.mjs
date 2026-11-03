// 「管理标签」双列界面 — 工作区技能视图的领域语义 + 服务层 + HTTP 层
//
// 覆盖用户确认的三条语义：
//   空条件 + 无手动添加 → 全部技能；有条件 → 严格子集；禁用永远排除且真的屏蔽。

import test from "node:test";
import assert from "node:assert/strict";

import {
	normalizeSkillIds, hasFilter, activeTagsOf, workspaceSkillView,
	workspaceDeniedSkills, normalizeWorkspacePath, splitModelVisible,
} from "../src/domain/workspace.js";
import { createServices } from "../src/service.js";
import { createMemoryRepository } from "../src/storage/repository.js";
import { createApiHandler } from "../src/api.js";

const EMPTY = { orTags: [], andGroups: [] };

// ── 领域纯函数 ──────────────────────────────────────────────────────────────

test("normalizeSkillIds 去空白/去重/保序", () => {
	assert.deepEqual(normalizeSkillIds([" a ", "b", "a", "", null, undefined, "b"]), ["a", "b"]);
	assert.deepEqual(normalizeSkillIds(undefined), []);
});

test("hasFilter：空配置 = 无筛选", () => {
	assert.equal(hasFilter(EMPTY), false);
	assert.equal(hasFilter(undefined), false);
	assert.equal(hasFilter({ orTags: ["t1"], andGroups: [] }), true);
	assert.equal(hasFilter({ orTags: [], andGroups: [{ groupId: "g", tagIds: ["t1", "t2"] }] }), true);
});

test("activeTagsOf 收集 OR 与所有 AND 组成员", () => {
	const s = activeTagsOf({ orTags: ["a"], andGroups: [{ groupId: "g", tagIds: ["b", "c"] }] });
	assert.deepEqual([...s].sort(), ["a", "b", "c"]);
});

test("view：空条件无手动 → 全部技能", () => {
	const v = workspaceSkillView({
		config: EMPTY, manualSkills: [], disabledSkills: [],
		candidates: [], universe: ["s1", "s2", "s3"],
	});
	assert.equal(v.hasFilter, false);
	assert.deepEqual(v.visible, ["s1", "s2", "s3"]);
});

test("view：有条件 → 严格子集（未打 tag 的技能被排除）", () => {
	const v = workspaceSkillView({
		config: { orTags: ["t1"], andGroups: [] },
		manualSkills: [], disabledSkills: [],
		candidates: ["s1", "s3"], universe: ["s1", "s2", "s3"],
	});
	assert.equal(v.hasFilter, true);
	assert.deepEqual(v.visible, ["s1", "s3"]);
});

test("view：手动添加的技能并进可见集合（即使未被标签命中）", () => {
	const v = workspaceSkillView({
		config: { orTags: ["t1"], andGroups: [] },
		manualSkills: ["s2"], disabledSkills: [],
		candidates: ["s1"], universe: ["s1", "s2", "s3"],
	});
	assert.deepEqual(v.matched, ["s1"]);
	assert.deepEqual(v.manual, ["s2"]);
	assert.deepEqual(v.visible, ["s1", "s2"]);
});

test("view：禁用永远排除，即使标签命中或手动添加", () => {
	const v = workspaceSkillView({
		config: { orTags: ["t1"], andGroups: [] },
		manualSkills: ["s2"], disabledSkills: ["s1", "s2"],
		candidates: ["s1", "s3"], universe: ["s1", "s2", "s3"],
	});
	assert.deepEqual(v.visible, ["s3"]);
	assert.deepEqual(v.disabled, ["s1", "s2"]);
});

test("view：手动添加列表里若已禁用则不计入 manual", () => {
	const v = workspaceSkillView({
		config: EMPTY, manualSkills: ["s1"], disabledSkills: ["s1"], candidates: [], universe: ["s1", "s2"],
	});
	assert.deepEqual(v.manual, []);
	assert.deepEqual(v.visible, ["s2"]);
});

test("denied：全部技能 − 可见，并上禁用的", () => {
	const denied = workspaceDeniedSkills({
		config: { orTags: ["t1"], andGroups: [] },
		manualSkills: ["s2"], disabledSkills: ["s3"],
		candidates: ["s1"], universe: ["s1", "s2", "s3", "s4"],
	});
	assert.deepEqual([...denied].sort(), ["s3", "s4"]);
});

test("denied：空条件时只屏蔽被禁用的技能", () => {
	const denied = workspaceDeniedSkills({
		config: EMPTY, manualSkills: [], disabledSkills: ["s2"], candidates: [], universe: ["s1", "s2"],
	});
	assert.deepEqual([...denied], ["s2"]);
});

// ── 两套口径：标签可见 vs 模型可见（2026-11-02 用户报的 64 vs 48）───────────

test("splitModelVisible：visible 全缺省时原样进 modelVisible", () => {
	const out = splitModelVisible(["a", "b"], [{ name: "a", registered: true }, { name: "b", registered: true }]);
	assert.deepEqual(out.modelVisible, ["a", "b"]);
	assert.deepEqual(out.userOnly, []);
	assert.deepEqual(out.unregistered, []);
});

test("splitModelVisible：disable-model-invocation 的技能只算「仅手动」，不进模型可见", () => {
	const out = splitModelVisible(["a", "b"], [
		{ name: "a", registered: true, invocation: { modelInvocable: true, userInvocable: true } },
		{ name: "b", registered: true, invocation: { modelInvocable: false, userInvocable: true } },
	]);
	assert.deepEqual(out.modelVisible, ["a"]);
	assert.deepEqual(out.userOnly, [{ name: "b", reason: "disable-model-invocation" }]);
});

test("splitModelVisible：宿主未注册（自扫描兜底）的技能单独归类，不算模型可见", () => {
	const out = splitModelVisible(["a", "b"], [
		{ name: "a", registered: true },
		{ name: "b", registered: false },
	]);
	assert.deepEqual(out.modelVisible, ["a"]);
	assert.deepEqual(out.unregistered, ["b"]);
	assert.deepEqual(out.userOnly, []);
});

test("splitModelVisible：catalog 里完全没有的名字按模型可见处理（不是本插件的判断范围）", () => {
	const out = splitModelVisible(["ghost"], []);
	assert.deepEqual(out.modelVisible, ["ghost"]);
});

test("splitModelVisible：宿主快照取不到时，没问到的名字进「不可判定」，绝不断言未注册", () => {
	// 2026-11-03（#1）：disabled 会话拿不到 agent scope → 宿主只给 global 层 →
	// 用户级技能根整段消失。此时 catalog 里那些名字的注册状态是**未知**，
	// 不是 false。把它们标成 unregistered 等于断言「模型侧根本不存在」——那是撒谎。
	const out = splitModelVisible(
		["scanned-only", "unknown"],
		[
			{ name: "scanned-only", registered: false },
			{ name: "unknown" },
		],
		{ registryUnavailable: true },
	);
	assert.deepEqual(out.modelVisible, [], "不可判定不能算进模型可见");
	assert.deepEqual(out.unregistered, [], "不可判定绝不能落进「宿主未注册」");
	assert.deepEqual(out.userOnly, [], "不可判定也不能被说成仅手动");
	assert.deepEqual(out.undeterminable, ["scanned-only", "unknown"]);
});

test("splitModelVisible：视角不完整时，宿主**明确返回过**的技能仍照常判定（已知事实不被未知吞掉）", () => {
	// 2026-11-03 复核：视角不全只让"没返回"变得不可信，不能让宿主已经确认的条目
	// 一起变成未知 —— 否则「模型可见 N」在历史会话里会直接掉到 0。
	const out = splitModelVisible(
		["known", "manual-only", "gone", "unknown"],
		[
			{ name: "known", registered: true },
			{ name: "manual-only", registered: true, invocation: { modelInvocable: false, userInvocable: true } },
			{ name: "gone", registered: false },
		],
		{ registryUnavailable: true },
	);
	assert.deepEqual(out.modelVisible, ["known"], "宿主确认过的照常算模型可见");
	assert.deepEqual(out.userOnly, [{ name: "manual-only", reason: "disable-model-invocation" }], "仅手动标依然成立");
	assert.deepEqual(out.unregistered, [], "视角不全时不允许断言未注册");
	assert.deepEqual(out.undeterminable, ["gone", "unknown"], "只有没问到的降级为未知");
});

test("splitModelVisible：有宿主快照时口径不变，只有 null 才进「不可判定」", () => {
	// 回归底线：真正未注册的（宿主 registry 里没有、只有自扫描看得见）仍然要
	// 单独列出来，不能被「不可判定」这个新状态吞掉。
	const out = splitModelVisible(
		["a", "b", "c"],
		[
			{ name: "a", registered: true },
			{ name: "b", registered: false },
			{ name: "c", registered: null, invocation: { modelInvocable: false, userInvocable: true } },
		],
		{ registryUnavailable: false },
	);
	assert.deepEqual(out.modelVisible, ["a"]);
	assert.deepEqual(out.unregistered, ["b"]);
	assert.deepEqual(out.undeterminable, ["c"], "未知状态优先于「仅手动」：连注册都没确认，谈不上只手动");
});

test("splitModelVisible：universe 口径不变 —— deny-shadow 仍用 visible 算，不被本函数影响", () => {
	const p = {
		config: EMPTY, manualSkills: [], disabledSkills: [],
		candidates: [], universe: ["a", "b"],
	};
	const view = workspaceSkillView(p);
	const split = splitModelVisible(view.visible, [{ name: "b", registered: true, invocation: { modelInvocable: false } }]);
	assert.deepEqual(view.visible, ["a", "b"], "标签口径仍是两条");
	assert.deepEqual(split.modelVisible, ["a"], "模型口径只有一条");
	assert.deepEqual([...workspaceDeniedSkills(p)].sort(), [], "屏蔽口径不受模型可见性影响");
});

test("normalizeWorkspacePath 统一分隔符/大小写/尾部分隔符", () => {
	assert.equal(normalizeWorkspacePath("C:\\Users\\X\\Proj\\"), "c:\\users\\x\\proj");
	assert.equal(normalizeWorkspacePath("C:/Users/X/Proj"), "c:\\users\\x\\proj");
	assert.equal(normalizeWorkspacePath(null), "");
});

// ── 服务层 ──────────────────────────────────────────────────────────────────

async function boot() {
	const repo = createMemoryRepository();
	const services = createServices(repo);
	await services.ready();
	await services.tags.create("t1", "前端");
	await services.tags.create("t2", "后端");
	await services.tags.linkSkill("alpha", ["t1"]);
	await services.tags.linkSkill("beta", ["t2"]);
	return services;
}

test("工作区条件：保存表达式后 config 同步，且表达式可回显", async () => {
	const s = await boot();
	const ws = await s.workspaces.ensure("ws-1");
	assert.equal(ws.expression, "");
	const out = await s.workspaces.setExpression("ws-1", "前端+后端");
	assert.equal(out.validation.ok, true);
	assert.equal(out.record.expression, "前端 + 后端");
	assert.deepEqual(out.record.config.orTags, ["t1", "t2"]);
	// 重新读取仍回显
	assert.equal(s.workspaces.get("ws-1").expression, "前端 + 后端");
});

test("工作区条件：空表达式是合法的「无条件」，校验不得报 EMPTY", async () => {
	// 回归（用户报告的 bug）：实时校验曾把空条件判成「表达式不能为空」，
	// 而同一套代码又认定空 = 掌握全部技能 —— 自相矛盾。
	const s = await boot();
	const v = s.templates.validate("", { allowEmpty: true });
	assert.equal(v.ok, true, "工作区方向的空表达式必须合法");
	assert.deepEqual(v.errors, []);
	assert.equal(v.normalized, "");
	assert.deepEqual(v.config, EMPTY);

	// 标签组方向仍必须报错（标签组不能没有运算）
	const tv = s.templates.validate("", {});
	assert.equal(tv.ok, false);
	assert.equal(tv.errors[0].code, "EMPTY");
	// 默认（不传 allowEmpty）也保持标签组语义
	assert.equal(s.templates.validate("").ok, false);
});

test("工作区条件：空格串同样视作无条件", async () => {
	const s = await boot();
	await s.workspaces.setExpression("ws-1", "前端");
	const out = await s.workspaces.setExpression("ws-1", "   \t  ");
	assert.equal(out.validation.ok, true);
	assert.equal(out.record.expression, "");
	assert.deepEqual(out.record.config, EMPTY);
});

test("工作区条件：保存空串 = 清空条件（回到全部技能）", async () => {
	const s = await boot();
	await s.workspaces.setExpression("ws-1", "前端");
	assert.equal(s.workspaces.get("ws-1").config.orTags.length, 1);
	await s.workspaces.setExpression("ws-1", "   ");
	assert.deepEqual(s.workspaces.get("ws-1").config, EMPTY);
	assert.equal(s.workspaces.get("ws-1").expression, "");
});

test("工作区条件：非法表达式拒绝写入，错误带 position，原值不变", async () => {
	const s = await boot();
	await s.workspaces.setExpression("ws-1", "前端");
	await assert.rejects(
		() => s.workspaces.setExpression("ws-1", "前端+"),
		(e) => {
			assert.equal(typeof e.position, "number");
			assert.ok(Array.isArray(e.issues));
			return true;
		},
	);
	assert.equal(s.workspaces.get("ws-1").expression, "前端");
});

test("工作区条件：未知标签被拒绝", async () => {
	const s = await boot();
	await assert.rejects(() => s.workspaces.setExpression("ws-1", "不存在的标签"), /不存在|UNKNOWN/);
	assert.equal(s.workspaces.get("ws-1").expression, "");
});

test("手动添加 / 禁用 / 恢复 的交互约束", async () => {
	const s = await boot();
	await s.workspaces.setExpression("ws-1", "前端");
	await s.workspaces.addManualSkill("ws-1", "gamma");
	assert.deepEqual(s.workspaces.get("ws-1").manualSkills, ["gamma"]);

	// 禁用会把手动项摘掉（互斥）
	await s.workspaces.disableSkill("ws-1", "gamma");
	assert.deepEqual(s.workspaces.get("ws-1").manualSkills, []);
	assert.deepEqual(s.workspaces.get("ws-1").disabledSkills, ["gamma"]);

	// 已禁用时不能再手动添加
	await assert.rejects(() => s.workspaces.addManualSkill("ws-1", "gamma"), /禁用/);

	await s.workspaces.enableSkill("ws-1", "gamma");
	assert.deepEqual(s.workspaces.get("ws-1").disabledSkills, []);
});

test("手动添加幂等（重复添加不产生重复项）", async () => {
	const s = await boot();
	await s.workspaces.addManualSkill("ws-1", "gamma");
	await s.workspaces.addManualSkill("ws-1", "gamma");
	assert.deepEqual(s.workspaces.get("ws-1").manualSkills, ["gamma"]);
});

test("workspaces.view / denied 走同一份领域实现", async () => {
	const s = await boot();
	await s.workspaces.setExpression("ws-1", "前端");
	await s.workspaces.addManualSkill("ws-1", "gamma");
	const ctxInfo = { universe: ["alpha", "beta", "gamma", "delta"], candidates: ["alpha"] };
	const v = s.workspaces.view("ws-1", ctxInfo);
	assert.deepEqual(v.visible, ["alpha", "gamma"]);
	assert.deepEqual([...s.workspaces.denied("ws-1", ctxInfo)].sort(), ["beta", "delta"]);
});

test("改标签名会同步改写工作区表达式（否则条件立刻失效）", async () => {
	const s = await boot();
	await s.workspaces.setExpression("ws-1", "前端+后端");
	await s.tags.rename("t1", "Frontend");
	assert.equal(s.workspaces.get("ws-1").expression, "Frontend + 后端");
});

test("全局删除标签会从工作区表达式里摘除", async () => {
	const s = await boot();
	await s.workspaces.setExpression("ws-1", "前端+后端");
	await s.tags.globalDelete("t1");
	assert.equal(s.workspaces.get("ws-1").expression, "后端");
});

test("旧工作区行（只有 config）在 ready 后被回填 expression", async () => {
	const repo = createMemoryRepository();
	const first = createServices(repo);
	await first.ready();
	await first.tags.create("t1", "前端");
	await first.tags.linkSkill("alpha", ["t1"]);
	// 模拟历史行：只有 {workspaceId, config}
	await repo.putWorkspace({ workspaceId: "legacy", config: { orTags: ["t1"], andGroups: [] } });

	const second = createServices(repo);
	await second.ready();
	const rec = second.workspaces.get("legacy");
	assert.equal(rec.expression, "前端");
	assert.deepEqual(rec.manualSkills, []);
	assert.deepEqual(rec.disabledSkills, []);
});

// ── HTTP 层 ─────────────────────────────────────────────────────────────────

test("API：右列数据 + 添加/禁用/恢复/移除 全链路", async () => {
	const s = await boot();
	const listSkills = () => [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }, { name: "delta" }];
	const handler = createApiHandler(s, null, listSkills);
	const server = (await import("node:http")).createServer((req, res) => void handler(req, res));
	await new Promise((r) => server.listen(0, r));
	const port = server.address().port;
	const call = async (path, body) => {
		const r = await fetch(`http://127.0.0.1:${port}/skill-tag/api${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		return { status: r.status, ...(await r.json()) };
	};

	try {
		// 1. 初始：无条件 → 全部技能
		let d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.equal(d.ok, true);
		assert.deepEqual(d.view.visible, ["alpha", "beta", "gamma", "delta"]);

		// 2. 设条件「前端」→ 只剩命中 alpha
		d = await call("/workspaces/expression", { workspaceId: "ws-1", expression: "前端" });
		assert.equal(d.ok, true);
		assert.equal(d.workspace.expression, "前端");
		d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.deepEqual(d.view.visible, ["alpha"]);

		// 3. 手动添加 gamma
		d = await call("/workspaces/skills/add", { workspaceId: "ws-1", skillName: "gamma" });
		assert.equal(d.ok, true);
		d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.deepEqual(d.view.visible, ["alpha", "gamma"]);

		// 4. 禁用 alpha（标签命中也要消失）
		d = await call("/workspaces/skills/disable", { workspaceId: "ws-1", skillName: "alpha" });
		assert.equal(d.ok, true);
		d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.deepEqual(d.view.visible, ["gamma"]);
		assert.deepEqual(d.disabledSkills, ["alpha"]);

		// 5. 恢复 alpha
		d = await call("/workspaces/skills/enable", { workspaceId: "ws-1", skillName: "alpha" });
		assert.equal(d.ok, true);
		d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.deepEqual(d.view.visible, ["alpha", "gamma"]);

		// 6. 移除手动添加的 gamma
		d = await call("/workspaces/skills/remove", { workspaceId: "ws-1", skillName: "gamma" });
		assert.equal(d.ok, true);
		d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.deepEqual(d.view.visible, ["alpha"]);

		// 7. 非法表达式回 400 且带 position
		const bad = await call("/workspaces/expression", { workspaceId: "ws-1", expression: "前端+" });
		assert.equal(bad.status, 400);
		assert.equal(bad.ok, false);
		assert.equal(typeof bad.position, "number");

		// 8. 回归：实时校验接口带 allowEmpty 时，空表达式合法
		let v = await call("/templates/validate", { expression: "", allowEmpty: true });
		assert.equal(v.ok, true);
		assert.equal(v.validation.ok, true, "工作区方向的空表达式必须通过校验");
		assert.deepEqual(v.validation.errors, []);
		// 不带 allowEmpty → 仍是标签组语义，空表达式非法
		v = await call("/templates/validate", { expression: "" });
		assert.equal(v.validation.ok, false);
		assert.equal(v.validation.errors[0].code, "EMPTY");

		// 9. 清空工作区条件 → 回到全部技能
		d = await call("/workspaces/expression", { workspaceId: "ws-1", expression: "" });
		assert.equal(d.ok, true);
		assert.equal(d.workspace.expression, "");
		d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.deepEqual(d.view.visible, ["alpha", "beta", "gamma", "delta"]);
	} finally {
		await new Promise((r) => server.close(r));
	}
});

// 2026-11-03（#1）：宿主视角不完整时，整列技能是「不可判定」，不是「未注册」。
// 这条覆盖的是服务层把 registryUnavailable 一路送到 view 的那根线 —— 断掉的话
// 界面就会重新开始断言「模型侧根本不存在」。
test("API：宿主视角不完整时 view 给出 undeterminable，且不把 registered:false 当结论", async () => {
	const s = await boot();
	// 发现器返回的数组带 Symbol 记号 → 模拟一版"没拿到 scope"的发现结果
	const { attachView } = await import("../src/domain/workspace.js");
	const listSkills = () => attachView([
		// 宿主这趟**确实返回过**的名字：已知事实，不被"视角不全"抹掉（2026-11-03 复核）
		{ name: "alpha", path: "/a/SKILL.md", source: "bundled", registered: true, invocation: { modelInvocable: true, userInvocable: true } },
		// 没问到的：只有"未知"这一种结论
		{ name: "gamma", path: "/g/SKILL.md", source: "C:\\home\\.dsh\\skills", registered: null, invocation: { modelInvocable: true, userInvocable: true } },
	], false);
	const handler = createApiHandler(s, null, listSkills);
	const server = (await import("node:http")).createServer((req, res) => void handler(req, res));
	await new Promise((r) => server.listen(0, r));
	const port = server.address().port;
	const call = async (path, body) => {
		const r = await fetch(`http://127.0.0.1:${port}/skill-tag/api${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		return { status: r.status, ...(await r.json()) };
	};
	try {
		const d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.equal(d.ok, true);
		assert.deepEqual(d.view.undeterminable, ["gamma"], "只把没问到的那条算作不可判定");
		assert.deepEqual(d.view.unregistered, [], "不许借此断言任何一个未注册");
		assert.deepEqual(d.view.modelVisible, ["alpha"], "宿主确认过的仍算模型可见，不能被未知吞掉");
		assert.equal(d.catalog.find((x) => x.name === "gamma").registered, null, "null 必须原样透传");
	} finally {
		await new Promise((r) => server.close(r));
	}
});

// 2026-11-02（缺陷 1+2）：/workspaces/skills 必须把 invocation / registered 透传，
// 并给出 view.modelVisible / userOnly / unregistered —— 这正是用户问的
// "插件说 N 条、模型实际 M 条" 的那个差额的直接来源。
test("API：右列同时给出「标签可见」与「模型可见」两套口径", async () => {
	const s = await boot();
	const listSkills = () => [
		{ name: "alpha", path: "/a/SKILL.md", source: "bundled", registered: true, invocation: { modelInvocable: true, userInvocable: true } },
		{ name: "beta", path: "/b/SKILL.md", source: "bundled", registered: true, invocation: { modelInvocable: false, userInvocable: true } },
		{ name: "gamma", path: "/g/SKILL.md", source: "C:\\home\\.dsh\\skills", registered: false, invocation: { modelInvocable: true, userInvocable: true } },
		{ name: "delta", path: "/d/SKILL.md", source: "bundled", registered: true, invocation: { modelInvocable: true, userInvocable: true } },
	];
	const handler = createApiHandler(s, null, listSkills);
	const server = (await import("node:http")).createServer((req, res) => void handler(req, res));
	await new Promise((r) => server.listen(0, r));
	const port = server.address().port;
	const call = async (path, body) => {
		const r = await fetch(`http://127.0.0.1:${port}/skill-tag/api${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		return { status: r.status, ...(await r.json()) };
	};
	try {
		const d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.equal(d.ok, true);
		assert.deepEqual(d.view.visible, ["alpha", "beta", "gamma", "delta"], "标签口径仍是四条");
		assert.deepEqual(d.view.modelVisible, ["alpha", "delta"], "模型口径只有两条（beta 仅手动、gamma 未注册）");
		assert.deepEqual(d.view.userOnly.map((r) => r.name), ["beta"]);
		assert.deepEqual(d.view.userOnly[0].reason, "disable-model-invocation");
		assert.deepEqual(d.view.unregistered, ["gamma"]);
		// catalog 本身也要带上元数据，前端 📁/解释文案都靠它
		const beta = d.catalog.find((x) => x.name === "beta");
		assert.equal(beta.invocation.modelInvocable, false);
		assert.equal(beta.registered, true);
		const gamma = d.catalog.find((x) => x.name === "gamma");
		assert.equal(gamma.registered, false);
	} finally {
		await new Promise((r) => server.close(r));
	}
});
