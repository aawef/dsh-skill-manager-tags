// 运行时生效口径 — 「对话 → 管理标签」究竟按哪份配置筛技能
//
// 这里的逻辑决定 deny-shadow 真的屏蔽哪些技能，是本功能唯一的"实际生效"出口，
// 所以单独测：own（对话自己的快照）与 ws（所属工作区）谁是权威。

import test from "node:test";
import assert from "node:assert/strict";

import {
	effectiveSkillsConfig, workspaceIdOfSession, workspaceIdOfPath, runtimeDeniedSkills,
	getWorkspaceRegistry, apply, createFilterProvider, createUpstreamAdapter,
} from "../lib/index.js";

const EMPTY = { orTags: [], andGroups: [] };
const UNIVERSE = ["alpha", "beta", "gamma", "delta"];

test("effectiveSkillsConfig：own 存在 → 用 own（即使它是空快照）", () => {
	const own = { config: EMPTY, manualSkills: [], disabledSkills: [] };
	const ws = { config: { orTags: ["t1"], andGroups: [] }, manualSkills: ["gamma"], disabledSkills: ["beta"] };
	const eff = effectiveSkillsConfig(own, ws);
	assert.deepEqual(eff.config, EMPTY, "空的 own 也是权威：用户已把对话与工作区解耦");
	assert.deepEqual(eff.manualSkills, []);
});

test("effectiveSkillsConfig：own 为 null → 退回工作区", () => {
	const ws = { config: { orTags: ["t1"], andGroups: [] }, manualSkills: ["gamma"], disabledSkills: ["beta"] };
	const eff = effectiveSkillsConfig(null, ws);
	assert.deepEqual(eff.config.orTags, ["t1"]);
	assert.deepEqual(eff.manualSkills, ["gamma"]);
	assert.deepEqual(eff.disabledSkills, ["beta"]);
});

test("effectiveSkillsConfig：两者都空 → null（不筛）", () => {
	assert.equal(effectiveSkillsConfig(null, null), null);
	assert.equal(effectiveSkillsConfig(undefined, undefined), null);
});

test("effectiveSkillsConfig：字段缺失时补默认值，不返回 undefined 字段", () => {
	const eff = effectiveSkillsConfig({}, null);
	assert.deepEqual(eff.config, EMPTY);
	assert.deepEqual(eff.manualSkills, []);
	assert.deepEqual(eff.disabledSkills, []);
});

test("runtimeDeniedSkills：对话有条件时按对话口径屏蔽（不看工作区）", () => {
	const eff = effectiveSkillsConfig(
		{ config: { orTags: ["t1"], andGroups: [] }, manualSkills: [], disabledSkills: [] },
		null,
	);
	const denied = runtimeDeniedSkills(eff, UNIVERSE, ["alpha"]);
	assert.deepEqual([...denied].sort(), ["beta", "delta", "gamma"]);
});

test("runtimeDeniedSkills：无条件 + 无禁用 → 一个都不屏蔽", () => {
	const eff = effectiveSkillsConfig({ config: EMPTY, manualSkills: [], disabledSkills: [] }, null);
	assert.equal(runtimeDeniedSkills(eff, UNIVERSE, []).size, 0);
});

test("runtimeDeniedSkills：禁用技能即使命中标签也屏蔽", () => {
	const eff = effectiveSkillsConfig(
		{ config: { orTags: ["t1"], andGroups: [] }, manualSkills: [], disabledSkills: ["alpha"] },
		null,
	);
	const denied = runtimeDeniedSkills(eff, UNIVERSE, ["alpha"]);
	assert.ok(denied.has("alpha"));
});

test("runtimeDeniedSkills：null 配置 → 空集合", () => {
	assert.equal(runtimeDeniedSkills(null, UNIVERSE, []).size, 0);
});

// ── 会话 → 工作区解析 ──────────────────────────────────────────────────────

const registry = {
	list: () => [
		{ id: "ws-1", path: "C:\\Users\\X\\ProjA", sessionIds: ["sess-a", "sess-b"] },
		{ id: "ws-2", path: "C:/Users/X/ProjB/", sessionIds: ["sess-c"] },
	],
	get: (id) => registry.list().find((w) => w.id === id),
};

test("workspaceIdOfSession：按 entity.sessionIds 反查", () => {
	assert.equal(workspaceIdOfSession(registry, "sess-a"), "ws-1");
	assert.equal(workspaceIdOfSession(registry, "sess-c"), "ws-2");
	assert.equal(workspaceIdOfSession(registry, "sess-unknown"), null);
});

test("workspaceIdOfSession：registry 缺失或异常时返回 null，不抛", () => {
	assert.equal(workspaceIdOfSession(null, "sess-a"), null);
	assert.equal(workspaceIdOfSession({}, "sess-a"), null);
	assert.equal(workspaceIdOfSession({ list: () => { throw new Error("boom"); } }, "sess-a"), null);
	assert.equal(workspaceIdOfSession(registry, ""), null);
});

test("workspaceIdOfPath：路径兜底（分隔符/大小写/尾斜杠不敏感）", () => {
	assert.equal(workspaceIdOfPath(registry, "c:\\users\\x\\proja"), "ws-1");
	assert.equal(workspaceIdOfPath(registry, "C:/Users/X/ProjB"), "ws-2");
	assert.equal(workspaceIdOfPath(registry, "C:\\nope"), null);
	assert.equal(workspaceIdOfPath(null, "C:\\Users\\X\\ProjA"), null);
});

// ── 生产崩溃回归（2026-10-20 host fatal load failure） ────────────────────
//
// 症状：点「对话 → 管理标签」后 DSH 桌面进程整体崩溃，日志是
//   `dsh: fatal load failure: Error: cannot get property "workspaceRegistry" without inject`
//   at refreshSession (.../lib/index.js:301)
//
// 根因：cordis 的服务必须声明式注入。`ctx.workspaceRegistry` 在没写进
// `export const inject` 时**直接抛异常**，而 `ctx.workspaceRegistry ?? ctx.get(...)`
// 的右侧兜底永远轮不到 —— 左侧先炸，异常从 `domain/changed` 回调冒到插件加载，
// 打死整个 host。下面三条锁住修复。

test("getWorkspaceRegistry：未声明 inject 的 ctx 只能走 ctx.get，不得直接读属性", () => {
	const expected = { list: () => [], get: () => null };
	// 模拟真实 cordis ctx：读 ctx.workspaceRegistry 会抛，get() 正常
	const ctx = {
		get(name) {
			if (name === "workspaceRegistry") return expected;
			return undefined;
		},
		get workspaceRegistry() {
			throw new Error('cannot get property "workspaceRegistry" without inject');
		},
	};
	assert.equal(getWorkspaceRegistry(ctx), expected, "必须走 ctx.get，不能碰属性");
});

test("getWorkspaceRegistry：服务缺失 / ctx 异常一律返回 null，不抛", () => {
	assert.equal(getWorkspaceRegistry(undefined), null);
	assert.equal(getWorkspaceRegistry({}), null);
	assert.equal(getWorkspaceRegistry({ get: () => undefined }), null);
	assert.equal(getWorkspaceRegistry({ get: () => { throw new Error("boom"); } }), null);
	// 关键：即使访问属性会抛，也不能让异常逃出去
	const ctx = Object.defineProperty({ get: () => undefined }, "workspaceRegistry", {
		get() { throw new Error('cannot get property "workspaceRegistry" without inject'); },
	});
	assert.equal(getWorkspaceRegistry(ctx), null);
});

// 监听器层：`domain/changed` 是宿主调用栈上的同步回调，cordis 把监听器异常
// 当 fatal（`Object.apply` → `dsh: fatal load failure` → 桌面进程退出）。
// 即使 refreshSession 内部已 try/catch，枚举/取服务本身仍可能同步抛。
test("domain/changed 监听器：内部抛错不得逃逸（否则 host 直接崩）", async () => {
	let listener;
	let agentsExplode = false;
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		effect(fn) { const out = fn(); return typeof out === "function" ? out : () => {}; },
		on(event, fn) { if (event === "domain/changed") listener = fn; },
		get(name) {
			if (name === "agents") {
				return {
					list() {
						if (agentsExplode) throw new Error("agents service exploded");
						return [];
					},
				};
			}
			return undefined;
		},
		storageDomain: null,
		webServer: undefined,
		skills: null,
	};
	await apply(ctx, {});
	assert.equal(typeof listener, "function", "必须注册 domain/changed 监听器");

	// 非本域事件：直接返回，不碰 agents
	agentsExplode = true;
	assert.doesNotThrow(() => listener({ domain: "other" }), "其他域的事件必须被忽略");
	// 本域事件 + agents 服务抛错：吞掉并记 warn，不得冒泡
	assert.doesNotThrow(() => listener({ domain: "skill_tag" }), "监听器必须 self-contain");
	// 畸形事件也不得抛
	assert.doesNotThrow(() => listener(undefined));
	assert.doesNotThrow(() => listener(null));
});

// provider 层的同样规则：宿主会 await `list` / `get`，rejection 也可能升级成
// fatal。上游（fs 扫描 / 宿主 registry snapshot）挂掉时必须降级而不是抛。
test("createFilterProvider：上游抛错时 list 返回空增量、get 返回 undefined，不抛", async () => {
	const broken = {
		async summaries() { throw new Error("scan exploded"); },
		async getDefinition() { throw new Error("registry exploded"); },
	};
	const p = createFilterProvider("s1", broken, new Set(["alpha"]));
	await assert.doesNotReject(async () => {
		assert.deepEqual(await p.list({ cwd: "C:/x" }), [], "list 必须降级为空增量");
		assert.equal(await p.get({ name: "alpha" }, {}), undefined, "get 必须降级为 undefined");
	});
});

test("createUpstreamAdapter：rootsScan / hostRegistry.snapshot 抛错时降级为可用的一部分", async () => {
	const explodingScan = () => { throw new Error("fs exploded"); };
	const explodingHost = { async snapshot() { throw new Error("snapshot exploded"); } };
	const a = createUpstreamAdapter({ rootsScan: explodingScan, hostRegistry: explodingHost });
	await assert.doesNotReject(async () => {
		assert.deepEqual(await a.summaries({ cwd: "C:/x" }), [], "两边都挂 → 空列表，但不抛");
	});

	// 只有 host 挂：仍要返回扫描到的技能
	const b = createUpstreamAdapter({
		rootsScan: () => [{ name: "local-skill", description: "d", source: "user" }],
		hostRegistry: explodingHost,
	});
	const got = await b.summaries({ cwd: "C:/x" });
	assert.deepEqual(got.map((s) => s.name), ["local-skill"], "host 挂掉不得连本地扫描一起丢");

	// 只有扫描挂：仍要返回 host 的技能
	const c = createUpstreamAdapter({
		rootsScan: explodingScan,
		hostRegistry: { async snapshot() { return { skills: [{ name: "host-skill" }] }; } },
	});
	assert.deepEqual((await c.summaries({ cwd: "C:/x" })).map((s) => s.name), ["host-skill"]);
});

// 用户报告的 bug（m02344）：**第一条消息不受控，第二条才受控**。
// 根因：`denied` 只在 `domain/changed`（写操作）里被填充；新对话第一轮列技能
// 时集合还是空的 → 模型看到全部技能。修复后 provider 在每次读之前自己保证新鲜，
// 首次 `list()` 就必须是正确口径，且刷新自身不得让 provider 抛错。
test("createFilterProvider：首次 list 前会先刷新拒绝集（新对话第一条消息就受控）", async () => {
	const denied = new Set(); // 初始为空，模拟"从没经历过 domain/changed"
	let calls = 0;
	const ensureFresh = async (options) => {
		calls++;
		// 真实实现就是在这个回调里重算并填充 denied
		if (options?.cwd === "C:/ws") denied.add("alpha");
	};
	const upstream = {
		async summaries() { return [{ name: "alpha" }, { name: "beta" }]; },
		async getDefinition(c) { return { name: c.name, description: "d" }; },
	};
	const p = createFilterProvider("s-new", upstream, denied, ensureFresh);

	const out = await p.list({ cwd: "C:/ws" });
	assert.equal(calls, 1, "首次 list 必须触发一次刷新");
	assert.deepEqual(out.map((s) => s.name), ["alpha"], "受控技能应被 deny-shadow 覆盖");
	assert.deepEqual(out[0].invocation, { modelInvocable: false, userInvocable: false }, "以 deny 影子（而非直接消失）呈现");

	// options 必须原样传下去 —— cwd 是刷新用的关键上下文
	await p.list({ cwd: "C:/ws" });
	assert.equal(calls, 2, "每次读都要保证新鲜（幂等，代价可控）");
});

test("createFilterProvider：ensureFresh 抛错时降级沿用旧集合，不得冒回宿主", async () => {
	const denied = new Set(["alpha"]);
	const p = createFilterProvider(
		"s", 
		{ async summaries() { return [{ name: "alpha" }, { name: "beta" }]; }, async getDefinition(c) { return { name: c.name }; } },
		denied,
		async () => { throw new Error("refresh exploded"); },
	);
	await assert.doesNotReject(async () => {
		const out = await p.list({});
		assert.deepEqual(out.map((s) => s.name), ["alpha"], "仍按旧集合过滤");
	});
	assert.doesNotThrow(() => p.get({ name: "alpha" }, {}) instanceof Promise);
});

test("createFilterProvider 不传 ensureFresh 时行为不变（向后兼容）", async () => {
	const denied = new Set(["alpha"]);
	const p = createFilterProvider(
		"s",
		{ async summaries() { return [{ name: "alpha" }]; }, async getDefinition() { return undefined; } },
		denied,
	);
	const out = await p.list({});
	assert.deepEqual(out.map((s) => s.name), ["alpha"]);
});

// 「第一条消息不受控」的第二半根因：宿主是在会话跑起来之后才把 sessionId
// 写进 workspace.sessionIds 的（entity.attachSession）。新 agent 第一次 list()
// 时那个 id 还不在里面 → 按 sessionIds 反查返回 null → 拿不到工作区 → 全部放行。
// 修法：在 sessionIds 之后加一档 cwd → workspace.path 兜底。
test("工作区解析顺序：sessionId 未 attach 时用 cwd 兜底（第一条消息也能纳管）", () => {
	const registry = {
		list: () => [
			// 该工作区还没 attach 这个会话（sessionIds 为空）——第一轮的真实形态
			{ id: "ws-path", path: "C:\\proj\\demo", sessionIds: [] },
			{ id: "ws-other", path: "C:\\proj\\other", sessionIds: ["sess-1"] },
		],
	};
	// 会话 sess-live 属于 C:\proj\demo，但 sessionIds 里没有它
	assert.equal(workspaceIdOfSession(registry, "sess-live"), null, "还没 attach → 按 id 查不到");
	assert.equal(
		workspaceIdOfPath(registry, "c:/proj/DEMO/"),
		"ws-path",
		"cwd 兜底必须命中（大小写/分隔符/尾斜杠不敏感）",
	);
});

// 「第一条消息不受控」的第三半根因（也是最隐蔽的一处）：
// 旧实现在算候选集时调 `conversations.candidates(convId, links)`，而该方法内部是
// `conversationEffectiveConfig(conversations.get(id))` —— 对话行不存在时直接
// `Cannot read properties of undefined (reading 'config')`。第一轮消息恰好没有
// 对话行，异常被 refreshSession 的 catch 吞掉 → 拒绝集为空 → 全部技能放行。
// 现在改为直接用「生效配置」算候选集，与对话行是否存在无关。
test("第一条消息：对话行尚不存在时仍能算出正确的拒绝集（端到端组合）", async () => {
	const { createMemoryRepository } = await import("../src/storage/repository.js");
	const { createServices } = await import("../src/service.js");
	const { workspaceDeniedSkills, activeTagsOf } = await import("../src/domain/workspace.js");
	const { candidatesFor } = await import("../src/domain/match.js");

	const repo = createMemoryRepository();
	const svc = createServices(repo, { log() {} });
	await svc.ready();

	// 工作区：只放行带 alpha-tag 的技能
	const tag = await svc.tags.create("t-alpha", "alpha-tag");
	await svc.tags.linkSkill("alpha", [tag.tagId]);
	await svc.workspaces.setExpression("ws-path", "alpha-tag");
	const ws = svc.workspaces.get("ws-path");
	assert.ok(ws.config.orTags.length > 0, "工作区条件应已编译成 config");

	// 关键前提：对话行**不存在**（第一轮的真实形态）
	assert.equal(svc.conversations.get("sess-first"), undefined);

	// 这正是 recomputeDenials 内部的两步
	const effective = {
		config: ws.config,
		manualSkills: ws.manualSkills ?? [],
		disabledSkills: ws.disabledSkills ?? [],
	};
	const links = [...svc._caches.skillLinks.values()];
	const candidates = candidatesFor({
		skillTagLinks: links,
		config: effective.config,
		active: activeTagsOf(effective.config),
	});
	assert.deepEqual(candidates, ["alpha"], "只有命中条件的技能成为候选");

	const denied = workspaceDeniedSkills({ ...effective, universe: ["alpha", "beta", "gamma"], candidates });
	assert.deepEqual([...denied].sort(), ["beta", "gamma"], "未命中的技能必须第一轮就被屏蔽");

	// 对照：旧路径（conversations.candidates）在这里确实会抛 —— 证明修复是必要的
	assert.throws(
		() => svc.conversations.candidates("sess-first", links),
		/Cannot read properties of undefined/,
		"旧实现依赖对话行，第一轮必然抛（所以第一轮不受控）",
	);
});

test("apply() 在最小 cordis 面上不抛（workspaceRegistry 未注入 / 无 agents）", async () => {
	// 只提供 inject 声明里的服务，registry 缺席 —— 崩溃时的真实形态
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		effect(fn) { const out = fn(); return typeof out === "function" ? out : () => {}; },
		on() {},
		get(name) { return undefined; },
		storageDomain: null,
		webServer: undefined,
		skills: null,
		agents: { list: () => [] },
	};
	await assert.doesNotReject(() => apply(ctx, {}), "插件加载不得因缺少可选服务而崩溃");
});


// ── 技能发现：与「模型实际看到的技能目录」对齐 ──────────────────────────────
//
// 用户报告（m03128）：空标签对话里模型能看到 78 条 skill，而本插件只探到 39 条。
// 根因：插件原先只用 scanSkillRoots 扫文件系统根，而 aegis / mattpocock / archify
// 这类插件的技能**根本不在任何文件系统根里**，它们由插件自带的 provider 直接
// 注册进 ctx.skills。模型侧 dsh-tool-skill 用的是
//   ctx.skills.snapshot({ cwd, signal, scope: agent })
// ——关键在 `scope`：宿主按 scope 决定合并哪些层。
const { createSkillDiscoverer } = await import("../lib/index.js");

test("createSkillDiscoverer：宿主注册表的技能优先，插件 provider 贡献的技能必须出现", async () => {
	const hostRegistry = {
		async snapshot(options) {
			snapshotCalls.push(options);
			return {
				skills: [
					{ name: "using-aegis", path: "C:/nm/aegis/skills/using-aegis/SKILL.md", source: "bundled", description: "a" },
					{ name: "archify", path: "C:/nm/archify/skills/archify/SKILL.md", source: "bundled", description: "b" },
					{ name: "alpha", path: "C:/home/.dsh/skills/alpha/SKILL.md", source: "user-dsh", description: "c" },
				],
				complete: true,
			};
		},
	};
	const snapshotCalls = [];
	const discover = createSkillDiscoverer({
		hostRegistry,
		rootsScan: () => [{ name: "alpha", path: "C:/home/.dsh/skills/alpha/SKILL.md", source: "user-dsh" }],
		agents: null,
	});
	const out = await discover("/work/dir");
	const names = out.map((s) => s.name).sort();
	assert.deepEqual(names, ["alpha", "archify", "using-aegis"], "扫盘看不到的 provider 技能必须出现");
	// 同名以宿主为准：宿主那份才是模型真正会加载的定义
	const alpha = out.find((s) => s.name === "alpha");
	assert.equal(alpha.description, "c", "同名时宿主结果覆盖自扫描结果");
	assert.equal(snapshotCalls.length, 1);
	assert.equal(snapshotCalls[0].cwd, "/work/dir", "cwd 必须透传才能扫到项目级技能");
});

test("createSkillDiscoverer：给了 conversationId 就把对应 agent 作为 scope 传给宿主", async () => {
	const calls = [];
	const agent = { session: { id: "sess-1" } };
	const hostRegistry = {
		async snapshot(options) { calls.push(options); return { skills: [], complete: true }; },
	};
	const discover = createSkillDiscoverer({
		hostRegistry,
		rootsScan: () => [{ name: "beta" }],
		agents: { list: () => [agent] },
	});
	await discover("/w", { conversationId: "sess-1" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].scope, agent, "scope 必须是那个会话的 agent —— 否则看不到该会话真实可见的技能");

	// 换个不存在的会话 → 找不到 agent → 不带 scope（不能传 undefined 把缓存键搞坏）
	await discover("/w", { conversationId: "nope" });
	assert.equal("scope" in calls[1], false, "找不到 agent 时不得塞 undefined scope");
});

test("createSkillDiscoverer：宿主不可用 / 抛错时退回自扫描，绝不外泄异常", async () => {
	const boom = createSkillDiscoverer({
		hostRegistry: { async snapshot() { throw new Error("registry down"); } },
		rootsScan: () => [{ name: "gamma" }],
	});
	assert.deepEqual((await boom()).map((s) => s.name), ["gamma"], "宿主挂了仍要能用");

	const none = createSkillDiscoverer({ hostRegistry: null, rootsScan: () => [{ name: "delta" }] });
	assert.deepEqual((await none()).map((s) => s.name), ["delta"]);

	// 宿主回调里抛异常 = host fatal，所以这里也必须吞掉
	const badScan = createSkillDiscoverer({ hostRegistry: null, rootsScan: () => { throw new Error("EACCES"); } });
	assert.deepEqual(await badScan(), []);
});

test("createUpstreamAdapter：scope 必须透传给宿主 snapshot（否则漏掉 preset/plugin 层技能）", async () => {
	const calls = [];
	const upstream = createUpstreamAdapter({
		hostRegistry: { async snapshot(o) { calls.push(o); return { skills: [{ name: "x" }], complete: true }; } },
		rootsScan: () => [{ name: "y" }],
	});
	await upstream.summaries({ cwd: "/w", scope: { id: "agent-1" }, signal: "S" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].scope.id, "agent-1", "不带 scope 就只剩 global 层 → 漏技能");
	assert.equal(calls[0].signal, "S");

	// 嵌套重入保护：宿主在收集本插件自己的 provider 时若回调进来，必须跳过宿主快照，
	// 否则 snapshot → list() → freshen() → summaries() → snapshot 无限递归。
	let nested = 0;
	const recursive = createUpstreamAdapter({
		hostRegistry: {
			async snapshot() {
				nested += 1;
				// 模拟宿主在收集过程中回调进 summaries（provider.list 触发 freshen）
				if (nested === 1) await recursive.summaries({});
				return { skills: [{ name: "z" }], complete: true };
			},
		},
		rootsScan: () => [{ name: "w" }],
	});
	const out = await recursive.summaries({});
	assert.ok(out.some((s) => s.name === "w"), "嵌套时退回自扫描，结果仍可用");
	assert.equal(nested, 1, "嵌套那一轮必须跳过宿主快照：snapshot→list→freshen→snapshot 会无限递归");
});

test("两个出口必须共用一份重入计数器：设置页快照 → 我们的 provider → 否认路径再快照", async () => {
	// 真实形态：设置页带 scope 问宿主 → 宿主收集到本插件的 per-agent provider →
	// provider.list() 走 freshen → recomputeDenials → upstream.summaries() 又要
	// 问宿主。这一圈跨 createSkillDiscoverer 与 createUpstreamAdapter 两个工厂，
	// 各自一个计数器就互相看不见，会一路 snapshot→list→freshen→snapshot 递归到爆栈。
	const guard = { depth: 0 };
	let snapshots = 0;
	const hostRegistry = {
		async snapshot() {
			snapshots += 1;
			if (snapshots === 1) await upstream.summaries({});
			return { skills: [{ name: "host-skill" }], complete: true };
		},
	};
	const discover = createSkillDiscoverer({ hostRegistry, rootsScan: () => [{ name: "scan-skill" }], guard });
	const upstream = createUpstreamAdapter({ hostRegistry, rootsScan: () => [{ name: "scan-skill" }], guard });

	const out = await discover("/w");
	assert.equal(snapshots, 1, "否认路径那一圈必须被同一个计数器挡住，不得再开一次宿主快照");
	assert.ok(out.some((s) => s.name === "host-skill"), "外层仍要拿到宿主的技能");
	assert.ok(out.some((s) => s.name === "scan-skill"), "外层补缺的自扫描结果仍在");
	assert.equal(guard.depth, 0, "计数器必须归零，否则第一次之后再也不问宿主了");
});
