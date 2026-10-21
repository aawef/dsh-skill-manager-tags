// skill 联系 tag / 打开技能文件夹 — 领域纯函数 + HTTP 层
//
// 覆盖本轮三项改动：
//   1. /skills 透传 path（「打开文件夹」按钮的数据来源）
//   2. /skills/tags 读写一个技能拥有的标签（skill 联系 tag 页）
//   3. /skills/reveal 拉起文件管理器（src/reveal.js）

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { revealCommand, assertRevealable, revealInExplorer } from "../src/reveal.js";
import { createServices } from "../src/service.js";
import { createMemoryRepository } from "../src/storage/repository.js";
import { createApiHandler } from "../src/api.js";

// ── src/reveal.js 纯函数 ────────────────────────────────────────────────────

test("revealCommand：win32 用 explorer /select，darwin 用 open -R，其它用 xdg-open 打开父目录", () => {
	const p = "C:\\proj\\.dsh\\skills\\alpha\\SKILL.md";
	assert.deepEqual(revealCommand(p, "win32"), { command: "explorer.exe", args: [`/select,${p}`] });
	assert.deepEqual(revealCommand("/s/alpha/SKILL.md", "darwin"), { command: "open", args: ["-R", "/s/alpha/SKILL.md"] });
	// Linux 没有通用的「显示文件」语义 → 只打开父目录
	assert.deepEqual(revealCommand("/s/alpha/SKILL.md", "linux"), { command: "xdg-open", args: ["/s/alpha"] });
});

test("revealCommand：空路径直接拒绝（不拉起 explorer 打开随机位置）", () => {
	assert.throws(() => revealCommand("", "win32"), /路径为空/);
	assert.throws(() => revealCommand("   ", "win32"), /路径为空/);
});

test("assertRevealable：非技能文件 / 不存在的路径都被挡住", () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-tag-reveal-"));
	try {
		const md = join(dir, "SKILL.md");
		writeFileSync(md, "---\nname: alpha\n---\n");
		assert.equal(assertRevealable(md), md);

		// SKILL.md.disabled 也认（宿主把技能停用后的文件名）
		const off = join(dir, "SKILL.md.disabled");
		writeFileSync(off, "x");
		assert.equal(assertRevealable(off), off);

		assert.throws(() => assertRevealable(join(dir, "notes.txt")), (e) => e.code === "NOT_SKILL_FILE");
		assert.throws(() => assertRevealable(join(dir, "nope.md")), (e) => e.code === "NOT_FOUND");
		assert.throws(() => assertRevealable(""), (e) => e.code === "NO_PATH");
		// 目录虽然以 .md 结尾也不是文件
		const dirMd = join(dir, "weird.md");
		mkdirSync(dirMd);
		assert.throws(() => assertRevealable(dirMd), (e) => e.code === "NOT_FILE");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("revealInExplorer：spawn 抛错不得冒泡（宿主调用栈上是 fatal）", () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-tag-reveal-"));
	try {
		const md = join(dir, "SKILL.md");
		writeFileSync(md, "---\nname: alpha\n---\n");
		const boom = () => { throw new Error("spawn ENOENT"); };
		const out = revealInExplorer(md, { platform: "win32", spawnImpl: boom });
		assert.equal(out.ok, false);
		assert.match(out.error, /spawn ENOENT/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("revealInExplorer：正常路径返回 ok + 实际命令（不真的启动进程）", () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-tag-reveal-"));
	try {
		const md = join(dir, "SKILL.md");
		writeFileSync(md, "---\nname: alpha\n---\n");
		const seen = {};
		const fakeSpawn = (command, args) => {
			seen.command = command;
			seen.args = args;
			return { on() {}, unref() {} };
		};
		const out = revealInExplorer(md, { platform: "win32", spawnImpl: fakeSpawn });
		assert.equal(out.ok, true);
		assert.equal(seen.command, "explorer.exe");
		assert.deepEqual(seen.args, [`/select,${md}`]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// 回归：曾经传 windowsHide:true，explorer 窗口照建但 Visible=False，
// 用户点了没反应、后台却积了二十几个幽灵窗口。
test("revealInExplorer：spawn 选项不得带 windowsHide（否则资源管理器窗口不可见）", () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-tag-reveal-"));
	try {
		const md = join(dir, "SKILL.md");
		writeFileSync(md, "x");
		const seen = {};
		const fakeSpawn = (command, args, options) => {
			seen.options = options;
			return { on() {}, unref() {} };
		};
		revealInExplorer(md, { platform: "win32", spawnImpl: fakeSpawn });
		assert.equal(seen.options.windowsHide, undefined, "windowsHide 会让窗口不可见");
		assert.equal(seen.options.detached, true);
		assert.equal(seen.options.stdio, "ignore");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── HTTP 层 ─────────────────────────────────────────────────────────────────

async function boot(listSkills) {
	const s = createServices(createMemoryRepository());
	await s.ready();
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
	return { s, call, close: () => new Promise((r) => server.close(r)) };
}

test("API：/skills 透传 path（打开文件夹按钮的数据来源）", async () => {
	const list = () => [
		{ name: "alpha", description: "", source: "user", path: "C:\\s\\alpha\\SKILL.md" },
		{ name: "beta", description: "", source: "project", path: "C:\\s\\beta\\SKILL.md" },
	];
	const { call, close } = await boot(list);
	try {
		const d = await call("/skills", {});
		assert.equal(d.ok, true);
		assert.deepEqual(d.skills.map((s) => s.path), ["C:\\s\\alpha\\SKILL.md", "C:\\s\\beta\\SKILL.md"]);

		// 工作区右列载荷也带 catalog（前端不用再扫一遍就能拿到 path）
		const w = await call("/workspaces/skills", { workspaceId: "ws-1" });
		assert.equal(w.ok, true);
		assert.deepEqual(w.catalog.map((s) => s.name), ["alpha", "beta"]);
		assert.equal(w.catalog[0].path, "C:\\s\\alpha\\SKILL.md");
	} finally {
		await close();
	}
});

test("API：/skills/reveal 用 skillName 反查 path，找不到回 404", async () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-tag-reveal-"));
	const md = join(dir, "SKILL.md");
	writeFileSync(md, "---\nname: alpha\n---\n");
	const list = () => [{ name: "alpha", description: "", source: "user", path: md }];
	const { call, close } = await boot(list);
	try {
		// 只给名字：服务端自己查路径（UI 手里没有 path 的场合）
		const d = await call("/skills/reveal", { skillName: "alpha" });
		assert.equal(d.ok, true);
		assert.match(d.command, /explorer\.exe|xdg-open|open$/);

		// 不存在的技能
		const miss = await call("/skills/reveal", { skillName: "ghost" });
		assert.equal(miss.status, 404);
		assert.equal(miss.ok, false);

		// 非法路径（不是 .md）→ 400 带 code，不是 500
		const bad = await call("/skills/reveal", { path: "C:\\Windows\\notepad.exe" });
		assert.equal(bad.status, 400);
		assert.equal(bad.code, "NOT_SKILL_FILE");
	} finally {
		await close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("API：/skills/tags 读写一个技能拥有的标签（skill 联系 tag）", async () => {
	const list = () => [{ name: "alpha", description: "", source: "user", path: null }];
	const { s, call, close } = await boot(list);
	try {
		await s.tags.create("t1", "前端");
		await s.tags.create("t2", "后端");

		// 初始：无标签
		let d = await call("/skills/tags", { skillName: "alpha" });
		assert.equal(d.ok, true);
		assert.deepEqual(d.tagIds, []);
		assert.equal(d.tags.length, 2);
		assert.equal(d.skill.name, "alpha");

		// 整体覆盖为 [t1, t2]
		d = await call("/skills/tags", { skillName: "alpha", tagIds: ["t1", "t2"] });
		assert.deepEqual(d.tagIds, ["t1", "t2"]);
		assert.deepEqual(s.tags.tagsForSkill("alpha"), ["t1", "t2"]);

		// 读回来一致（同一份 skill_links 记录，tag→skill 页也看得到）
		d = await call("/skills/tags", { skillName: "alpha" });
		assert.deepEqual(d.tagIds, ["t1", "t2"]);
		assert.deepEqual(s.tags.skillsForTag("t1"), ["alpha"]);

		// 覆盖为 [t2]：t1 被摘掉（不是追加）
		d = await call("/skills/tags", { skillName: "alpha", tagIds: ["t2"] });
		assert.deepEqual(d.tagIds, ["t2"]);
		assert.deepEqual(s.tags.skillsForTag("t1"), []);

		// 清空 = 删除整条连接记录
		d = await call("/skills/tags", { skillName: "alpha", tagIds: [] });
		assert.deepEqual(d.tagIds, []);
		assert.equal(s._caches.skillLinks.has("alpha"), false);

		// 不存在的标签 → 400（服务层抛错，不得静默丢弃）
		d = await call("/skills/tags", { skillName: "alpha", tagIds: ["nope"] });
		assert.equal(d.status, 500);
		assert.equal(d.ok, false);
	} finally {
		await close();
	}
});

test("API：/skills/tags 缺 skillName 回 400；两个方向写同一份记录", async () => {
	const list = () => [{ name: "alpha", description: "", source: "user", path: null }];
	const { s, call, close } = await boot(list);
	try {
		const bad = await call("/skills/tags", {});
		assert.equal(bad.status, 400);

		await s.tags.create("t1", "前端");
		await s.tags.create("t2", "后端");
		// 从 skill 侧写
		await call("/skills/tags", { skillName: "alpha", tagIds: ["t1"] });
		// 从 tag 侧读（/tags/link 的老路径）→ 应看到同一条记录
		assert.deepEqual(s.tags.tagsForSkill("alpha"), ["t1"]);
		// 反过来从 tag 侧写，skill 侧立刻可见
		await s.tags.linkSkill("alpha", ["t1", "t2"]);
		const d = await call("/skills/tags", { skillName: "alpha" });
		assert.deepEqual(d.tagIds, ["t1", "t2"]);
	} finally {
		await close();
	}
});
