// deny-shadow 的**覆盖率**回归（2026-10-22）
//
// 线上症状：模型上下文里有 71 条技能，插件口径 universe 105 / visible 54 /
// denied 51，成功屏蔽 34，另外 17 个（aegis 4 / mattpocock 4 / archify 1 /
// dsh-skill-tag 1 / office 7）永远穿透，而且日志、右列界面、/skills 接口全对。
//
// 根因：影子只从"本次 list() 里看得见的 summary"里发。重入守卫被占住时宿主快照
// 被整段跳过，summaries 退化成扫盘结果 → 只有文件系统根来的技能拿到影子，
// 由别的 provider / npm 包 / 运行时送进来的技能一条都没有。
//
// 修法：影子按**名字**发，看不见的名字也发（造一条最小合法候选）。
// 下面这组用例锁住"覆盖率"，以及"造出来的候选必须通过宿主强校验"。

import test from "node:test";
import assert from "node:assert/strict";

import { createFilterProvider, createUpstreamAdapter } from "../lib/index.js";

// 与 @deepseek-ai/dsh-skill 的 validateCandidate 等价的最小校验：
// 任一候选不合法 → 整个 provider.list() 抛错 → 宿主丢弃本插件的全部影子。
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function assertHostValid(candidates, providerName = "skill-tag") {
	for (const c of candidates) {
		assert.equal(typeof c.name, "string", "name 必须是字符串");
		assert.match(c.name, SKILL_NAME, `name 必须是 kebab-case：${c.name}`);
		assert.equal(typeof c.description, "string", "description 必须是字符串");
		assert.ok(c.description.length > 0, "description 不得为空");
		assert.equal(typeof c.invocation, "object", "invocation 必须是对象");
		assert.equal(typeof c.invocation.modelInvocable, "boolean");
		assert.equal(typeof c.invocation.userInvocable, "boolean");
		assert.equal(typeof c.source, "string", "source 必须是字符串");
		assert.equal(typeof c.rank, "number");
		assert.ok(Number.isFinite(c.rank), "rank 必须是有限数");
		assert.equal(c.provider, providerName, "provider 必须等于本 provider 名");
		if (c.path !== undefined) assert.equal(typeof c.path, "string", "path 若存在必须是字符串");
	}
}

// 只落在文件系统根上的技能（scanSkillRoots 能看到）
const FS_SKILLS = ["algorithmic-art", "brand-guidelines", "docx", "pptx", "pdf"];
// 由别的 provider / npm 包 / 运行时送进来的技能（扫盘永远看不到）
const PACKAGE_SKILLS = [
	"office", "office-docx", "office-export-pdf", "office-pptx",
	"office-recalculate", "office-render", "office-xlsx",
	"ask-matt", "research", "teach", "writing-for-agents",
	"using-aegis", "update-aegis", "writing-skills", "communicating-concisely",
	"archify", "tagging-skills",
];
const ALL = [...FS_SKILLS, ...PACKAGE_SKILLS];

function hostRegistryOf(names) {
	return {
		async snapshot() {
			return {
				skills: names.map((name) => ({ name, description: `desc of ${name}`, source: "fake", rank: 100 })),
				complete: true,
			};
		},
		async get(name) {
			return { name: name?.name ?? name, description: "x", content: "" };
		},
	};
}

const fsOnlyScan = () => FS_SKILLS.map((name) => ({ name, description: `desc of ${name}`, source: "fs", rank: 600 }));

test("守卫被占（宿主快照被跳过）时，denied 里的每个名字都必须拿到影子", async () => {
	const guard = { depth: 0 };
	const upstream = createUpstreamAdapter({ rootsScan: fsOnlyScan, hostRegistry: hostRegistryOf(ALL), guard });
	const denied = new Set(ALL);

	// 模拟"另一个 snapshot 在飞"：本次 list 期间守卫是被占住的
	guard.depth = 1;
	const shadows = await createFilterProvider("sess", upstream, denied).list({ cwd: "C:/ws" });
	guard.depth = 0;

	const names = shadows.map((s) => s.name).sort();
	assert.deepEqual(names, [...ALL].sort(), "17 个包技能也必须被屏蔽，不能原样漏给模型");
	assertHostValid(shadows);
	assert.equal(upstream.lastDegraded, true, "这一趟确实降级了");
});

test("对照：守卫空闲时结果一致（退回扫盘不应改变屏蔽结果）", async () => {
	const upstream = createUpstreamAdapter({ rootsScan: fsOnlyScan, hostRegistry: hostRegistryOf(ALL) });
	const denied = new Set(ALL);
	const healthy = await createFilterProvider("sess", upstream, denied).list({ cwd: "C:/ws" });
	const degraded = await createFilterProvider(
		"sess",
		createUpstreamAdapter({ rootsScan: fsOnlyScan, hostRegistry: hostRegistryOf(ALL), guard: { depth: 1 } }),
		denied,
	).list({ cwd: "C:/ws" });
	assert.deepEqual(healthy.map((s) => s.name).sort(), degraded.map((s) => s.name).sort());
	assertHostValid(healthy);
});

test("宿主快照直接抛错时也不得放行（旧实现返回空增量 = 全部技能可见）", async () => {
	const upstream = createUpstreamAdapter({
		rootsScan: fsOnlyScan,
		hostRegistry: { async snapshot() { throw new Error("registry down"); } },
	});
	const shadows = await createFilterProvider("s", upstream, new Set(["using-aegis"])).list({});
	assert.deepEqual(shadows.map((s) => s.name), ["using-aegis"]);
	assertHostValid(shadows);
});

test("看得见的技能：保留上游描述/路径，只把 invocation 换成 deny，rank 压到层内最小", async () => {
	const upstream = createUpstreamAdapter({
		rootsScan: () => [{ name: "pdf", description: "PDF 工具", source: "user-dsh", path: "C:/s/pdf/SKILL.md", rank: 600 }],
		hostRegistry: null,
	});
	const [shadow] = await createFilterProvider("s", upstream, new Set(["pdf"])).list({});
	assert.equal(shadow.name, "pdf");
	assert.equal(shadow.path, "C:/s/pdf/SKILL.md", "路径要留着，右列才能打开文件夹");
	assert.equal(shadow.description, "[blocked by skill-tag] PDF 工具");
	assert.deepEqual(shadow.invocation, { modelInvocable: false, userInvocable: false });
	// 宿主层内排序：rank 升序、小的先胜（compareIndexedCandidates）
	assert.equal(shadow.rank, 0, "必须小于 RUNTIME_RANK(250) / BUNDLED_SKILL_RANK(600)，否则同层会被顶掉");
	assertHostValid([shadow]);
});

test("同一个名字只发一条影子（可见 + 补发不得重复）", async () => {
	const upstream = createUpstreamAdapter({ rootsScan: fsOnlyScan, hostRegistry: hostRegistryOf(ALL) });
	const shadows = await createFilterProvider("s", upstream, new Set(["pdf", "office"])).list({});
	assert.deepEqual(shadows.map((s) => s.name).sort(), ["office", "pdf"]);
});

test("denied 里的脏名字不得炸掉整批影子（宿主强校验会丢弃整个 provider）", async () => {
	const upstream = createUpstreamAdapter({ rootsScan: fsOnlyScan, hostRegistry: hostRegistryOf(ALL) });
	// 存储里可能残留的历史名字：带空格 / 大写 / 中文 / 空串
	const denied = new Set(["pdf", "office", "Not A Skill", "UPPER", "中文技能", "", "pdf"]);
	const warnings = [];
	const shadows = await createFilterProvider("s", upstream, denied, null, (m) => warnings.push(m)).list({});
	assert.deepEqual(shadows.map((s) => s.name).sort(), ["office", "pdf"], "合法名字照发，脏名字跳过");
	assertHostValid(shadows);
	assert.ok(warnings.some((m) => m.includes("not kebab-case")), "脏名字要留下观测痕迹");
});

test("补发必须留观测：正常路径不吭声，发生补发时打一行 warn", async () => {
	const upstream = createUpstreamAdapter({ rootsScan: fsOnlyScan, hostRegistry: hostRegistryOf(ALL) });
	const loud = [];
	// 健康路径：denied 全在可见集合里 → 没有补发 → 不说话
	await createFilterProvider("s", upstream, new Set(["pdf", "office"]), null, (m) => loud.push(m)).list({});
	assert.deepEqual(loud, [], "健康路径不得刷日志");

	// 降级路径：包技能不可见 → 补发 → 必须留下痕迹（否则这类失效又是静默的）
	const guard = { depth: 1 };
	const nested = [];
	await createFilterProvider(
		"s",
		createUpstreamAdapter({ rootsScan: fsOnlyScan, hostRegistry: hostRegistryOf(ALL), guard }),
		new Set(["pdf", "office"]),
		null,
		(m) => nested.push(m),
	).list({});
	assert.equal(nested.length, 1);
	assert.match(nested[0], /backfill/);
	assert.match(nested[0], /hostSnapshot=skipped\(nested\)/);
});

test("观测回调自己抛错也不得影响屏蔽结果", async () => {
	const upstream = createUpstreamAdapter({ rootsScan: fsOnlyScan, hostRegistry: null });
	const shadows = await createFilterProvider("s", upstream, new Set(["pdf"]), null, () => { throw new Error("logger down"); }).list({});
	assert.deepEqual(shadows.map((s) => s.name), ["pdf"]);
});

// ── get 路径：不得回问宿主 ────────────────────────────────────────────────────
//
// 宿主 registry.get(name) 的流程是 collect() → 选中胜出候选（agent 层里就是
// 这条影子）→ 调影子自己的 provider.get。若 provider.get 再回问宿主，就是
//   registry.get → provider.get → registry.get → …
// 无限自递归。dsh-tool-skill 的 agent/pre-step 对 `/name` 手势是「先 get 再判
// invocation」，所以用户敲一次 `/<被屏蔽的技能名>` 就能撞上，表现为界面卡死。
test("get 被屏蔽的名字：直接给 deny 定义，绝不回问宿主（否则自递归）", async () => {
	let getDefinitionCalls = 0;
	let snapshotCalls = 0;
	const upstream = {
		async summaries() { snapshotCalls += 1; return ALL.map((name) => ({ name, description: `d of ${name}` })); },
		async getDefinition() { getDefinitionCalls += 1; throw new Error("不该被调用"); },
	};
	const p = createFilterProvider("sess", upstream, new Set(["office-docx"]));
	const def = await p.get({ name: "office-docx", description: "上游描述" }, { cwd: "/w" });
	assert.equal(getDefinitionCalls, 0, "被屏蔽的名字必须就地返回，不能回问宿主");
	assert.equal(snapshotCalls, 0, "也不该为了拿正文去触发一次 snapshot");

	// 形状必须过宿主的 validateDefinition
	assert.equal(def.name, "office-docx");
	assert.equal(typeof def.description, "string");
	assert.ok(def.description.length > 0);
	assert.equal(def.description, "[blocked by skill-tag] 上游描述");
	assert.deepEqual(def.invocation, { modelInvocable: false, userInvocable: false });
	assert.equal(def.provider, "skill-tag");
	assert.equal(typeof def.source, "string");
	assert.equal(def.content, "", "正文必须是字符串（宿主强校验）");
});

test("get 放行的名字：照旧委托上游取正文", async () => {
	const upstream = {
		async summaries() { return []; },
		async getDefinition(c) {
			return { name: c.name, description: "d", provider: "filesystem", source: "user-dsh", content: "# body" };
		},
	};
	const p = createFilterProvider("sess", upstream, new Set(["office-docx"]));
	const def = await p.get({ name: "pdf" }, {});
	assert.equal(def.content, "# body", "放行的技能必须拿到真正文");
	assert.equal(def.provider, "filesystem", "不得被改写");
});
