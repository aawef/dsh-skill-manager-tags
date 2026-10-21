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

test("不绑定工作区的新建对话 = 空快照（无条件）", async () => {
	const { services: s } = await boot();
	const conv = await s.conversations.create("conv-2", null);
	assert.equal(conv.own.expression, "");
	assert.deepEqual(conv.own.config, EMPTY);
	assert.deepEqual(conv.own.manualSkills, []);
	assert.equal(conv.own.sourceWorkspaceId, null);
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

test("会话历史行（无 own）在 ensureOwn 时补空快照", async () => {
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

	// 直接打开（不带播种）→ 空快照，不自动吃工作区
	await s2.conversations.ensureOwn("legacy-conv");
	assert.deepEqual(s2.conversations.get("legacy-conv").own, emptyOwnConfig());

	// 带播种工作区打开 → 只播种一次（这是「默认继承」的落点）
	await repo.putConversation({
		conversationId: "legacy-conv2",
		tags: {},
		config: EMPTY,
		inherited: { workspaceId: "ws-1", groups: [], blockedGroups: [] },
	});
	const s3 = createServices(repo);
	await s3.ready();
	await s3.conversations.ensureOwn("legacy-conv2", "ws-1");
	const seeded = s3.conversations.own("legacy-conv2");
	assert.equal(seeded.expression, "前端");
	assert.equal(seeded.sourceWorkspaceId, "ws-1");
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
		// 1. 首次打开历史对话：用宿主解析到的工作区播种快照（默认继承一次）
		let d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.equal(d.ok, true);
		assert.equal(d.workspaceId, "ws-1", "会话应解析到所属工作区");
		assert.equal(d.expression, "前端", "默认继承工作区条件");
		assert.deepEqual(d.manualSkills, ["gamma"]);
		assert.deepEqual(d.disabledSkills, ["beta"]);
		// 右列 = 命中 alpha ∪ 手动 gamma − 禁用（beta 不在命中集里）
		assert.deepEqual(d.view.visible, ["alpha", "gamma"]);
		assert.deepEqual(d.universe, UNIVERSE);

		// 2. 工作区之后改动，不会自动流入这个对话
		await s.workspaces.setExpression("ws-1", "后端");
		d = await call("/conversations/config", { conversationId: "sess-1" });
		assert.equal(d.expression, "前端", "已存在的对话不自动跟随工作区");

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
