import { test } from "node:test";
import assert from "node:assert/strict";
import { planAndApply } from "../tools/auto-tag.mjs";
import { suggestDomains } from "../tools/domain-hints.mjs";
import { originTagOf, isPackageDelivered } from "../src/domain/origin.js";

// ── 一个最小假后端：只实现脚本用到的三个路由 ──────────────────────────────
function fakeApi(state) {
	const calls = [];
	const tags = new Map(state.tags.map((t) => [t.tagId, { ...t }]));
	const links = new Map(state.skillLinks.map((l) => [l.skillId, [...l.tagIds]]));
	let seq = 0;
	return {
		calls,
		state: { tags, links },
		api: async (path, payload = null) => {
			calls.push({ path, payload });
			if (path === "/tags") {
				const name = payload.name;
				if ([...tags.values()].some((t) => t.name === name)) throw new Error(`tag name '${name}' already exists`);
				const rec = { tagId: payload.tagId ?? `t-new${seq++}`, name, createdAt: 0 };
				tags.set(rec.tagId, rec);
				return { ok: true, tag: rec };
			}
			if (path.startsWith("/skills/tags")) {
				const qs = new URLSearchParams(path.split("?")[1] ?? "");
				const skillName = qs.get("skillName") ?? payload?.skillName;
				if (payload && Object.prototype.hasOwnProperty.call(payload, "tagIds")) {
					links.set(skillName, [...payload.tagIds]);
					return { ok: true, skillName, tagIds: [...payload.tagIds] };
				}
				return { ok: true, skillName, tagIds: [...(links.get(skillName) ?? [])] };
			}
			throw new Error("unexpected path " + path);
		},
	};
}

const HOME = "C:/Users/u";
// origin.js 不传 home 时退回 process.env，测试要确定性 —— 显式注入
const OPTS = { originOf: (s) => originTagOf(s, { home: HOME }), isPlugin: (s) => isPackageDelivered(s, { home: HOME }) };
const SKILLS = [
	{ name: "brainstorming", description: "brainstorm a plan", path: `${HOME}/p/node_modules/aegis/skills/brainstorming/SKILL.md`, source: "bundled" },
	{ name: "pdf", description: "read PDFs", path: `${HOME}/.dsh/skills/pdf/SKILL.md`, source: `${HOME}/.dsh/skills` },
	{ name: "office", description: "Office docs", path: null, source: "bundled" },
];

test("dry-run：不写任何数据，但算出计划", async () => {
	const { api, calls, state } = fakeApi({ tags: [], skillLinks: [] });
	const { summary, writes } = await planAndApply({ ...OPTS, api, skills: SKILLS, state: { tags: [], skillLinks: [] } });
	assert.equal(writes.length, 3);
	// 一个 /tags 都没发（dry-run），只有读
	assert.equal(calls.filter((c) => c.path === "/tags").length, 0);
	assert.equal(summary.tagsCreated, 4); // aegis plugin dsh-home builtin
	assert.deepEqual(summary.byOrigin, { aegis: 1, "dsh-home": 1, builtin: 1 });
	assert.equal(state.tags.size, 0);
});

test("apply：建缺失标签 + 逐技能合并写", async () => {
	const { api, state } = fakeApi({ tags: [], skillLinks: [] });
	const { summary } = await planAndApply({ ...OPTS, api, skills: SKILLS, state: { tags: [], skillLinks: [] }, apply: true });
	assert.equal(state.tags.size, 4);
	assert.deepEqual(summary.unknownNames, []);
	for (const [, l] of state.links) assert.ok(l.length >= 1);
	assert.deepEqual([...state.links.get("pdf")].sort(), [...state.links.get("pdf")].sort());
	assert.equal(state.links.get("pdf").length, 1); // 只挂 dsh-home（用户级根不算 plugin）
	assert.equal(state.links.get("brainstorming").length, 2); // aegis + plugin
});

test("幂等：已打过标签再跑一次，不再写任何东西", async () => {
	const { api, calls, state } = fakeApi({ tags: [], skillLinks: [] });
	const base = { ...OPTS, api, skills: SKILLS };
	await planAndApply({ ...base, state: { tags: [], skillLinks: [] }, apply: true });
	const tags1 = [...state.tags.values()];
	const links1 = new Map([...state.links].map(([k, v]) => [k, [...v]]));
	calls.length = 0;

	const second = await planAndApply({
		...base,
		state: { tags: tags1, skillLinks: [...state.links].map(([skillId, tagIds]) => ({ skillId, tagIds })) },
		apply: true,
	});
	assert.equal(second.summary.tagsCreated, 0);   // 不再新建
	assert.equal(second.writes.length, 0);         // 不再写链接
	assert.equal(second.summary.skillsTouched, 0);
	assert.deepEqual(new Map([...state.links].map(([k, v]) => [k, [...v]])), links1);
});

test("合并语义：写之前先读回旧 tagIds，不清掉已有标签", async () => {
	const existing = { tagId: "t-old", name: "keepme", createdAt: 0 };
	const { api, state } = fakeApi({
		tags: [existing],
		skillLinks: [{ skillId: "pdf", tagIds: ["t-old"] }],
	});
	await planAndApply({
		...OPTS, api, skills: SKILLS,
		state: { tags: [existing], skillLinks: [{ skillId: "pdf", tagIds: ["t-old"] }] },
		apply: true,
	});
	const pdfTags = state.links.get("pdf").map((id) => state.tags.get(id)?.name);
	assert.ok(pdfTags.includes("keepme"), `旧标签被清掉了：${pdfTags.join(",")}`);
	assert.ok(pdfTags.includes("dsh-home"));
});

test("领域映射文件里写错技能名 → unknownNames 列出来", async () => {
	const { api } = fakeApi({ tags: [], skillLinks: [] });
	const { summary } = await planAndApply({
		api, skills: SKILLS, state: { tags: [], skillLinks: [] },
		domainMap: new Map([["pdf", ["pdf", "nosuchskill"]]]),
	});
	assert.deepEqual(summary.unknownNames, ["pdf:nosuchskill"]);
});

test("--domain hints 走 suggestDomains，关键词用正则避免误命中", () => {
	// 'test' 不能命中 pressure-test 这类无关词
	assert.deepEqual(suggestDomains({ name: "grill-me", description: "Grill the user relentlessly about a plan" }), ["planning", "interview"]);
	assert.ok(!suggestDomains({ name: "brand-guidelines", description: "Apply brand colors" }).includes("testing"));
	assert.ok(suggestDomains({ name: "pdf", description: "read PDF files" }).includes("pdf"));
});
