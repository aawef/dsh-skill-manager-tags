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
