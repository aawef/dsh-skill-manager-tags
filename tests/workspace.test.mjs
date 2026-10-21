// 「管理标签」双列界面 — 工作区技能视图的领域语义 + 服务层 + HTTP 层
//
// 覆盖用户确认的三条语义：
//   空条件 + 无手动添加 → 全部技能；有条件 → 严格子集；禁用永远排除且真的屏蔽。

import test from "node:test";
import assert from "node:assert/strict";

import {
	normalizeSkillIds, hasFilter, activeTagsOf, workspaceSkillView,
	workspaceDeniedSkills, normalizeWorkspacePath,
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
