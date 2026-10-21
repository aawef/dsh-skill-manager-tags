import { test } from "node:test";
import assert from "node:assert/strict";

import { createServices } from "../src/service.js";
import { createMemoryRepository } from "../src/storage/repository.js";

/** 建一套服务 + 三个标签 A/B/C */
async function setup() {
	const repo = createMemoryRepository();
	const services = createServices(repo);
	await services.ready();
	await services.tags.create("t-a", "A");
	await services.tags.create("t-b", "B");
	await services.tags.create("t-c", "C");
	return { repo, services };
}

test("标签组 CRUD：新建保存表达式，再次读取回显同一表达式", async () => {
	const { services } = await setup();
	const rec = await services.templates.create("tpl-1", "前端组", { expression: "A+B*C" });
	assert.equal(rec.expression, "A+B*C");
	assert.deepEqual(rec.config.orTags, ["t-a"]);
	assert.deepEqual(rec.config.andGroups, [{ groupId: "t-b|t-c", tagIds: ["t-b", "t-c"] }]);
	assert.ok(rec.createdAt && rec.updatedAt);

	// "再次打开编辑" = 从 list/get 读回
	const again = services.templates.get("tpl-1");
	assert.equal(again.expression, "A+B*C");
	assert.equal(services.templates.list()[0].expression, "A+B*C");
});

test("更新表达式后 config 同步刷新；只改名称不动表达式", async () => {
	const { services } = await setup();
	await services.templates.create("tpl-1", "g", { expression: "A+B" });
	await services.templates.update("tpl-1", { expression: "(A+B)*C" });
	const rec = services.templates.get("tpl-1");
	assert.equal(rec.expression, "(A+B)*C");
	assert.equal(rec.config.andGroups.length, 2);

	await services.templates.update("tpl-1", { name: "改名后" });
	assert.equal(services.templates.get("tpl-1").name, "改名后");
	assert.equal(services.templates.get("tpl-1").expression, "(A+B)*C");
});

test("非法表达式拒绝写入，错误带 code/position", async () => {
	const { services } = await setup();
	await assert.rejects(
		() => services.templates.create("tpl-bad", "bad", { expression: "(A+B" }),
		(e) => e.code === "UNBALANCED_PAREN" && typeof e.position === "number",
	);
	assert.equal(services.templates.get("tpl-bad"), null);

	await assert.rejects(
		() => services.templates.create("tpl-empty", "empty", { expression: "" }),
		/不能为空|表达式/,
	);
	await assert.rejects(
		() => services.templates.create("tpl-unknown", "u", { expression: "A+ZZZ" }),
		(e) => e.code === "UNKNOWN_TAG",
	);
});

test("名称唯一性：重名拒绝，改名冲突拒绝", async () => {
	const { services } = await setup();
	await services.templates.create("tpl-1", "同名", { expression: "A" });
	await assert.rejects(() => services.templates.create("tpl-2", "同名", { expression: "B" }), /already exists/);
	await services.templates.create("tpl-3", "另一个", { expression: "B" });
	await assert.rejects(() => services.templates.update("tpl-3", { name: "同名" }), /already exists/);
});

test("删除标签组后不再出现在列表", async () => {
	const { services } = await setup();
	await services.templates.create("tpl-1", "g", { expression: "A" });
	await services.templates.remove("tpl-1");
	assert.equal(services.templates.get("tpl-1"), null);
	assert.deepEqual(services.templates.list(), []);
	await assert.rejects(() => services.templates.remove("tpl-1"), /not found/);
});

test("evaluate：判断给定标签集合是否满足标签组布尔条件", async () => {
	const { services } = await setup();
	await services.templates.create("tpl-1", "g", { expression: "A+B*C" });
	assert.equal(services.templates.evaluate("tpl-1", ["t-a"]).matched, true);
	assert.equal(services.templates.evaluate("tpl-1", ["t-b", "t-c"]).matched, true);
	assert.equal(services.templates.evaluate("tpl-1", ["t-b"]).matched, false);
	assert.equal(services.templates.evaluate("tpl-1", new Set()).matched, false);
});

test("改标签名会同步改写引用它的表达式（否则标签组立刻失效）", async () => {
	const { services } = await setup();
	await services.templates.create("tpl-1", "g", { expression: "A+B*C" });
	await services.tags.rename("t-b", "Beta");
	assert.equal(services.templates.get("tpl-1").expression, "A+Beta*C");
	const r = services.templates.validate(services.templates.get("tpl-1").expression);
	assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("全局删除标签会从表达式里摘除该标签且保持语义", async () => {
	const { services } = await setup();
	await services.templates.create("tpl-1", "g", { expression: "A+B*C" });
	await services.tags.globalDelete("t-a");
	const rec = services.templates.get("tpl-1");
	assert.equal(rec.expression, "B * C");
	assert.equal(services.templates.validate(rec.expression).ok, true);

	await services.tags.globalDelete("t-b");
	assert.equal(services.templates.get("tpl-1").expression, "C");
});

test("旧数据迁移：只有 config 的历史行会被反推成表达式", async () => {
	const repo = createMemoryRepository();
	await repo.putTag({ tagId: "t-a", name: "A", createdAt: new Date().toISOString() });
	await repo.putTag({ tagId: "t-b", name: "B", createdAt: new Date().toISOString() });
	// 历史行：无 expression、无时间戳
	await repo.putTemplate({
		templateId: "legacy",
		name: "旧组",
		config: { orTags: ["t-a"], andGroups: [{ groupId: "t-a|t-b", tagIds: ["t-a", "t-b"] }] },
	});

	const services = createServices(repo);
	await services.ready();
	const rec = services.templates.get("legacy");
	assert.equal(rec.expression, "A + (A * B)");
	assert.ok(rec.createdAt);
	// 迁移已回写磁盘
	const stored = (await repo.listTemplates()).get("legacy");
	assert.equal(stored.expression, "A + (A * B)");
});

test("迁移是幂等的：二次 ready 不改变已迁移数据", async () => {
	const { repo, services } = await setup();
	await services.templates.create("tpl-1", "g", { expression: "A+B" });
	const first = JSON.stringify([...await repo.listTemplates()]);
	const services2 = createServices(repo);
	await services2.ready();
	const second = JSON.stringify([...await repo.listTemplates()]);
	assert.equal(first, second);
});

test("兼容旧客户端：只传 config 也能创建（表达式自动反推）", async () => {
	const { services } = await setup();
	const rec = await services.templates.create("tpl-1", "g", { config: { orTags: ["t-a"], andGroups: [] } });
	assert.equal(rec.expression, "A");
});
