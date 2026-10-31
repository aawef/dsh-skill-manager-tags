// 「对话 → 管理标签」双列界面 — 服务层 + HTTP 层
//
// 用户口径（m01534 + 三点澄清）：
//   1. 复刻完整两列（左列标签条件 + 继承按钮；右列技能列表）。
//   2. 对话页的「禁用 / 手动添加」存在**对话自己身上**，不影响工作区与其他对话。
//   3. 「继承工作区配置」= 标签条件 + 手动添加 + 禁用，全部覆盖。
//   4. 除非点击继承按钮，或者新创建对话，否则工作区的配置不自动继承到对话。

import test from "node:test";
import assert from "node:assert/strict";

import { createServices } from "../src/service.js";
import { createMemoryRepository } from "../src/storage/repository.js";
import { createApiHandler } from "../src/api.js";
import { emptyOwnConfig, ownConfigFromWorkspace } from "../src/domain/conv.js";

const EMPTY = { orTags: [], andGroups: [] };
const UNIVERSE = ["alpha", "beta", "gamma", "delta"];

async function boot() {
	const repo = createMemoryRepository();
	const services = createServices(repo);
	await services.ready();
	await services.tags.create("t1", "前端");
	await services.tags.create("t2", "后端");
	await services.tags.linkSkill("alpha", ["t1"]);
	await services.tags.linkSkill("beta", ["t2"]);
	return { services, repo };
}

/** 给工作区布置一套「有条件 + 手动 + 禁用」的完整配置。 */
async function seedWorkspace(s, wid = "ws-1") {
	await s.workspaces.setExpression(wid, "前端");
	await s.workspaces.addManualSkill(wid, "gamma");
	await s.workspaces.disableSkill(wid, "beta");
	return s.workspaces.get(wid);
}

// ── 领域：快照形态 ─────────────────────────────────────────────────────────

test("emptyOwnConfig：无条件、无手动、无禁用、无继承来源", () => {
	const o = emptyOwnConfig();
	assert.equal(o.expression, "");
	assert.deepEqual(o.config, EMPTY);
	assert.deepEqual(o.manualSkills, []);
	assert.deepEqual(o.disabledSkills, []);
	assert.equal(o.inheritedAt, null);
	assert.equal(o.sourceWorkspaceId, null);
});

test("ownConfigFromWorkspace：深拷贝三件套并记录来源", () => {
	const ws = {
		workspaceId: "ws-1",
		expression: "前端 + 后端",
		config: { orTags: ["t1"], andGroups: [{ groupId: "g1", tagIds: ["t2"] }] },
		manualSkills: ["gamma"],
		disabledSkills: ["delta"],
	};
	const o = ownConfigFromWorkspace(ws, "2026-01-01T00:00:00.000Z");
	assert.equal(o.expression, "前端 + 后端");
	assert.deepEqual(o.config.orTags, ["t1"]);
	assert.deepEqual(o.manualSkills, ["gamma"]);
	assert.deepEqual(o.disabledSkills, ["delta"]);
	assert.equal(o.sourceWorkspaceId, "ws-1");
	assert.equal(o.inheritedAt, "2026-01-01T00:00:00.000Z");

	// 深拷贝：改对话快照不能反向污染工作区
	o.config.orTags.push("t2");
	o.manualSkills.push("alpha");
	assert.deepEqual(ws.config.orTags, ["t1"]);
	assert.deepEqual(ws.manualSkills, ["gamma"]);
});

// ── 服务层：继承语义 ───────────────────────────────────────────────────────

test("新建对话 = 自动继承一次工作区配置", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);

	const conv = await s.conversations.create("conv-1", "ws-1");
	assert.equal(conv.own.expression, "前端");
	assert.deepEqual(conv.own.manualSkills, ["gamma"]);
	assert.deepEqual(conv.own.disabledSkills, ["beta"]);
	assert.equal(conv.own.sourceWorkspaceId, "ws-1");
	assert.equal(typeof conv.own.inheritedAt, "string");
});

test("工作区后续改动不会自动流入已存在的对话", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);
	await s.conversations.create("conv-1", "ws-1");
	const before = s.conversations.own("conv-1");

	// 工作区改成另一套配置
	await s.workspaces.setExpression("ws-1", "后端");
	await s.workspaces.addManualSkill("ws-1", "delta");

	const after = s.conversations.own("conv-1");
	assert.equal(after.expression, before.expression, "对话条件不该被工作区改动带跑");
	assert.deepEqual(after.manualSkills, before.manualSkills);
});

test("不绑定工作区的新建对话 = 未配置（own 保持 null，语义即无条件）", async () => {
	const { services: s } = await boot();
	const conv = await s.conversations.create("conv-2", null);
	// 2026-10-31：own 只在"能继承到工作区"时写入。绑不到工作区就不写，
	// 让 own 保持 null —— 运行时语义同样是"空条件 = 掌握全部技能"，
	// 但不会把一条对话钉死成"已配置"。
	assert.equal(conv.own, null);
	assert.equal(s.conversations.isConfigured("conv-2"), false);
	assert.deepEqual(s.conversations.own("conv-2").config, EMPTY);
	assert.deepEqual(s.conversations.own("conv-2").manualSkills, []);
	assert.equal(s.conversations.own("conv-2").sourceWorkspaceId, null);
});

test("继承按钮：覆盖标签条件 + 手动添加 + 禁用（整体替换）", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);
	await s.conversations.create("conv-1", null);

	// 对话先有自己的一套（与工作区完全不同）
	await s.conversations.setOwnExpression("conv-1", "后端");
	await s.conversations.addOwnManualSkill("conv-1", "delta");
	assert.deepEqual(s.conversations.own("conv-1").manualSkills, ["delta"]);

	// 点「继承工作区配置」
	await s.conversations.inheritFromWorkspace("conv-1", "ws-1");
	const o = s.conversations.own("conv-1");
	assert.equal(o.expression, "前端");
	assert.deepEqual(o.manualSkills, ["gamma"], "手动添加被整体替换，不是并集");
	assert.deepEqual(o.disabledSkills, ["beta"], "禁用也被继承");
	assert.equal(o.sourceWorkspaceId, "ws-1");
});

test("再次继承 = 重新同步（工作区改过也能拉最新）", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);
	await s.conversations.inheritFromWorkspace("conv-1", "ws-1");
	assert.equal(s.conversations.own("conv-1").expression, "前端");

	await s.workspaces.setExpression("ws-1", "前端 + 后端");
	await s.workspaces.enableSkill("ws-1", "beta");
	await s.conversations.inheritFromWorkspace("conv-1", "ws-1");

	const o = s.conversations.own("conv-1");
	assert.equal(o.expression, "前端 + 后端");
	assert.deepEqual(o.disabledSkills, []);
});

test("继承不会回写工作区（对话改动是单向的）", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);
	await s.conversations.inheritFromWorkspace("conv-1", "ws-1");
	await s.conversations.setOwnExpression("conv-1", "后端");
	await s.conversations.disableOwnSkill("conv-1", "gamma");

	const ws = s.workspaces.get("ws-1");
	assert.equal(ws.expression, "前端", "工作区表达式不受对话影响");
	assert.deepEqual(ws.manualSkills, ["gamma"], "工作区手动列表不受对话影响");
	assert.deepEqual(ws.disabledSkills, ["beta"]);
});

// ── 服务层：对话自己的配置 ─────────────────────────────────────────────────

test("对话条件：保存表达式后 config 同步，且可回显", async () => {
	const { services: s } = await boot();
	await s.conversations.ensureOwn("conv-1");
	const out = await s.conversations.setOwnExpression("conv-1", "前端+后端");
	assert.equal(out.validation.ok, true);
	assert.equal(out.record.own.expression, "前端 + 后端");
	assert.deepEqual(out.record.own.config.orTags, ["t1", "t2"]);
	assert.equal(s.conversations.own("conv-1").expression, "前端 + 后端");
});

test("对话条件：空表达式合法（= 无条件 = 掌握全部技能）", async () => {
	const { services: s } = await boot();
	await s.conversations.ensureOwn("conv-1");
	await s.conversations.setOwnExpression("conv-1", "前端");
	const out = await s.conversations.setOwnExpression("conv-1", "   ");
	assert.equal(out.validation.ok, true);
	assert.equal(s.conversations.own("conv-1").expression, "");
	assert.deepEqual(s.conversations.own("conv-1").config, EMPTY);
});

test("对话条件：非法表达式拒绝写入，错误带 position，原值不变", async () => {
	const { services: s } = await boot();
	await s.conversations.ensureOwn("conv-1");
	await s.conversations.setOwnExpression("conv-1", "前端");
	await assert.rejects(
		() => s.conversations.setOwnExpression("conv-1", "前端+"),
		(e) => {
			assert.equal(typeof e.position, "number");
			assert.ok(Array.isArray(e.issues));
			return true;
		},
	);
	assert.equal(s.conversations.own("conv-1").expression, "前端");
});

test("对话条件：未知标签被拒绝", async () => {
	const { services: s } = await boot();
	await s.conversations.ensureOwn("conv-1");
	await assert.rejects(() => s.conversations.setOwnExpression("conv-1", "查无此标签"), /不存在|UNKNOWN/);
	assert.equal(s.conversations.own("conv-1").expression, "");
});

test("对话手动添加 / 禁用 / 恢复 的交互约束", async () => {
	const { services: s } = await boot();
	await s.conversations.ensureOwn("conv-1");
	await s.conversations.addOwnManualSkill("conv-1", "gamma");
	assert.deepEqual(s.conversations.own("conv-1").manualSkills, ["gamma"]);

	// 禁用会把手动项摘掉（互斥）
	await s.conversations.disableOwnSkill("conv-1", "gamma");
	assert.deepEqual(s.conversations.own("conv-1").manualSkills, []);
	assert.deepEqual(s.conversations.own("conv-1").disabledSkills, ["gamma"]);

	// 已禁用时不能再手动添加
	await assert.rejects(() => s.conversations.addOwnManualSkill("conv-1", "gamma"), /禁用/);

	await s.conversations.enableOwnSkill("conv-1", "gamma");
	assert.deepEqual(s.conversations.own("conv-1").disabledSkills, []);
});

test("两个对话互不干扰（配置隔离）", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);
	await s.conversations.create("conv-a", "ws-1");
	await s.conversations.create("conv-b", "ws-1");

	await s.conversations.setOwnExpression("conv-a", "后端");
	await s.conversations.disableOwnSkill("conv-a", "alpha");

	assert.equal(s.conversations.own("conv-a").expression, "后端");
	assert.equal(s.conversations.own("conv-b").expression, "前端", "另一个对话保持原样");
	assert.deepEqual(s.conversations.own("conv-b").disabledSkills, ["beta"]);
});

test("会话历史行（无 own）打开管理标签后 own 仍为 null（不播种）", async () => {
	const { services: s, repo } = await boot();
	await seedWorkspace(s);
	// 模拟历史对话行：只有 inherited，没有 own
	await repo.putConversation({
		conversationId: "legacy-conv",
		tags: {},
		config: EMPTY,
		inherited: { workspaceId: "ws-1", groups: [], blockedGroups: [] },
	});
	const s2 = createServices(repo);
	await s2.ready();
	assert.equal(s2.conversations.get("legacy-conv").own, null);

	// 2026-10-31：打开「管理标签（对话）」是纯读，**不播种**。
	// 旧实现会在打开瞬间用当前工作区播种（"看一眼就被冻结"），已废弃。
	await s2.conversations.ensureOwn("legacy-conv");
	assert.equal(s2.conversations.get("legacy-conv").own, null, "打开不等于配置");
	assert.equal(s2.conversations.isConfigured("legacy-conv"), false);

	// 只有用户显式点「继承工作区配置」才会写入 own
	await s2.conversations.inheritFromWorkspace("legacy-conv", "ws-1");
	const seeded = s2.conversations.own("legacy-conv");
	assert.equal(seeded.expression, "前端");
	assert.equal(seeded.sourceWorkspaceId, "ws-1");
});

test("出生播种 seedOwnOnBirth：只在 own 为空时继承一次，绝不覆盖已有配置", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);

	// 新出生且未配置 → 播种
	assert.equal(await s.conversations.seedOwnOnBirth("newborn", "ws-1"), true);
	assert.equal(s.conversations.own("newborn").expression, "前端");

	// 工作区改了，再播一次不会覆盖（幂等）
	await s.workspaces.setExpression("ws-1", "后端");
	assert.equal(await s.conversations.seedOwnOnBirth("newborn", "ws-1"), false);
	assert.equal(s.conversations.own("newborn").expression, "前端", "已有配置绝不被覆盖");

	// 工作区不存在 → 不写（留 null = 全部技能，不会把对话钉死）
	assert.equal(await s.conversations.seedOwnOnBirth("no-ws", "ws-missing"), false);
	assert.equal(s.conversations.get("no-ws")?.own ?? null, null);
});

test("own 快照落盘并跨实例恢复", async () => {
	const { services: s, repo } = await boot();
	await s.conversations.create("conv-1", null);
	await s.conversations.setOwnExpression("conv-1", "前端");
	await s.conversations.addOwnManualSkill("conv-1", "gamma");
	await s.conversations.disableOwnSkill("conv-1", "beta");

	const s2 = createServices(repo);
	await s2.ready();
	const o = s2.conversations.own("conv-1");
	assert.equal(o.expression, "前端");
	assert.deepEqual(o.manualSkills, ["gamma"]);
	assert.deepEqual(o.disabledSkills, ["beta"]);
});

// ── 服务层：视图 / deny 口径 ───────────────────────────────────────────────

test("ownView：空条件 → 全部技能；有条件 → 严格子集", async () => {
	const { services: s } = await boot();
	await s.conversations.ensureOwn("conv-1");
	const ctx = { universe: UNIVERSE, candidates: ["alpha"] };

	assert.deepEqual(s.conversations.ownView("conv-1", ctx).visible, UNIVERSE);

	await s.conversations.setOwnExpression("conv-1", "前端");
	assert.deepEqual(s.conversations.ownView("conv-1", ctx).visible, ["alpha"]);
});

test("ownView / ownDenied 走同一份领域实现（互补）", async () => {
	const { services: s } = await boot();
	await s.conversations.ensureOwn("conv-1");
	await s.conversations.setOwnExpression("conv-1", "前端");
	await s.conversations.addOwnManualSkill("conv-1", "gamma");
	const ctx = { universe: UNIVERSE, candidates: ["alpha"] };

	const v = s.conversations.ownView("conv-1", ctx);
	assert.deepEqual(v.visible, ["alpha", "gamma"]);
	assert.deepEqual([...s.conversations.ownDenied("conv-1", ctx)].sort(), ["beta", "delta"]);
});

test("ownDenied：禁用技能一定进拒绝集", async () => {
	const { services: s } = await boot();
	await s.conversations.ensureOwn("conv-1");
	await s.conversations.disableOwnSkill("conv-1", "alpha");
	const ctx = { universe: UNIVERSE, candidates: UNIVERSE };
	assert.ok(s.conversations.ownDenied("conv-1", ctx).has("alpha"));
});

// ── HTTP 层 ─────────────────────────────────────────────────────────────────

test("API：对话版双列界面全链路（继承 → 改条件 → 手动 → 禁用 → 恢复）", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);

	const listSkills = () => UNIVERSE.map((name) => ({ name }));
	// 会话 → 工作区：模拟宿主 workspaceRegistry 的解析结果
	const resolveWorkspaceId = (sessionId) => (sessionId.startsWith("sess-") ? "ws-1" : null);
	const handler = createApiHandler(s, null, listSkills, resolveWorkspaceId);
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
		// 1. 首次打开历史对话：**纯读，不播种**（2026-10-31 起）
		//    未配置过 → configured=false → 空条件 → 掌握全部技能
		let d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.equal(d.ok, true);
		assert.equal(d.workspaceId, "ws-1", "会话仍解析到所属工作区（供继承按钮用）");
		assert.equal(d.configured, false, "打开不等于配置");
		assert.equal(d.expression, "", "不自动继承工作区条件");
		assert.deepEqual(d.manualSkills, []);
		assert.deepEqual(d.disabledSkills, []);
		// 空条件 → 全部技能（不筛）
		assert.deepEqual(d.view.visible, UNIVERSE);
		assert.deepEqual(d.universe, UNIVERSE);

		// 2. 工作区改动，也不会流入这个未配置的对话
		await s.workspaces.setExpression("ws-1", "后端");
		d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.equal(d.expression, "", "未配置过的对话不跟随工作区");

		// 3. 点「继承工作区配置」→ 拉最新并整体覆盖
		d = await call("/conversations/inherit", { conversationId: "sess-1" });
		assert.equal(d.ok, true);
		assert.equal(d.expression, "后端");
		assert.deepEqual(d.manualSkills, ["gamma"], "手动列表被整体替换");
		assert.deepEqual(d.disabledSkills, ["beta"]);

		// 4. 在继承结果上继续编辑
		d = await call("/conversations/expression", { conversationId: "sess-1", expression: "前端+后端" });
		assert.equal(d.ok, true);
		assert.equal(d.conversation.expression, "前端 + 后端");
		d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.deepEqual(d.view.visible, ["alpha", "gamma"], "beta 被禁用；gamma 是继承来的手动添加");

		// 5. 手动添加 delta
		d = await call("/conversations/skills/add", { conversationId: "sess-1", skillName: "delta" });
		assert.equal(d.ok, true);
		d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.deepEqual(d.view.visible, ["alpha", "gamma", "delta"]);

		// 6. 禁用 alpha
		d = await call("/conversations/skills/disable", { conversationId: "sess-1", skillName: "alpha" });
		assert.equal(d.ok, true);
		d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.deepEqual(d.view.visible, ["gamma", "delta"]);
		assert.deepEqual(d.disabledSkills, ["beta", "alpha"]);

		// 7. 恢复 alpha 与 beta
		await call("/conversations/skills/enable", { conversationId: "sess-1", skillName: "alpha" });
		await call("/conversations/skills/enable", { conversationId: "sess-1", skillName: "beta" });
		d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.deepEqual(d.view.visible, ["alpha", "beta", "gamma", "delta"], "beta 恢复后重新被「后端」命中");

		// 8. 移除手动添加的 delta
		d = await call("/conversations/skills/remove", { conversationId: "sess-1", skillName: "delta" });
		assert.equal(d.ok, true);
		d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.deepEqual(d.view.visible, ["alpha", "beta", "gamma"]);

		// 9. 清空条件 → 回到全部技能
		d = await call("/conversations/expression", { conversationId: "sess-1", expression: "" });
		assert.equal(d.ok, true);
		d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.deepEqual(d.view.visible, UNIVERSE);

		// 10. 非法表达式回 400 且带 position
		const bad = await call("/conversations/expression", { conversationId: "sess-1", expression: "前端+" });
		assert.equal(bad.status, 400);
		assert.equal(bad.ok, false);
		assert.equal(typeof bad.position, "number");

		// 11. 对话改动没有污染工作区
		d = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.equal(d.expression, "后端", "工作区表达式保持自己那份");
		assert.deepEqual(d.manualSkills, ["gamma"]);
	} finally {
		await new Promise((r) => server.close(r));
	}
});

test("API：没有可继承的工作区时明确报错", async () => {
	const { services: s } = await boot();
	const handler = createApiHandler(s, null, () => [], () => null);
	const server = (await import("node:http")).createServer((req, res) => void handler(req, res));
	await new Promise((r) => server.listen(0, r));
	const port = server.address().port;
	try {
		const r = await fetch(`http://127.0.0.1:${port}/skill-tag/api/conversations/inherit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ conversationId: "sess-orphan" }),
		});
		assert.equal(r.status, 400);
		const d = await r.json();
		assert.equal(d.ok, false);
		assert.match(d.error, /工作区/);
	} finally {
		await new Promise((r) => server.close(r));
	}
});
// ── /skills 的 stale 报告 与 /skills/purge-stale（2026-10-31） ──────────
//
// 语义：stale 只**报告**不删除；purge 必须显式调用，且发现结果为 0 时拒绝
// （避免宿主未就绪时把全部关联当成失效删掉）。

/** 起一个临时 HTTP 服务跑 handler，返回 call/close 两个小工具。 */
async function withServer(handler, fn) {
	const server = (await import("node:http")).createServer((req, res) => void handler(req, res));
	await new Promise((r) => server.listen(0, r));
	const port = server.address().port;
	const call = async (path, body) => {
		const r = await fetch(`http://127.0.0.1:${port}/skill-tag/api${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		return await r.json();
	};
	try { return await fn(call); } finally { await new Promise((r) => server.close(r)); }
}

test("API：/skills 报告 stale（有标签关联但当前发现不到），只报不删", async () => {
	const { services: s } = await boot();
	// alpha 存活；gone 的贡献插件已关闭 → 只剩标签关联
	const handler = createApiHandler(s, null, () => [{ name: "alpha", path: null }], () => null);
	await withServer(handler, async (call) => {
		const d = await call("/skills", { cwd: null });
		assert.equal(d.ok, true);
		assert.deepEqual(d.skills.map((x) => x.name), ["alpha"]);
		const staleIds = d.stale.map((x) => x.skillId).sort();
		// boot() 里建了两条关联：alpha→t1、beta→t2；beta 当前发现不到
		assert.deepEqual(staleIds, ["beta"]);
		assert.deepEqual(d.stale[0].tagIds, ["t2"], "stale 要带上保留的标签，便于用户判断");
		// GET 绝不删数据
		assert.deepEqual(s.tags.tagsForSkill("beta"), ["t2"]);
	});
});

test("API：/skills/purge-stale 只删失效记录，保留存活技能的关联", async () => {
	const { services: s } = await boot();
	const handler = createApiHandler(s, null, () => [{ name: "alpha" }], () => null);
	await withServer(handler, async (call) => {
		const d = await call("/skills/purge-stale", {});
		assert.equal(d.ok, true);
		assert.deepEqual(d.removed, ["beta"]);
		assert.equal(d.count, 1);
		assert.deepEqual(s.tags.tagsForSkill("beta"), [], "失效关联已删除");
		assert.deepEqual(s.tags.tagsForSkill("alpha"), ["t1"], "存活技能的关联不受影响");
	});
});

test("API：发现结果为 0 时 purge-stale 拒绝执行（宿主未就绪保护）", async () => {
	const { services: s } = await boot();
	const handler = createApiHandler(s, null, () => [], () => null);
	await withServer(handler, async (call) => {
		const d = await call("/skills/purge-stale", {});
		assert.equal(d.ok, false);
		assert.equal(d.code, "NO_SKILLS");
		assert.deepEqual(s.tags.tagsForSkill("alpha"), ["t1"], "拒绝执行时绝不动数据");
		assert.deepEqual(s.tags.tagsForSkill("beta"), ["t2"]);
	});
});

test("API：purge-stale 带 skillIds 时只删用户勾选的那些", async () => {
	const { services: s } = await boot();
	await s.tags.linkSkill("gone2", ["t1"]);
	const handler = createApiHandler(s, null, () => [{ name: "alpha" }], () => null);
	await withServer(handler, async (call) => {
		// 失效的有 beta 与 gone2，只勾 beta
		const d = await call("/skills/purge-stale", { skillIds: ["beta"] });
		assert.deepEqual(d.removed, ["beta"]);
		assert.deepEqual(s.tags.tagsForSkill("gone2"), ["t1"], "没勾选的失效关联必须保留");
	});
});
// ── 标签实体的变更必须同步写回对话快照（2026-10-31 补） ─────────────────
//
// own 是「冻结的配置」，但标签的名称/存废是**全局**的。若不写回，冻结住的表达式
// 会指向不存在的标签名，用户下次打开「tag 设置」就看到「标签不存在」且保存被拒。

test("改标签名：所有对话快照里的表达式同步改写", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);
	await s.conversations.create("conv-1", "ws-1"); // own.expression = "前端"
	await s.conversations.inheritFromWorkspace("conv-2", "ws-1");

	await s.tags.rename("t1", "前端改");

	assert.equal(s.conversations.own("conv-1").expression, "前端改");
	assert.equal(s.conversations.own("conv-2").expression, "前端改");
	assert.equal(s.workspaces.get("ws-1").expression, "前端改");
	// 改写后的表达式仍然合法（不再「标签不存在」）
	const v = s.templates.validate(s.conversations.own("conv-1").expression, { allowEmpty: true });
	assert.equal(v.ok, true);
});

test("全局删标签：对话快照里的 config 与表达式一并摘除该标签", async () => {
	const { services: s } = await boot();
	await seedWorkspace(s);
	await s.conversations.create("conv-1", "ws-1");
	assert.deepEqual(s.conversations.own("conv-1").config.orTags, ["t1"]);

	await s.tags.globalDelete("t1");

	const o = s.conversations.own("conv-1");
	assert.deepEqual(o.config.orTags, [], "不留悬空 tagId（否则会屏蔽全部技能）");
	assert.equal(o.expression, "");
});

test("installed_at：首次写入后永不覆盖（三种对话判定的基准）", async () => {
	const { services: s, repo } = await boot();
	assert.equal(s.meta.installedAt(), null);
	const t1 = "2026-01-01T00:00:00.000Z";
	await s.meta.ensureInstalledAt(t1);
	assert.equal(s.meta.installedAt(), t1);

	// 再次 ensure（模拟重启/升级）不得改写
	await s.meta.ensureInstalledAt("2027-01-01T00:00:00.000Z");
	assert.equal(s.meta.installedAt(), t1);

	// 跨实例恢复
	const s2 = createServices(repo);
	await s2.ready();
	assert.equal(s2.meta.installedAt(), t1);
});
