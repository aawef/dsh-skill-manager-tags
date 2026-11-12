// #6 回归：**看得见**的脏名字会炸掉整个 provider.list()
//
// 线上症状（报告人截图）：
//   skill provider "skill-tag" returned invalid skill name "README-官方技能说明"
//   → 本轮运行失败，全机所有对话都跑不下去。
//
// 触发链：
//   1. 技能根目录（~/.dsh/skills）下裸放一个 .md，src/skill-scan.js 把它当技能，
//      名字取文件名去 .md → "README-官方技能说明"（不是 kebab-case）；
//   2. 这个名字进了 universe，于是 denied = universe − visible 里也有它；
//   3. createFilterProvider().list() **第一段**把 upstream.summaries() 的条目
//      整条照抄成影子，只换 invocation/provider/rank —— 没校验 name；
//   4. 宿主 validateCandidate 见到非法 name 直接 throw，整个 provider 这一趟作废。
//
// 旧测试只覆盖了"第二段"（denied 里看不见的名字，那里有 isSkillName 过滤），
// 所以这条路径一直没被锁住。本文件补上"看得见"的那一段。

import test from "node:test";
import assert from "node:assert/strict";

import { createFilterProvider, createUpstreamAdapter } from "../lib/index.js";

// 与 @deepseek-ai/dsh-skill validateCandidate 等价：任一候选不合法 → 整个 list() 抛错。
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function assertHostValid(candidates) {
	for (const c of candidates) {
		assert.match(String(c.name), SKILL_NAME, `宿主会拒绝这个名字：${c.name}`);
		assert.ok(typeof c.description === "string" && c.description.length > 0);
		assert.equal(c.provider, "skill-tag");
		assert.equal(typeof c.rank, "number");
		assert.ok(Number.isFinite(c.rank));
	}
}

// 报告人现场的形态：技能根下裸放的 README 被当成技能名。
const DIRTY = "README-官方技能说明";
const CLEAN = ["pdf", "office"];

/** 模拟扫盘：脏名字和干净名字一起被扫出来（都"看得见"）。 */
function scanWithDirty() {
	return [...CLEAN, DIRTY].map((name) => ({ name, description: `desc of ${name}`, source: "fs", rank: 600 }));
}

test("#6 看得见的脏名字不得进入候选（否则整个 list 被宿主丢弃）", async () => {
	const upstream = createUpstreamAdapter({ rootsScan: scanWithDirty, hostRegistry: null });
	const warnings = [];
	// universe = 扫盘结果，denied = universe − visible → 脏名字也在 denied 里
	const shadows = await createFilterProvider("s", upstream, new Set([...CLEAN, DIRTY]), null, (m) => warnings.push(m)).list({});

	const names = shadows.map((s) => s.name).sort();
	assert.deepEqual(names, [...CLEAN].sort(), "合法名字照发，脏名字跳过");
	assertHostValid(shadows);
	assert.ok(
		warnings.some((m) => m.includes("not kebab-case")),
		"脏名字要留下观测痕迹，不能静默丢",
	);
});

test("#6 脏名字不得因为'看得见'就绕过校验（对照：同样的名字看不见时本来就被跳过）", async () => {
	// 看不见的路径（第二段）已有校验，这里只确认两条路径结论一致。
	const visible = createUpstreamAdapter({ rootsScan: scanWithDirty, hostRegistry: null });
	const hidden = createUpstreamAdapter({
		rootsScan: () => CLEAN.map((name) => ({ name, description: `d ${name}`, source: "fs", rank: 600 })),
		hostRegistry: null,
	});
	const denied = new Set([...CLEAN, DIRTY]);
	const a = await createFilterProvider("s", visible, denied).list({});
	const b = await createFilterProvider("s", hidden, denied).list({});
	assert.deepEqual(a.map((s) => s.name).sort(), b.map((s) => s.name).sort());
	assertHostValid(a);
});

test("#6 脏名字旁边的干净影子必须照常发出（不能被连坐）", async () => {
	const upstream = createUpstreamAdapter({ rootsScan: scanWithDirty, hostRegistry: null });
	const shadows = await createFilterProvider("s", upstream, new Set([...CLEAN, DIRTY])).list({});
	assert.equal(shadows.length, CLEAN.length, "脏名字只跳过它自己");
	assertHostValid(shadows);
});
