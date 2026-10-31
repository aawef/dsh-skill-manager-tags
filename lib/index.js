// skill-tag-plugin — DSH plugin entry (wiring layer)
//
// Composition: dsh-storage-domain persistence → services → per-agent filter
// provider (proto's proven deny-shadow pattern, 8 tests) → invalidate on change.
//
// Runtime facts this relies on (all source-verified, see docs/technical-discovery.md
// and docs/proto-findings.md):
//  - registerProvider files into the layer of scopeOf(registry-construction ctx);
//    per-agent registration on agent.ctx.get('skills') shadows upstream names
//    whole (nearest layer wins, rank is intra-layer).
//  - deny-shadow candidates (modelInvocable:false + userInvocable:false + stub get)
//    constrain the catalog, the `skill` tool AND the `/name` gesture at once.
//  - control.invalidate() refreshes the next snapshot and emits 'skills/change'.
//  - storage domains are opened via ctx.storageDomain.open(skillTagDomain) and
//    must be closed by the owner — we wire ctx.effect(() => () => domain.close()).

import { skillTagDomain } from "../src/storage/schema.js";
import { createDshRepository, serializeConversation, deserializeConversation } from "../src/storage/repository.js";
import { createServices } from "../src/service.js";
import { groupIdOf } from "../src/domain/model.js";
import { workspaceDeniedSkills, workspaceSkillView, normalizeWorkspacePath, activeTagsOf } from "../src/domain/workspace.js";
import { candidatesFor } from "../src/domain/match.js";
import { mountApi } from "../src/api.js";
import { scanSkillRoots } from "../src/skill-scan.js";
import { loadBundledSkill } from "../src/skill-doc.js";

const PROVIDER_NAME = "skill-tag";
/** 影子候选的 source（宿主要求是字符串，且只用于展示/排序以外的标识）。 */
const PROVIDER_SOURCE = "skill-tag";

const ON = { modelInvocable: true, userInvocable: true };
const DENY = { modelInvocable: false, userInvocable: false };

/**
 * 宿主对 provider 返回的候选是**强校验**的（@deepseek-ai/dsh-skill validateCandidate）：
 *   name 必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/、description 非空字符串、
 *   source 字符串、rank 有限数、provider 必须等于本 provider 的名字、
 *   invocation 必须是对象且两个字段都是 boolean。
 * 任一候选不合法 → **整个 provider.list() 抛错** → 宿主把本插件的贡献整段丢弃
 * （日志："skill provider ... skipped"）→ 一个影子都不发，全部技能漏网。
 * 所以「凭空造影子」时必须先过这一关，脏名字宁可丢掉也不能让它炸掉整批。
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isSkillName(name) {
	return typeof name === "string" && SKILL_NAME_RE.test(name);
}

/**
 * 影子在**同一层内**的排序键（compareIndexedCandidates：rank 升序，小的先胜）。
 * 取 0 而不是沿用上游 rank 的原因：宿主只在层内按 rank 去重，跨层是"近层整条覆盖"。
 * 如果影子照抄上游 rank（office 是 BUNDLED_SKILL_RANK=600），同层里若有别的
 * provider 用更小的 rank 提供同名候选（RUNTIME_RANK=250 一类的 agent 层 provider），
 * 影子会被那条候选顶掉 —— 屏蔽随即失效。0 保证层内必胜。
 */
const SHADOW_RANK = 0;

/**
 * Build the per-agent filter provider over a session's policy snapshot.
 * Mirrors proto/lib/index.js createFilterProvider: emits deny-shadows ONLY —
 * allowed skills are supplied by upstream layers; a denied name is re-emitted
 * with DENY invocation from the nearest (agent) layer, shadowing the upstream
 * candidate whole.
 *
 * @param {string} sessionId
 * @param {{summaries:(o:any)=>Promise<any[]>, getDefinition:(c:any,o:any)=>Promise<any>}} upstream
 * @param {Set<string>} denied  denied skill names for this session (live set)
 * @param {((options:any)=>Promise<void>)|undefined} [ensureFresh]
 *   Lazily (re)compute `denied` right before it is consulted.
 * @param {((msg:string)=>void)|undefined} [logWarn]  观测出口（方案 C），可缺省。
 *
 *   为什么必须有它（2026-10-20 bug）：`denied` 原先只在 `domain/changed`
 *   事件里被填充，而那个事件由**写操作**触发。新对话第一次列技能时没有任何
 *   写操作发生过 → 集合是空的 → 模型看到全部技能；直到第二轮出现了
 *   `domain/changed` 才开始过滤。用户看到的就是"第一条消息不受控，第二条才受控"。
 *   把刷新挂到 provider 的读路径上，第一次 `list()` 就已经是正确口径。
 */
export function createFilterProvider(sessionId, upstream, denied, ensureFresh, logWarn) {
	async function freshen(options) {
		if (typeof ensureFresh !== "function") return;
		// 这里抛错只会让本次降级为"沿用旧集合"，绝不冒回宿主。
		try { await ensureFresh(options ?? {}); } catch { /* best-effort */ }
	}
	return {
		name: PROVIDER_NAME,
		async list(options) {
			await freshen(options);
			// 宿主会 await 这里；抛出的 rejection 同样可能升级成 fatal。屏蔽技能
			// 是"锦上添花"，上游扫不动时也不能什么都不发（那样等于全部放行）。
			let summaries = [];
			try {
				const got = await upstream.summaries(options);
				if (Array.isArray(got)) summaries = got;
			} catch { summaries = []; }

			// ── 第一段：看得见的技能，照抄它的元信息做影子 ────────────────────
			// 为什么要照抄：宿主 catalog 里这个条目的 description / path / whenToUse
			// 还是上游那份，影子只换掉 invocation 与 provider，右列能看出"它被屏蔽了"。
			const shadows = [];
			const emitted = new Set();
			for (const summary of summaries) {
				if (!summary || !denied.has(summary.name)) continue;
				shadows.push({
					...summary,
					provider: PROVIDER_NAME,
					source: typeof summary.source === "string" && summary.source !== "" ? summary.source : PROVIDER_SOURCE,
					description: "[blocked by skill-tag] " + (summary.description || summary.name),
					invocation: DENY,
					rank: SHADOW_RANK,
				});
				emitted.add(summary.name);
			}

			// ── 第二段：denied 里但这一趟看不见的名字（本 bug 的根因补丁）──────
			// 2026-10-22：原实现只遍历 summaries，于是"发射范围 = 本次能看到的
			// summary"。当重入守卫被占住（另一个 snapshot 在飞）时宿主快照被整段
			// 跳过，summaries 只剩扫盘结果 → 由别的 provider / npm 包 / 运行时送进来
			// 的技能（aegis / mattpocock / archify / office / tagging-skills）
			// 一条影子都没有，原样漏给模型（线上实测 17 个）。
			// 修法：屏蔽是**按名字**生效的，不需要知道那名字长什么样 —— 看不见的
			// 名字直接造一条最小合法候选，就能在近层整条覆盖上游那份。
			let backfilled = 0;
			const invalid = [];
			for (const name of denied) {
				if (emitted.has(name)) continue;
				if (!isSkillName(name)) { invalid.push(name); continue; }
				shadows.push({
					name,
					description: `[blocked by skill-tag] ${name}`,
					provider: PROVIDER_NAME,
					source: PROVIDER_SOURCE,
					rank: SHADOW_RANK,
					invocation: DENY,
				});
				emitted.add(name);
				backfilled += 1;
			}
			// 方案 C：把这一趟的口径暴露出来。只在"确实发生了补发"或"有脏名字被
			// 丢掉"时出声，健康路径一条日志都不写。
			if (typeof logWarn === "function") {
				try {
					if (backfilled > 0) {
						logWarn(`[skill-tag] shadow backfill session=${sessionId}`
							+ ` visible=${summaries.length} denied=${denied.size}`
							+ ` shadowed=${emitted.size} backfilled=${backfilled}`
							+ `${upstream.lastDegraded === true ? " hostSnapshot=skipped(nested)" : ""}`);
					}
					if (invalid.length > 0) {
						logWarn(`[skill-tag] denied names skipped (not kebab-case): ${invalid.slice(0, 8).join(", ")}`);
					}
				} catch { /* 观测不得影响主路径 */ }
			}
			return shadows;
		},
		async get(candidate, options) {
			await freshen(options);
			// 被屏蔽的名字：**绝不**再回问宿主。
			//
			// 2026-10-22 实测的坑：宿主 registry.get(name) 的流程是
			//   collect() → 选中胜出候选（在我们的 agent 层里就是这条影子）
			//   → 调**影子自己的** provider.get(candidate)
			// 而我们原先在这里调用 upstream.getDefinition → hostRegistry.get(name)
			// → 又选中影子 → 又是我们 → registry.get 被无限反复调用。
			// 一轮 `/<被屏蔽的技能名>` 就能撞上：dsh-tool-skill 的 agent/pre-step
			// 对 `/name` 手势是**先 get 再判 invocation**（lib 内 line 909），
			// 所以这条路真实可达，后果是 pre-step 永不 resolve（界面卡住）。
			//
			// 影子本来就没有正文可给（DENY + content:""），直接造定义即可；
			// 形状必须满足宿主 validateDefinition：name/description/source/provider
			// 非空字符串、invocation 是对象、content 是字符串。
			if (denied.has(candidate.name)) {
				return {
					name: candidate.name,
					description: `[blocked by skill-tag] ${candidate.description || candidate.name}`,
					provider: PROVIDER_NAME,
					source: PROVIDER_SOURCE,
					invocation: DENY,
					content: "",
				};
			}
			try {
				return await upstream.getDefinition(candidate, options);
			} catch {
				return undefined;
			}
		},
	};
}

/**
 * Upstream adapter: merges the host-plane registry snapshot with the
 * project/user skill roots scan (host plane can't see preset-layer providers —
 * discovery §5.4/skill-explorer pattern). getDefinition delegates to the host
 * registry first; the agent-scoped registry would also answer, but the stub is
 * intentionally shallow (deny path replaces content anyway).
 */
export function createUpstreamAdapter({ rootsScan, hostRegistry, guard = { depth: 0 } }) {
	/**
	 * 重入保护：本函数可能被**宿主在收集本插件自己那个 provider 的过程中**调用
	 * （provider.list() → freshen() → summaries() → hostRegistry.snapshot()）。
	 * 一旦把 `scope` 带上，snapshot 会把 agent 层（也就是我们自己的 provider）
	 * 重新收集一遍 → 再次 list() → 再次 summaries() → 无限递归。
	 * 所以嵌套时直接跳过宿主快照，只用自扫描（fs 扫描无重入）。
	 *
	 * 2026-10-22 修正：**不要再和 createSkillDiscoverer 共用一个计数器**。
	 * 共用的后果是设置页那条读路径把计数器占住时，模型侧的否认路径也被迫降级
	 * 成"只看得见扫盘结果"，于是包带来的技能全部漏网（线上 17 个）。
	 * 递归那圈本来就只在 adapter 自己内部（snapshot → 宿主 collect → 本 provider
	 * 的 list → freshen → 本 adapter 的 summaries），一份 adapter 自己的计数器
	 * 就足以截断，discoverer 的计数器与它无关。
	 */
	const nesting = guard;
	/** 本 adapter 最近一次 summaries() 是否跳过了宿主快照（只做观测用）。 */
	let lastDegraded = false;
	return {
		get lastDegraded() { return lastDegraded; },
		async summaries(options) {
			const opts = options ?? {};
			lastDegraded = false;
			// 三段都可能抛（fs 权限、宿主 registry 未就绪、signal aborted）。
			// 调用方是宿主的 provider 链，这里降级成"只看到能看到的那些"。
			let scanned = [];
			try { scanned = rootsScan ? rootsScan(opts) ?? [] : []; } catch { scanned = []; }
			let snapSkills = [];
			if (hostRegistry && nesting.depth === 0) {
				try {
					nesting.depth += 1;
					// scope 必须透传：宿主按 scope 决定合并哪些层，不带 scope 只能
					// 看到 global 层 → 漏掉 preset / 插件 provider 贡献的技能
					// （aegis / mattpocock / archify，本机共 49 个）。
					const snap = await hostRegistry.snapshot({
						...(opts.cwd ? { cwd: opts.cwd } : {}),
						...(opts.signal ? { signal: opts.signal } : {}),
						...(opts.scope ? { scope: opts.scope } : {}),
					});
					snapSkills = Array.isArray(snap?.skills) ? snap.skills : [];
				} catch { snapSkills = []; } finally { nesting.depth -= 1; }
			} else if (hostRegistry) {
				// 有宿主但被嵌套挡住 —— 这一趟只看得到扫盘结果。调用方（provider.list）
				// 会靠 denied 集合把看不见的名字补成影子，这里留个痕迹便于排查。
				lastDegraded = true;
			}
			const byName = new Map();
			for (const s of snapSkills) if (s?.name) byName.set(s.name, s);
			for (const s of scanned) if (s?.name && !byName.has(s.name)) byName.set(s.name, s);
			return [...byName.values()];
		},
		async getDefinition(candidate, options) {
			if (hostRegistry) {
				try {
					return await hostRegistry.get(candidate.name, options);
				} catch { /* fall through */ }
			}
			return undefined;
		},
	};
}

function sessionIdOfAgent(agent) {
	if (typeof agent.session?.id === "string") return agent.session.id;
	if (typeof agent.session?.header?.id === "string") return agent.session.header.id;
	return typeof agent.id === "string" && agent.id !== "" ? agent.id : undefined;
}

/**
 * Compute one session's denied skill ids from the workspace filter config
 * (§11). Pure decision — exported for tests.
 *
 * 需求④: 未打任何标签的对话(工作区筛选配置为空)可以看到所有 skill —
 * an empty boolean config matches nothing, so naive denial would block
 * EVERY linked skill; treat it as "no filter" instead.
 *
 * 说明：这是「管理标签」双列界面之前的旧口径（只看标签条件）。运行时实际用的是
 * workspaceDeniedSkills（src/domain/workspace.js），它额外考虑手动添加与禁用。
 * 保留本函数是为了兼容既有测试与调用方。
 *
 * @param {{orTags: string[], andGroups: {groupId:string, tagIds:string[]}[]}|undefined|null} wsConfig
 * @param {string[]} allLinkedSkillIds  every skill that has a tag link
 * @param {() => string[]} computeCandidates  lazy — only called when a filter exists
 * @returns {Set<string>}
 */
export function computeDeniedSkillIds(wsConfig, allLinkedSkillIds, computeCandidates) {
	const cfg = wsConfig ?? { orTags: [], andGroups: [] };
	const hasFilter = cfg.orTags.length > 0 || cfg.andGroups.length > 0;
	if (!hasFilter) return new Set();
	const candidates = new Set(computeCandidates());
	const denied = new Set();
	for (const skillId of allLinkedSkillIds) {
		if (!candidates.has(skillId)) denied.add(skillId);
	}
	return denied;
}

/**
 * 运行时生效口径：这个会话到底按哪份配置筛技能？
 *
 *   own 存在 → 用它（「对话 → 管理标签」的独立配置，已冻结）
 *   own 为空 → **空配置 = 掌握全部技能**，绝不回退到工作区实时配置
 *
 * ## 为什么不再回退工作区（2026-10-31 起的统一口径）
 *
 * 旧实现是 `pick(own) ?? pick(ws)`：own 为 null 的对话会实时跟着工作区走。
 * 而 own 只有「打开过管理标签」或「点过继承」才会产生，于是同一个操作
 * "改工作区标签"在不同对话上表现完全不同：
 *
 *   - 有 own（历史点开过）→ 冻结，不变；
 *   - 无 own（从没点开过）→ 实时跟随，跟着改 ← 用户报告的 bug。
 *
 * 用户口径（三种对话）：
 *   ① 插件安装前就存在        → 未配置过 = 空 = 全部技能，改工作区不影响
 *   ② 刚创建的新对话          → 出生时继承一次工作区（own 被写入）
 *   ③ 安装后创建、已存在一阵  → ②的 own 已冻结，工作区再改不影响
 *
 * 三者共同点：**own 一旦存在即权威；own 为 null 即"没有筛选"**。
 * 工作区配置退化为「新建对话的初始模板 + 继承按钮的数据源」，不再实时下发。
 *
 * @param {{config?:object, manualSkills?:string[], disabledSkills?:string[]}|null} own
 * @param {object|null} [_ws] 已废弃，仅为兼容既有调用签名；**不再参与计算**
 * @returns {{config:object, manualSkills:string[], disabledSkills:string[]}}
 */
export function effectiveSkillsConfig(own, _ws = null) {
	if (!own) {
		// 未配置过 → 空条件 → 全部技能（workspaceSkillView 对空 config 返回 universe）
		return { config: { orTags: [], andGroups: [] }, manualSkills: [], disabledSkills: [] };
	}
	return {
		config: own.config ?? { orTags: [], andGroups: [] },
		manualSkills: own.manualSkills ?? [],
		disabledSkills: own.disabledSkills ?? [],
	};
}

/**
 * 运行时口径：该工作区应被 deny-shadow 的技能名。
 *   visible = (有条件 ? 标签命中 : 全部技能) ∪ 手动添加 − 禁用
 *   denied  = 全部技能 − visible  (+ 禁用的)
 * 未被标签规则覆盖、也未被手动添加的技能在「有条件」时被排除（用户确认的严格子集）。
 *
 * @param {object} ws  workspace record
 * @param {string[]} universe  discoverable skill names for this session
 * @param {string[]} candidates  tag-rule hits
 * @returns {Set<string>}
 */
export function runtimeDeniedSkills(ws, universe, candidates) {
	if (!ws) return new Set();
	return workspaceDeniedSkills({
		config: ws.config ?? { orTags: [], andGroups: [] },
		manualSkills: ws.manualSkills ?? [],
		disabledSkills: ws.disabledSkills ?? [],
		universe,
		candidates,
	});
}

/**
 * 运行时真正下发给 provider 的拒绝集：新口径 ∪ 旧口径兜底的**严格补集**。
 *
 * 2026-10-27 修正的 bug：此前调用方把两段结果**无条件并集**——
 *   ① workspaceDeniedSkills（懂 manualSkills / disabledSkills）
 *   ② computeDeniedSkillIds（只看标签条件，linked − candidates）
 * ② 不知道"手动添加"，于是把「打了标签、但没被标签规则命中、靠手动加进对话」
 * 的技能重新判成 deny，推翻 ① 的放行结论。本机唯一受害者是 tagging-skills
 * （它只挂来源标签，靠「管理标签」右列手动添加）。
 *
 * 兜底原本的前提是「universe 扫不到这个名字，所以新口径没机会判定它」。
 * 那就把这个前提写成代码 —— 两道闸：
 *   ① 新口径已放行的名字（标签命中 ∪ 手动添加 − 禁用）绝不再 deny；
 *   ② universe 里存在的名字已由新口径给出判定，兜底不重复表态。
 * 剩下的才是真正需要兜底的历史残留（已卸载但标签还在的名字）。
 *
 * @param {{config?:object, manualSkills?:string[], disabledSkills?:string[]}} effective 生效配置
 * @param {object} p
 * @param {string[]} p.universe       本趟可发现的全部技能名
 * @param {string[]} p.candidates     标签规则命中的技能名
 * @param {string[]} p.linkedSkillIds 有标签关联的全部技能名（兜底段的输入）
 * @returns {Set<string>}
 */
export function computeRuntimeDeniedSkillIds(effective, { universe, candidates, linkedSkillIds }) {
	const view = workspaceSkillView({
		config: effective?.config,
		manualSkills: effective?.manualSkills,
		disabledSkills: effective?.disabledSkills,
		universe,
		candidates,
	});
	const denied = workspaceDeniedSkills({
		config: effective?.config,
		manualSkills: effective?.manualSkills,
		disabledSkills: effective?.disabledSkills,
		universe,
		candidates,
	});
	const allowed = new Set(view.visible);
	const inUniverse = new Set(universe);
	for (const skillId of computeDeniedSkillIds(effective?.config, linkedSkillIds, () => candidates)) {
		if (allowed.has(skillId)) continue;
		if (inUniverse.has(skillId)) continue;
		denied.add(skillId);
	}
	return denied;
}

/**
 * 技能发现：与「模型实际看到的技能目录」对齐的唯一入口。
 *
 * 为什么必须有它（2026-10-21）：插件原先只用 `scanSkillRoots` 扫文件系统根，
 * 而宿主有相当一部分技能**根本不在任何文件系统根里** —— 它们由插件自带的
 * provider 直接注册进 `ctx.skills`（本机实测：aegis 23 个、mattpocock 25 个、
 * archify 1 个，全部落在 node_modules 包内）。靠扫盘永远看不到它们，于是
 * 「模型看到 78 条，插件只探到 39 条」。
 *
 * 模型侧的口径（dsh-tool-skill 的 agent/pre-step，原文）：
 *   ctx.skills.snapshot({ cwd, signal, scope: agent }).skills.filter(isModelInvocable)
 * ——关键在 `scope: agent`：宿主按 scope 决定合并哪些层，preset/agent 层的
 * provider 贡献只有带 scope 才看得到。
 *
 * 所以这里：
 *   1. 先问宿主注册表（带 scope，能带就带）→ 这是权威
 *   2. 自扫描只补宿主没有的名字（宿主 registry 不可用、或设置页没有 agent scope）
 * 同名以**宿主为准**：宿主那份才是模型真正会加载的定义。
 *
 * @param {object} p
 * @param {object|null} p.hostRegistry  ctx.skills
 * @param {(o:any)=>object[]|null} [p.rootsScan]  scanSkillRoots 之类
 * @param {object|null} [p.agents]  ctx.get("agents")，用来把 conversationId 解析成 agent scope
 * @returns {(cwd?: string, hint?: {conversationId?:string, workspaceId?:string}) => Promise<object[]>}
 */
export function createSkillDiscoverer({ hostRegistry, rootsScan, agents = null, guard = { depth: 0 } }) {
	const nesting = guard;
	/** 同 key 的并发请求合并成一次宿主快照（设置页刚打开时一次会打好几个接口）。 */
	const inFlight = new Map();
	/** conversationId（= sessionId）→ agent，用来取宿主 snapshot 的 scope。 */
	function agentFor(conversationId) {
		if (!conversationId || !agents || typeof agents.list !== "function") return null;
		let list = [];
		try { list = agents.list() ?? []; } catch { return null; }
		return list.find((a) => sessionIdOfAgent(a) === conversationId) ?? null;
	}
	/**
	 * 问一次宿主，拿它的 skills。
	 * @returns {Promise<object[]|null>} null = 这一趟没问成（守卫被占 / 宿主抛错 / 未就绪）
	 */
	function snapshotSkills(cwd, hint, key) {
		const pending = (async () => {
			if (!hostRegistry || typeof hostRegistry.snapshot !== "function") return null;
			if (nesting.depth > 0) return null;
			nesting.depth += 1;
			try {
				const scope = agentFor(hint?.conversationId);
				const snap = await hostRegistry.snapshot({
					...(cwd ? { cwd } : {}),
					...(scope ? { scope } : {}),
				});
				return Array.isArray(snap?.skills) ? snap.skills : [];
			} catch {
				return null; // registry 未就绪 → 调用方退回自扫描
			} finally { nesting.depth -= 1; }
		})();
		inFlight.set(key, pending);
		void pending.then(
			() => { if (inFlight.get(key) === pending) inFlight.delete(key); },
			() => { if (inFlight.get(key) === pending) inFlight.delete(key); },
		);
		return pending;
	}
	return async function discoverSkills(cwd, hint) {
		const out = new Map();
		const put = (s) => {
			const name = typeof s === "string" ? s : s?.name;
			if (!name) return;
			out.set(name, {
				name,
				description: typeof s === "string" ? "" : (s?.description ?? ""),
				path: typeof s === "string" ? null : (s?.path ?? null),
				source: typeof s === "string" ? null : (s?.source ?? null),
			});
		};
		// 1) 宿主注册表（权威，与模型侧同源）
		const key = `${cwd ?? ""}::${hint?.conversationId ?? ""}`;
		const pending = inFlight.get(key) ?? snapshotSkills(cwd, hint, key);
		const hostSkills = await pending;
		if (Array.isArray(hostSkills)) for (const s of hostSkills) put(s);
		// 2) 自扫描补缺（不同名才补）
		if (rootsScan) {
			try {
				const scanned = rootsScan({ cwd }) ?? [];
				for (const s of scanned) {
					const name = typeof s === "string" ? s : s?.name;
					if (name && !out.has(name)) put(s);
				}
			} catch { /* 扫不动就算了 */ }
		}
		return [...out.values()];
	};
}

/**
 * 安全取宿主 workspaceRegistry。
 *
 * cordis 的服务是**声明式注入**的：没写进 `export const inject` 就直接
 * `ctx.workspaceRegistry` 会抛
 *   `cannot get property "workspaceRegistry" without inject`
 * ——这句会从 `domain/changed` 回调里冒到插件加载阶段，把整个 DSH 桌面进程
 * 打崩（2026-10-20 的 host crash 就是这么来的）。
 *
 * 所以一律走 `ctx.get(name)`（普通方法，拿不到返回 undefined），并且整体包一层
 * try/catch：宿主没装 workspace 服务（极简测试面、别的 profile）时返回 null，
 * 调用方退回对话自己的 `sourceWorkspaceId`。
 *
 * @param {object} ctx cordis context
 * @returns {object|null}
 */
export function getWorkspaceRegistry(ctx) {
	try {
		if (typeof ctx?.get === "function") {
			const svc = ctx.get("workspaceRegistry");
			if (svc) return svc;
		}
	} catch { /* 未注入或未装载 */ }
	return null;
}

/**
 * 会话 → 工作区 id 的解析（宿主 workspaceRegistry 是唯一权威来源）。
 *
 * 宿主把「哪个会话属于哪个工作区」记在 workspace entity 的 `sessionIds` 上
 * （dsh-workspace/lib/index.js：`get sessionIds()`），所以遍历 registry 的
 * list() 找包含该 sessionId 的那个即可。拿不到 registry（测试面/极简宿主）
 * 时返回 null，调用方退回对话自己记录的 sourceWorkspaceId。
 *
 * @param {object|undefined} registry  ctx.workspaceRegistry
 * @param {string} sessionId
 * @returns {string|null}
 */
export function workspaceIdOfSession(registry, sessionId) {
	if (!registry || typeof registry.list !== "function" || !sessionId) return null;
	let list = [];
	try { list = registry.list() ?? []; } catch { return null; }
	for (const w of list) {
		const ids = w?.sessionIds ?? [];
		if (Array.isArray(ids) && ids.includes(sessionId)) return w?.id ?? null;
	}
	return null;
}

/**
 * 会话 cwd → 工作区 id（registry 不可用时的路径兜底）。
 * @param {object|undefined} registry
 * @param {string|undefined} cwd
 * @returns {string|null}
 */
export function workspaceIdOfPath(registry, cwd) {
	if (!registry || typeof registry.list !== "function" || !cwd) return null;
	const want = normalizeWorkspacePath(cwd);
	if (want === "") return null;
	let list = [];
	try { list = registry.list() ?? []; } catch { return null; }
	for (const w of list) {
		if (normalizeWorkspacePath(w?.path) === want) return w?.id ?? null;
	}
	return null;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

const controls = new Set();

export const name = "dsh-skill-tag";

export const inject = ["skills", "agents", "storageDomain", "webServer"];

/**
 * @param {object} ctx  cordis context
 * @param {object} [config]  schemastery config
 *   - enabled: boolean (master switch, default true)
 *   - customSkillDirs: string[] (extra scan roots, default [])
 */
export async function apply(ctx, config) {
	const enabled = config?.enabled !== false;

	// 1. Persistence: open our storage domain; close on dispose (§12).
	let repo;
	if (ctx.storageDomain) {
		const domain = await ctx.storageDomain.open(skillTagDomain);
		// cordis effect semantics (cordis lib/index.js:1142): the thunk runs NOW and
		// its RETURNED function becomes the dispose hook — so return the closer,
		// never call it here. `() => domain.close()` would close the domain at setup.
		ctx.effect(() => () => domain.close());
		repo = createDshRepository(domain);
		ctx.logger?.info?.("[skill-tag] storage domain 'skill_tag' opened");
	} else {
		// host planes without storageDomain (unit tests, non-persistent runs)
		const { createMemoryRepository } = await import("../src/storage/repository.js");
		repo = createMemoryRepository();
		ctx.logger?.warn?.("[skill-tag] storageDomain service missing — running in-memory");
	}

	// 2. Services + load persisted state into caches.
	const services = createServices(repo, { log: (m) => ctx.logger?.info?.(m) });
	await services.ready();

	// 里程碑：本版**首次运行**的时刻。三种对话口径的判定基准（见 maybeSeedOwn）。
	// 幂等且永不覆盖：升级/重启不会把老对话误判成"新出生"。
	try {
		await services.meta.ensureInstalledAt();
	} catch (error) {
		ctx.logger?.warn?.(`[skill-tag] installed_at not recorded: ${error?.message ?? error}`);
	}

	// 3. Session→denied-skill-names live map. Denials derive from the boolean
	//    config + per-conversation four-zone state (§11). Recomputed on demand.
	const sessionDenials = new Map(); // sessionId -> Set<string>
	function deniedFor(sessionId) {
		let set = sessionDenials.get(sessionId);
		if (!set) { set = new Set(); sessionDenials.set(sessionId, set); }
		return set;
	}

	/**
	 * Recompute one session's candidate set and refresh its denial set +
	 * control.invalidate().
	 *
	 * 会话 ↔ 对话的绑定（2026-10 修正）：conversationId === sessionId。
	 * 之前用 `convId = cwd` 把"每个目录一个对话"当绑定，那只是早期设置页的
	 * 临时约定；「对话 → 管理标签」双列界面是按会话来的（会话行菜单里拿到
	 * 的就是 sessionId），所以必须以 sessionId 为主键，cwd 仅作旧数据兜底。
	 */
	async function refreshSession(agent) {
		// 整个函数是 best-effort：它从 `domain/changed` 里被 void 调用，任何
		// 抛出的异常都会变成 host 的 fatal load failure（2026-10-20 崩溃的形态）。
		// 屏蔽技能是"锦上添花"，绝不能因此打死桌面进程。
		try {
			await refreshSessionInner(agent);
		} catch (error) {
			try {
				ctx.logger?.warn?.(`[skill-tag] refreshSession failed: ${error?.message ?? error}`);
			} catch { /* logger 也挂了就算了 */ }
		}
	}

	async function refreshSessionInner(agent) {
		const sessionId = sessionIdOfAgent(agent);
		if (!sessionId) return;
		const cwd = agent.session?.header?.cwd ?? agent.session?.cwd;
		// scope 透传：agent 层才有的技能（skillhub / skills-manager 的 per-agent
		// provider）也必须进 universe，否则它们永远无法被禁用 —— 而那正是模型
		// 真正看得到的集合。重入由 createUpstreamAdapter 的 nesting 守卫挡住。
		await refreshBySession(sessionId, cwd, agent);
	}

	/**
	 * 按 sessionId 重算拒绝集。
	 *
	 * `cwd` 参数存在的理由：provider 的 `list(options)` 天生带着 `options.cwd`，
	 * 那是**读技能那一刻**的真实目录，比 agent.session.header.cwd 更可靠（新建
	 * agent 早期 header 可能还没填）。刷新挂到读路径上时用得上。
	 *
	 * `scope` 参数（= agent）：宿主按 scope 决定合并哪些层。不带它只能看到
	 * global 层 → agent 层独有的技能（skillhub / skills-manager 的 per-agent
	 * provider）既进不了 universe，也就永远无法被禁用。
	 *
	 * 重入保护：刷新完如果集合变了会 `control.invalidate()`，宿主随即重新调用
	 * `list()` → 又进 freshen。第二轮 before===after 不再 invalidate，自然收敛；
	 * `refreshing` 只是挡住同一 session 的并发重入，避免抖动。
	 * 嵌套 snapshot 由 createUpstreamAdapter 的 nesting 守卫挡住（provider.list
	 * → freshen → summaries → snapshot 会绕回本插件自己的 provider）。
	 */
	const refreshing = new Set();
	async function refreshBySession(sessionId, cwd, scope = null) {
		if (!sessionId) return;
		if (refreshing.has(sessionId)) return;
		refreshing.add(sessionId);
		try {
			// 先判「是不是新出生的对话」并播种（只写一次）；再算拒绝集。
			// 播种会写库 → 触发 domain/changed → 下一轮 recomputeDenials 用上 own。
			await maybeSeedOwn(sessionId, cwd, scope);
			await recomputeDenials(sessionId, cwd, scope);
		} finally {
			refreshing.delete(sessionId);
		}
	}


	/**
	 * 会话的创建时刻（毫秒）。宿主保证 session.header 恒存在且 createdAt 是
	 * 非负安全整数（dsh-session/lib/types 校验），所以读不到只可能是极早期
	 * 的空壳 agent —— 那种情况一律当作「看不了」，不播种（不写数据最安全）。
	 * @returns {number|null}
	 */
	function sessionCreatedAt(agent) {
		try {
			const v = agent?.session?.header?.createdAt;
			if (typeof v === "number" && Number.isFinite(v)) return v;
			if (typeof v === "string") {
				const t = Date.parse(v);
				if (Number.isFinite(t)) return t;
			}
		} catch { /* header 取不到就当未知 */ }
		return null;
	}

	/**
	 * 「出生播种」：**只在新对话的第一次被观察到时**继承一次工作区配置。
	 *
	 * 三种对话口径（2026-10-31 用户确认）都靠这一个函数落地：
	 *   ① 插件安装前就存在的对话 → createdAt < installed_at → 直接返回，
	 *      own 永远保持 null → 空条件 → 掌握全部技能；
	 *   ② 刚创建的新对话 → createdAt >= installed_at 且 own 为 null → 播种一次；
	 *   ③ 安装后创建、已存在一阵的对话 → 出生时已播过种，own 存在 → 永不重播。
	 *
	 * 为什么用 createdAt 而不是 agent/created 事件：宿主对**恢复**已有会话同样
	 * 发 agent/created（dsh-agent 的 announce(agent, startup) 是唯一路径），
	 * 事件本身区分不了「新建」和「打开旧对话」。用 header 里的出生时刻才可靠。
	 *
	 * 幂等：seedOwnOnBirth 内部再看一次 own，已有配置绝不覆盖。
	 */
	async function maybeSeedOwn(sessionId, cwd, scope) {
		if (!sessionId || !enabled) return;
		try {
			const installed = services.meta.installedAt();
			if (!installed) return; // 里程碑还没写（极早期），下一轮再说
			const bornAt = sessionCreatedAt(scope);
			if (bornAt === null) return;
			const installedMs = Date.parse(installed);
			if (!Number.isFinite(installedMs)) return;
			if (bornAt < installedMs) return; // ① 安装前就存在 → 永不播种
			if (services.conversations.isConfigured(sessionId)) return; // ③ 已冻结
			// 工作区解析：解析不到就先不写（留空 = 全部技能，语义与「没播」一致，
			// 而且不会把对话钉死）。宿主是在会话跑起来**之后**才 attachSession 的，
			// 出生瞬间常常还查不到，所以这里宁可等下一轮。
			const registry = getWorkspaceRegistry(ctx);
			const wsId = workspaceIdOfSession(registry, sessionId) ?? workspaceIdOfPath(registry, cwd) ?? null;
			if (!wsId) return;
			const seeded = await services.conversations.seedOwnOnBirth(sessionId, wsId);
			if (seeded) ctx.logger?.info?.(`[skill-tag] own seeded on birth session=${sessionId} workspace=${wsId}`);
		} catch (error) {
			try { ctx.logger?.warn?.(`[skill-tag] maybeSeedOwn failed: ${error?.message ?? error}`); } catch { /* ignore */ }
		}
	}

	async function recomputeDenials(sessionId, cwd, scope = null) {
		const denied = deniedFor(sessionId);
		const before = [...denied].join(",");
		denied.clear();
		if (enabled) {
			// 对话记录：sessionId 优先；老数据（按 cwd 建的行）兜底
			let convId = sessionId;
			let conv = services.conversations.get(convId);
			if (!conv && cwd && services.conversations.get(cwd)) {
				convId = cwd;
				conv = services.conversations.get(convId);
			}
			const own = conv?.own ?? null;
			// 生效口径（2026-10-31 统一）：**只看 own，永不回退到工作区实时配置**。
			//
			//   own 存在 → 该对话自己的冻结快照；
			//   own 为 null → 从未配置过 = 空条件 = 掌握全部技能。
			//
			// 工作区只在两个地方还参与：出生播种（maybeSeedOwn）与「继承」按钮。
			// 所以这里不再解析 ws，也不再需要 wsId。
			const effective = effectiveSkillsConfig(own);
			// 空配置 = 不筛 = denied 为空；仍然走一遍（禁用列表非空时还要生效）。
			if (effective) {
				let universe = [];
				try {
					universe = (await upstream.summaries({
						...(cwd ? { cwd } : {}),
						...(scope ? { scope } : {}),
					})).map((s) => s.name);
				} catch (e) {
					ctx.logger?.warn?.(`[skill-tag] skill discovery failed: ${e?.message ?? e}`);
				}
				const links = [...services._caches.skillLinks.values()];
				// 候选集直接按「生效配置」算，而不是绕 conversations.candidates()：
				//   ① 后者用的是对话四区配置（conv.config），不是 own/ws 的生效条件；
				//   ② 对话行还不存在时会 `conversationEffectiveConfig(undefined)`
				//      → TypeError（第一轮消息的真实形态，会被 refreshSession 的
				//      catch 吞掉，表现就是"第一条不受控"）。
				const candidates = candidatesFor({
					skillTagLinks: links,
					config: effective.config,
					active: activeTagsOf(effective.config),
				});
				// 当前生效配置下"该放行"的名字（标签命中 ∪ 手动添加 − 禁用）。
				// 兜底段必须尊重它，否则会把手动添加的技能重新判成 deny。
				for (const skillId of computeRuntimeDeniedSkillIds(effective, {
					universe,
					candidates,
					linkedSkillIds: links.map((l) => l.skillId),
				})) denied.add(skillId);
			}
		}
		const after = [...denied].join(",");
		if (before !== after) {
			for (const control of controls) {
				try { control.invalidate(); } catch { /* disposed */ }
			}
		}
	}


	// 4. Per-agent filter provider attach (skillhub/proto pattern).
	function attachFilterProvider(payload) {
		const agent = payload?.agent;
		if (!agent?.ctx) return;
		try {
			const skills = agent.ctx.get("skills");
			if (!skills || typeof skills.registerProvider !== "function") {
				ctx.logger?.warn?.("[skill-tag] agentCtx has no skills registry; skipping");
				return;
			}
			const sessionId = sessionIdOfAgent(agent);
			const denied = deniedFor(sessionId);
			// agent 侧的 cwd 兜底（provider options.cwd 优先，见 createFilterProvider）
			const agentCwd = agent.session?.header?.cwd ?? agent.session?.cwd;
			ctx.effect(() =>
				agent.ctx.effect(() =>
					skills.registerProvider((control) => {
						try {
							controls.add(control);
						} catch { /* 控制面已释放 */ }
						return createFilterProvider(sessionId, upstream, denied, async (options) => {
							// 读路径上按需刷新：新对话的第一次 list() 也必须已过滤，
							// 不能等下一次 domain/changed（那样第一条消息会漏）。
							// agent scope 照传：宿主这次 snapshot 会重新调用本 provider 的
							// list() → 再次进 freshen，但 `refreshing` 里有本 sessionId，
							// 第二趟直接返回，不会递归。
							await refreshBySession(sessionId, options?.cwd ?? agentCwd, agent);
						}, (message) => ctx.logger?.warn?.(message));
					}),
				),
			);
			ctx.logger?.info?.(`[skill-tag] attached per-agent provider, session=${sessionId}`);
		} catch (error) {
			ctx.logger?.error?.("[skill-tag] agent provider attach failed", error);
		}
	}

	// 两个出口（设置页的 discoverer 与否认路径的 upstream）问的是同一个
	// `ctx.skills`，但**重入计数器必须各用一份**。
	//
	// 2026-10-22 修正（此前是共用一份）：共用时，设置页那条读路径（或
	// skill-explorer / skills-manager 的 UI 快照、另一个 agent 的收集、并发刷新）
	// 只要有一个 snapshot 在飞，否认路径就被一起判成"嵌套" → 跳过宿主快照 →
	// 只看得见扫盘结果 → 由别的 provider / npm 包 / 运行时送进来的技能全部漏网。
	// 线上实测：34 个被屏蔽，17 个（aegis / mattpocock / archify / office /
	// tagging-skills）永远穿透，而且完全静默。
	//
	// 现在递归只可能发生在 adapter 自己内部（snapshot → 宿主 collect → 本 provider
	// 的 list → freshen → 本 adapter 的 summaries），一份 adapter 自己的计数器就够；
	// 而且 provider.list 在看不见时会按 denied 补齐影子，压根不依赖这次快照。
	const upstreamGuard = { depth: 0 };
	const discoverGuard = { depth: 0 };

	const upstream = createUpstreamAdapter({
		hostRegistry: ctx.skills ?? null,
		// rootsScan: host plane cannot see preset-layer providers; scan the
		// official skill roots ourselves (skill-explorer pattern, discovery §5.4).
		rootsScan: (options) => scanSkillRoots(options?.cwd, config?.customSkillDirs ?? []),
		guard: upstreamGuard,
	});

	ctx.effect(() => () => { controls.clear(); sessionDenials.clear(); });

	// 4b. 把「给技能打标签」这份手册注册成一个真实的 skill。
	// 别人装上本插件后，他们的 agent 在 /skills 里就能看到 `tagging-skills`，
	// 从而照着它给自己的技能打标签 —— 这是 m05073 要求的「可移植」落点：
	// 内容随插件走，不依赖本机任何硬编码名单。
	//
	// 整体 self-contain：register 抛错不能升级成 fatal（历史上两次崩溃都是
	// 监听器/注入路径抛异常冒到 cordis 顶层）。
	try {
		const registry = ctx.skills ?? null;
		if (registry && typeof registry.register === "function") {
			const def = await loadBundledSkill("tagging-skills");
			if (def) {
				ctx.effect(() => registry.register({
					...def,
					invocation: { modelInvocable: true, userInvocable: true },
				}));
				ctx.logger?.info?.("[skill-tag] registered bundled skill 'tagging-skills'");
			} else {
				ctx.logger?.warn?.("[skill-tag] skills/tagging-skills/SKILL.md missing or invalid");
			}
		} else {
			ctx.logger?.warn?.("[skill-tag] no skills registry — manual not registered as a skill");
		}
	} catch (error) {
		try {
			ctx.logger?.warn?.(`[skill-tag] bundled skill registration skipped: ${error?.message ?? error}`);
		} catch { /* logger 也挂了就算了 */ }
	}

	ctx.on("agent/created", attachFilterProvider);
	// attach to already-live agents (plugin reload mid-session)
	try {
		for (const agent of ctx.get("agents")?.list?.() ?? []) attachFilterProvider({ agent });
	} catch (error) {
		ctx.logger?.warn?.(`[skill-tag] live-agent attach skipped: ${error?.message ?? error}`);
	}

	// 5. Invalidation triggers: config/state changes recompute denials.
	//
	// 事件监听器是**宿主调用栈上的同步回调**：cordis 把监听器异常当 fatal，
	// 一路冒到 `Object.apply` / `dsh: fatal load failure` 把桌面进程打死
	// （2026-10-20 crash-...13-41-36 与 ...13-49-11 两次崩都是这条路径）。
	// 所以这里整体 self-contain：枚举 agent、取 agents 服务本身都可能抛。
	ctx.on("domain/changed", (change) => {
		try {
			if (change?.domain !== "skill_tag") return;
			for (const agent of ctx.get("agents")?.list?.() ?? []) {
				// refreshSession 自己已 async + try/catch，这里再包一层防同步抛出
				try { void refreshSession(agent); } catch { /* ignore */ }
			}
		} catch (error) {
			try {
				ctx.logger?.warn?.(`[skill-tag] domain/changed handler failed: ${error?.message ?? error}`);
			} catch { /* logger 也挂了就算了 */ }
		}
	});

	// 6. Settings-page API (host half of the UI; client half in lib/client.js).
	//    Guarded: test planes may lack webServer.
	if (ctx.webServer && typeof ctx.webServer.register === "function") {
		// listSkills(cwd): 技能发现。设置页没有 cwd → 只扫用户级根目录；
		// 「管理标签」浮层知道自己在哪个工作区/对话，于是传 cwd 把项目级技能也扫进来。
		mountApi(
			ctx,
			services,
			// 技能发现：宿主 ctx.skills 为准（与模型侧同源，能带上 preset/插件
			// provider 贡献的 aegis/mattpocock/archify 等），自扫描只补缺。
			// 详见 createSkillDiscoverer 的注释。
			createSkillDiscoverer({
				hostRegistry: ctx.skills ?? null,
				rootsScan: (options) => scanSkillRoots(options?.cwd ?? null, config?.customSkillDirs ?? []),
				agents: (() => { try { return ctx.get("agents") ?? null; } catch { return null; } })(),
				guard: discoverGuard,
			}),
			// 会话 → 工作区 id：宿主 workspaceRegistry 是权威来源
			(sessionId) => {
				const registry = getWorkspaceRegistry(ctx);
				const bySession = workspaceIdOfSession(registry, sessionId);
				if (bySession) return bySession;
				// 兜底：会话 cwd 与工作区 path 对上（registry 未装载时的降级）
				const agent = (ctx.get("agents")?.list?.() ?? []).find((a) => sessionIdOfAgent(a) === sessionId);
				const cwd = agent?.session?.header?.cwd ?? agent?.session?.cwd;
				return workspaceIdOfPath(registry, cwd);
			},
			// 工作区 id → 目录路径（把项目级技能根目录扫进右列）
			(workspaceId) => {
				const registry = getWorkspaceRegistry(ctx);
				const entity = registry?.get?.(workspaceId);
				return entity?.path ?? null;
			},
			// 工作区 id → 该工作区下的会话 id 列表（「一键下发」要知道发给谁）。
			// 宿主把归属记在 workspace entity 的 sessionIds 上（dsh-workspace）。
			(workspaceId) => {
				const registry = getWorkspaceRegistry(ctx);
				const entity = registry?.get?.(workspaceId);
				const ids = entity?.sessionIds;
				return Array.isArray(ids) ? [...ids] : [];
			},
		);
	} else {
		ctx.logger?.warn?.("[skill-tag] webServer missing — settings API not mounted");
	}

	ctx.logger?.info?.("[skill-tag] apply() complete", {
		enabled,
		tags: services.tags.list().length,
		conversations: services._caches.conversations.size,
	});
}

// ── Skill roots scan ─────────────────────────────────────────────────────────
// Moved to src/skill-scan.js (pure fs, unit-testable): recursive walk, CRLF-
// tolerant frontmatter, folded/literal block scalars, .disabled entries,
// directory-name fallback (mcp-panel semantics). lib/index.js previously
// dropped every skill whose SKILL.md used \r\n (22 skills on this machine).
