import { test } from "node:test";
import assert from "node:assert/strict";

import { originTagOf, isPackageDelivered, safeTagName } from "../src/domain/origin.js";

const HOME = "C:/Users/someone";

const s = (path, source = null) => ({ name: "x", path, source });

// ── safeTagName ────────────────────────────────────────────────────────────

test("safeTagName 去掉表达式操作符与空白", () => {
	assert.equal(safeTagName("a b"), "a-b");
	assert.equal(safeTagName("a+b"), "a-b");
	assert.equal(safeTagName("a(b)"), "a-b");
	assert.equal(safeTagName("a（b）"), "a-b");
	assert.equal(safeTagName("  a  "), "a");
	assert.equal(safeTagName(""), "unknown");
	assert.equal(safeTagName(null), "unknown");
	assert.equal(safeTagName("a--b"), "a-b");
});

// ── 来源推导：包带来的 ──────────────────────────────────────────────────────

test("node_modules 路径 → 包名（含 @scope 取两段）", () => {
	assert.equal(
		originTagOf(s("C:\\p\\node_modules\\aegis\\skills\\brainstorming\\SKILL.md")),
		"aegis",
	);
	assert.equal(
		originTagOf(s("/home/u/.dsh/profiles/desktop/node_modules/@tt-a1i/archify-dsh/skills/archify/SKILL.md")),
		"@tt-a1i/archify-dsh",
	);
	assert.equal(
		originTagOf(s("/x/node_modules/mattpocock-skills-dsh/skills/tdd/SKILL.md")),
		"mattpocock-skills-dsh",
	);
});

test("resources/runtime 路径 → 目录名", () => {
	assert.equal(
		originTagOf(s("E:\\1\\dsh desktop\\resources\\runtime\\office-skills\\office\\SKILL.md")),
		"office-skills",
	);
});

test("path 为 null → builtin", () => {
	assert.equal(originTagOf(s(null)), "builtin");
	assert.equal(originTagOf({ name: "x" }), "builtin");
});

// ── 来源推导：文件系统根扫到的 ──────────────────────────────────────────────

test("用户级根 → dsh-home / agents-home（需要 home 且在 home 下）", () => {
	assert.equal(
		originTagOf(s(`${HOME}/.dsh/skills/pdf/SKILL.md`, `${HOME}/.dsh/skills`), { home: HOME }),
		"dsh-home",
	);
	assert.equal(
		originTagOf(s(`${HOME}/.agents/skills/hindsight/SKILL.md`, `${HOME}/.agents/skills`), { home: HOME }),
		"agents-home",
	);
});

test("项目级同名根 → project-skills / project-agents", () => {
	const proj = "D:/work/repo";
	assert.equal(
		originTagOf(s(`${proj}/.dsh/skills/foo/SKILL.md`, `${proj}/.dsh/skills`), { home: HOME }),
		"project-skills",
	);
	assert.equal(
		originTagOf(s(`${proj}/.agents/skills/bar/SKILL.md`, `${proj}/.agents/skills`), { home: HOME }),
		"project-agents",
	);
});

test("自定义根 → 根目录最后一段（经 safeTagName）", () => {
	assert.equal(
		originTagOf(s("D:/my skills/skills/foo/SKILL.md", "D:/my skills/skills"), { home: HOME }),
		"skills",
	);
});

test("不传 home 时退回环境变量 home，不抛错", () => {
	const envHome = (process.env.USERPROFILE || process.env.HOME || "").replace(/\\/g, "/");
	assert.ok(envHome, "测试环境应能拿到 USERPROFILE/HOME");
	assert.equal(
		originTagOf(s(`${envHome}/.dsh/skills/pdf/SKILL.md`, `${envHome}/.dsh/skills`)),
		"dsh-home",
	);
});

test("根目录不在 home 下 → 项目级", () => {
	assert.equal(
		originTagOf(s("D:/other/.dsh/skills/x/SKILL.md", "D:/other/.dsh/skills")),
		"project-skills",
	);
});

// ── plugin 旋塞 ────────────────────────────────────────────────────────────

test("包/运行时送进来的 → isPackageDelivered 为真；用户自己放的不算", () => {
	assert.equal(isPackageDelivered(s("C:\\p\\node_modules\\aegis\\skills\\x\\SKILL.md")), true);
	assert.equal(isPackageDelivered(s(null)), true); // asar 内置
	assert.equal(
		isPackageDelivered(s(`${HOME}/.dsh/skills/x/SKILL.md`, `${HOME}/.dsh/skills`), { home: HOME }),
		false,
	);
});

// ── 真实快照：本机 96 条的分布特征（回归锚） ────────────────────────────────

test("推导结果稳定且不含表达式操作符", () => {
	const cases = [
		["E:\\1\\dsh desktop\\resources\\app.asar\\x\\SKILL.md", null],
		["C:\\Users\\u\\.dsh\\profiles\\desktop\\node_modules\\aegis\\skills\\a\\SKILL.md", null],
		["C:\\Users\\u\\.dsh\\skills\\pdf\\SKILL.md", "C:\\Users\\u\\.dsh\\skills"],
	];
	const out = cases.map(([p, src]) => originTagOf(s(p, src), { home: "C:/Users/u" }));
	assert.deepEqual(out, ["builtin", "aegis", "dsh-home"]);
	for (const name of out) assert.equal(/[()+"'*\s]/.test(name), false);
});
