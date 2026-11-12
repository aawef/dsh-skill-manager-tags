// skill-scan.js — invocation 解析（2026-11-02 缺陷 1）
//
// 宿主 isModelInvocable 的输入就是 invocation.modelInvocable，它的来源是
// SKILL.md frontmatter 的 disable-model-invocation。自扫描必须用同一口径解析，
// 否则那些「只能 /name 手动调用」的技能会被算进"下发给模型"。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { scanSkillRoots, invocationOf } from "../src/skill-scan.js";

test("invocationOf：缺省两项都可调用", () => {
	assert.deepEqual(invocationOf({ name: "a" }), { modelInvocable: true, userInvocable: true });
	assert.deepEqual(invocationOf(null), { modelInvocable: true, userInvocable: true });
});

test("invocationOf：disable-model-invocation 关掉模型可见（宿主的 true/1/yes/on 都认）", () => {
	for (const v of ["true", "TRUE", "1", "yes", "on"]) {
		assert.equal(invocationOf({ "disable-model-invocation": v }).modelInvocable, false, v);
	}
	for (const v of ["false", "no", "off", "0"]) {
		assert.equal(invocationOf({ "disable-model-invocation": v }).modelInvocable, true, v);
	}
});

test("invocationOf：user-invocable: false 只关掉手动调用，不影响模型可见", () => {
	const inv = invocationOf({ "user-invocable": "false" });
	assert.deepEqual(inv, { modelInvocable: true, userInvocable: false });
});

test("scanSkillRoots：扫描结果带上 frontmatter 解析出的 invocation", () => {
	// 不用 os.tmpdir()：本机沙箱下 mkdtemp 会 EPERM，改在包目录里建临时根。
	const home = fs.mkdtempSync(path.join(process.cwd(), ".tmp-scan-"));
	try {
		const root = path.join(home, ".dsh", "skills");
		const mk = (name, extra) => {
			const dir = path.join(root, name);
			fs.mkdirSync(dir, { recursive: true });
			const fm = ["---", "name: " + name, "description: d", extra, "---", "body", ""].filter((x) => x !== "").join("\n");
			fs.writeFileSync(path.join(dir, "SKILL.md"), fm);
		};
		mk("plain", null);
		mk("manual-only", "disable-model-invocation: true");
		const out = scanSkillRoots(null, [], { home });
		const byName = Object.fromEntries(out.map((s) => [s.name, s]));
		assert.equal(byName["plain"].invocation.modelInvocable, true);
		assert.equal(byName["manual-only"].invocation.modelInvocable, false, "disable-model-invocation 必须被扫描器识别");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

// ── issue #6：裸放的根级 .md 必须与宿主同口径 ────────────────────────────────
//
// 宿主 @deepseek-ai/dsh-skill-filesystem 的 discoverRoot → parseSkillFile 对
// 根级 flat .md 的规则：没有 frontmatter → 忽略；缺 name/description → 忽略；
// 名字不是 kebab-case → 忽略（日志 "skill file ... ignored: invalid skill name"）。
// 自扫描旧实现会拿文件名凭空造名字，于是 `README-官方技能说明.md` 变成了一个
// "技能"，再经 denied 发射出去，宿主 validateCandidate 抛错 → 所有对话失败。
test("scanSkillRoots：根级裸放的 .md 必须有 frontmatter，否则不是技能", () => {
	const home = fs.mkdtempSync(path.join(process.cwd(), ".tmp-scan-flat-"));
	try {
		const root = path.join(home, ".dsh", "skills");
		fs.mkdirSync(root, { recursive: true });
		// 1) 普通文档：没有 frontmatter —— 报告人现场那种
		fs.writeFileSync(path.join(root, "README-官方技能说明.md"), "# 只是一份说明\n正文\n");
		// 2) 合法 flat skill：有 frontmatter 且 name 合法
		fs.writeFileSync(path.join(root, "flat-ok.md"), "---\nname: flat-ok\ndescription: d\n---\nbody\n");
		// 3) 有 frontmatter 但名字非法
		fs.writeFileSync(path.join(root, "bad-name.md"), "---\nname: Bad Name\ndescription: d\n---\nbody\n");

		const out = scanSkillRoots(null, [], { home });
		const names = out.map((s) => s.name).sort();
		assert.deepEqual(names, ["flat-ok"], "只有合法且带 frontmatter 的 flat skill 才算技能");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("scanSkillRoots：目录 bundle 的名字非法时同样跳过（不进 universe）", () => {
	const home = fs.mkdtempSync(path.join(process.cwd(), ".tmp-scan-bundle-"));
	try {
		const root = path.join(home, ".dsh", "skills");
		const mk = (dir, fm) => {
			fs.mkdirSync(path.join(root, dir), { recursive: true });
			fs.writeFileSync(path.join(root, dir, "SKILL.md"), fm);
		};
		mk("good-one", "---\nname: good-one\ndescription: d\n---\nbody\n");
		mk("bad-one", "---\nname: 中文技能\ndescription: d\n---\nbody\n");
		const out = scanSkillRoots(null, [], { home });
		assert.deepEqual(out.map((s) => s.name), ["good-one"]);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
