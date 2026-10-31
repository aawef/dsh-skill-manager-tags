// skill-tag-plugin — host-side HTTP API surface (settings-page backend)
//
// Sits on top of createServices; routes mirror the service layer 1:1.
// Mounted at /skill-tag/api (kind: 'prefix'). JSON only; errors as {ok:false}.
// GET+POST both accepted for reads (guide-slash-persistence: host route reads
// should not 404 on POST-only clients either way).

import { candidatesFor } from "./domain/match.js";
import { activeTagsOf } from "./domain/workspace.js";
import { revealInExplorer } from "./reveal.js";

/** 对外暴露的工作区形状（前端双列界面直接消费） */
function wsShape(ws) {
	return {
		workspaceId: ws.workspaceId,
		config: ws.config,
		expression: ws.expression ?? "",
		manualSkills: ws.manualSkills ?? [],
		disabledSkills: ws.disabledSkills ?? [],
	};
}

/** Build the route handler. `services` = createServices(repo) result.
 *
 * @param {object} services
 * @param {object} [log]
 * @param {((cwd?: string, hint?: {conversationId?: string|null, workspaceId?: string|null}) => object[] | Promise<object[]>) | null} [listSkills]
 *        技能发现。**可以是 async**：要问宿主的 skills 注册表才能拿到 preset /
 *        插件 provider 贡献的技能（它们不在任何文件系统根里）。
 * @param {((sessionId: string) => string|null) | null} [resolveWorkspaceId]
 *        会话 → 工作区 id 的解析器（宿主 workspaceRegistry）。为 null 时退回
 *        对话自己记录的 sourceWorkspaceId / inherited.workspaceId。
 * @param {((workspaceId: string) => string|null) | null} [resolveWorkspacePath]
 *        工作区 id → 目录路径（宿主 workspaceRegistry entity.path）。用于把
 *        项目级技能根目录扫进来；为 null 时只能用插件自己记录过的 path。
 */
export function createApiHandler(services, log, listSkills = null, resolveWorkspaceId = null, resolveWorkspacePath = null) {
	const json = (res, code, obj) => {
		res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(obj));
	};
	const readBody = (req) =>
		new Promise((resolve, reject) => {
			let data = "";
			req.on("data", (c) => {
				data += c;
				if (data.length > 1_000_000) reject(new Error("body too large"));
			});
			req.on("end", () => resolve(data));
			req.on("error", reject);
		});

	return async function handler(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname.replace(/^\/skill-tag\/api/, "") || "/";
		const method = req.method ?? "GET";
		let body = {};
		if (method === "POST" || method === "PUT") {
			try {
				const raw = await readBody(req);
				body = raw ? JSON.parse(raw) : {};
			} catch (e) {
				return json(res, 400, { ok: false, error: "bad json: " + e.message });
			}
		}
		const q = (k) => body[k] ?? url.searchParams.get(k);

	/**
	 * 右列所需的两个集合：
	 *   universe   = 本机可发现的全部技能名（scanSkillRoots 的结果）
	 *   candidates = 标签规则命中的技能名（条件里的标签全部视为生效）
	 * 二者都不含被禁用的技能——禁用在 workspaceSkillView 里统一扣减。
	 * 工作区与对话共用这一份实现（差别只在 config 的来源）。
	 *
	 * cwd：会话/工作区所属目录。传了才能扫到该项目的 .dsh/skills；
	 * 设置页没有 cwd，只能扫用户级根目录。
	 */
	async function contextForConfig(config, cwd = null, hint = null) {
		// listSkills 现在可能是 async：它要问宿主的 skills 注册表（与模型侧
		// `snapshot({scope:agent})` 同源），才能拿到 preset / 插件 provider 贡献的
		// 技能（aegis / mattpocock / archify 等根本不落在任何文件系统根里）。
		let listed = [];
		if (listSkills) {
			try {
				// 第二参 hint = {conversationId, workspaceId}：让宿主能按会话解析出
				// agent scope，从而拿到该会话真实可见的技能集合。
				listed = (await listSkills(cwd ?? undefined, hint ?? undefined)) ?? [];
			} catch {
				listed = [];
			}
		}
		const catalog = listed
			.map((s) => (typeof s === "string" ? { name: s, path: null, source: null } : { name: s?.name, path: s?.path ?? null, source: s?.source ?? null }))
			.filter((s) => Boolean(s.name));
		const universe = catalog.map((s) => s.name);
		const links = [...services._caches.skillLinks.values()];
		const candidates = candidatesFor({
			skillTagLinks: links,
			config: config ?? { orTags: [], andGroups: [] },
			active: activeTagsOf(config),
		});
		// catalog 让前端能把「打开技能文件夹」按钮直接接到 path（不必再扫一遍）
		return { universe, candidates, catalog };
	}
	async function skillContext(ws) {
		return contextForConfig(ws?.config, workspacePathOf(ws), {
			workspaceId: ws?.workspaceId ?? null,
			conversationId: null,
		});
	}

	/**
	 * 技能名 → SKILL.md 绝对路径。
	 * 技能名在扫描结果里是唯一的（scanSkillRoots 按 name 去重），所以这里
	 * 按名字查即可；查不到返回 null（关联记录可能是"幽灵技能"）。
	 */
	async function resolveSkillPath(skillName, cwd) {
		const name = String(skillName ?? "").trim();
		if (!name) return null;
		const all = (listSkills ? await listSkills(cwd ?? undefined) : []) ?? [];
		const hit = all.find((s) => (typeof s === "string" ? s : s?.name) === name);
		return (typeof hit === "string" ? null : hit?.path) ?? null;
	}

	/** 一个技能在 UI 上的完整形状：名字 + 文件路径 + 来源根目录。 */
	async function skillShape(skillName, cwd) {
		const name = String(skillName ?? "").trim();
		const all = (listSkills ? await listSkills(cwd ?? undefined) : []) ?? [];
		const hit = all.find((s) => (typeof s === "string" ? s : s?.name) === name);
		if (typeof hit === "string" || !hit) return { name, path: null, source: null };
		return { name: hit.name, path: hit.path ?? null, source: hit.source ?? null };
	}

	/** 工作区目录：优先宿主 registry（权威），其次插件自己记录的 path。 */
	function workspacePathOf(ws) {
		if (!ws) return null;
		if (typeof resolveWorkspacePath === "function" && ws.workspaceId) {
			try {
				const p = resolveWorkspacePath(ws.workspaceId);
				if (p) return p;
			} catch { /* registry 不可用 → 用记录值 */ }
		}
		return ws.path ?? null;
	}

	/** 对话自己的配置快照的对外形状（对话版双列界面直接消费） */
	function convShape(conversationId) {
		const o = services.conversations.own(conversationId);
		if (!o) return null;
		return {
			conversationId,
			expression: o.expression ?? "",
			config: o.config,
			manualSkills: o.manualSkills ?? [],
			disabledSkills: o.disabledSkills ?? [],
			inheritedAt: o.inheritedAt ?? null,
			sourceWorkspaceId: o.sourceWorkspaceId ?? null,
		};
	}

	/**
	 * 该对话已保存的表达式是否仍然有效（引用的标签是否还存在）。
	 * 只用于**提示**，绝不修改数据：被冻结的历史快照可能引用了已删除/改名的
	 * 标签，用户有权保留原样，但保存时必须能看到原因。
	 * @returns {{ok:boolean, message:string|null}}
	 */
	function ownExpressionIssue(c) {
		const expr = String(c?.expression ?? "");
		if (expr.trim() === "") return { ok: true, message: null };
		const v = services.templates.validate(expr, { allowEmpty: true });
		if (v.ok) return { ok: true, message: null };
		return { ok: false, message: v.errors?.[0]?.message ?? "表达式非法" };
	}

	/**
	 * 对话版双列界面的统一载荷（与 /workspaces/skills 同形，前端复用同一个面板）。
	 */
	async function convPayload(conversationId, workspaceId) {
		const c = convShape(conversationId);
		const ws = workspaceId ? services.workspaces.get(workspaceId) : null;
		const ctxInfo = await contextForConfig(c?.config, workspacePathOf(ws), {
			workspaceId: workspaceId ?? null,
			conversationId: conversationId ?? null,
		});
		return {
			ok: true,
			conversationId,
			workspaceId,
			// configured=false 表示该对话**从未配置过**（own 为 null）：
			// 语义是「空 = 掌握全部技能」，且界面上不该显示成"继承来源为 null"。
			configured: services.conversations.isConfigured(conversationId),
			expression: c?.expression ?? "",
			config: c?.config ?? { orTags: [], andGroups: [] },
			manualSkills: c?.manualSkills ?? [],
			disabledSkills: c?.disabledSkills ?? [],
			inheritedAt: c?.inheritedAt ?? null,
			sourceWorkspaceId: c?.sourceWorkspaceId ?? null,
			// 只读提示：已冻结的表达式引用了不存在的标签（旧版 bug 遗留）。
			// 不自动修复 —— 数据是用户意志，界面上告诉他原因即可。
			expressionIssue: ownExpressionIssue(c),
			candidates: ctxInfo.candidates,
			universe: ctxInfo.universe,
			catalog: ctxInfo.catalog,
			view: services.conversations.ownView(conversationId, ctxInfo),
		};
	}

	/** 对话绑定到哪个工作区（优先宿主 registry，其次对话自己记录的）。 */
	function workspaceIdForConversation(conversationId) {
		const conv = services.conversations.get(conversationId);
		let host = null;
		if (typeof resolveWorkspaceId === "function") {
			try { host = resolveWorkspaceId(conversationId) ?? null; } catch { host = null; }
		}
		return host ?? conv?.own?.sourceWorkspaceId ?? conv?.inherited?.workspaceId ?? q("workspaceId") ?? null;
	}

		try {
			// ── reads ──────────────────────────────────────────────────────
			if (path === "/skills" && (method === "GET" || method === "POST")) {
				// discoverable skills for the link editor; scan happens on the
				// host plane (project + user roots), names are the link keys.
				// cwd 可选：带上才能扫到该项目的 .dsh/skills。
				// path 是 SKILL.md 的绝对路径 —— 「打开所在文件夹」按钮要用。
				// listSkills 可能是 async（要问宿主 skills 注册表），必须 await。
				const skills = listSkills
					? (await listSkills(q("cwd") ?? undefined, {
						conversationId: q("conversationId") ?? null,
						workspaceId: q("workspaceId") ?? null,
					})) ?? []
					: [];
				// stale = 有标签关联、但这次发现不到的技能（通常是贡献它的插件被关了）。
				// 只**报告**，不删：见 /skills/purge-stale 的注释。
				const live = new Set(skills.map((s) => (typeof s === "string" ? s : s?.name)));
				const stale = [...services._caches.skillLinks.values()]
					.filter((l) => !live.has(l.skillId))
					.map((l) => ({ skillId: l.skillId, tagIds: [...(l.tagIds ?? [])] }));
				return json(res, 200, { ok: true, skills, stale });
			}
			// ── 「刷新技能列表」+「清理失效关联」 ─────────────────────────────
			//
			// 场景：某些技能由**别的插件**贡献（provider 注册进 ctx.skills，根本不落在
			// 任何文件系统根里）。那个插件被 disable 之后，技能立刻消失，但插件这边
			// 的 skillLinks 记录还留着 —— 界面上就表现为"技能还在、数字偏大"。
			//
			// 这里的口径：
			//   GET  /skills            → 实时问宿主，顺带算出 stale（失效关联）
			//   POST /skills/purge-stale → 只删这些失效关联记录（用户在界面上显式点）
			//
			// 为什么不在 GET 里顺手删：关联是用户手工打的标签，插件的临时缺席不等于
			// 用户放弃它。默认只标记，删除必须显式触发。
			if (path === "/skills/purge-stale" && method === "POST") {
				const live = new Set(
					((listSkills ? await listSkills(q("cwd") ?? undefined, {
						conversationId: q("conversationId") ?? null,
						workspaceId: q("workspaceId") ?? null,
					}) : []) ?? []).map((s) => (typeof s === "string" ? s : s?.name)),
				);
				// 发现结果为空 = 宿主没就绪，此时"全是失效"是误判，绝不动数据。
				if (live.size === 0) {
					return json(res, 409, { ok: false, code: "NO_SKILLS", error: "当前发现到 0 个技能，拒绝清理（可能是宿主未就绪）" });
				}
				const wanted = Array.isArray(body?.skillIds) ? new Set(body.skillIds.map(String)) : null;
				const removed = [];
				for (const link of [...services._caches.skillLinks.values()]) {
					if (live.has(link.skillId)) continue;          // 还活着 → 不动
					if (wanted && !wanted.has(link.skillId)) continue; // 用户只勾了部分
					removed.push(link.skillId);
				}
				for (const skillId of removed) await services.tags.unlinkSkill(skillId);
				return json(res, 200, { ok: true, removed, count: removed.length });
			}
			// ── 「打开技能所在文件夹」 ─────────────────────────────────────
			// 宿主没有暴露 shell/reveal 能力，由 src/reveal.js 自己拉起文件管理器。
			if (path === "/skills/reveal" && method === "POST") {
				const target = q("path") ?? (await resolveSkillPath(q("skillName"), q("cwd")));
				if (!target) {
					return json(res, 404, { ok: false, error: `找不到技能文件：${q("skillName") ?? q("path") ?? "(空)"}`, code: "NOT_FOUND" });
				}
				try {
					return json(res, 200, { ok: true, ...revealInExplorer(target) });
				} catch (error) {
					// 路径非法/不存在 → 400 带 code，UI 就地提示（不要 500）
					return json(res, 400, { ok: false, error: String(error?.message ?? error), code: error?.code ?? null });
				}
			}
			// ── 「skill 联系 tag」：一个技能拥有哪些标签（整组读/写） ──────
			if (path === "/skills/tags" && (method === "GET" || method === "POST")) {
				const skillName = String(q("skillName") ?? "").trim();
				if (!skillName) return json(res, 400, { ok: false, error: "缺少 skillName" });
				// 读：GET，或 POST 但没带 tagIds（前端读也走 apiPost，避免多一条 fetch 路径）。
				// 写：显式带 tagIds —— 空数组 = 清空关联，所以不能靠"有没有值"判断。
				const hasWrite = body && Object.prototype.hasOwnProperty.call(body, "tagIds");
				if (method === "GET" || !hasWrite) {
					return json(res, 200, {
						ok: true,
						skillName,
						tagIds: services.tags.tagsForSkill(skillName),
						skill: await skillShape(skillName, q("cwd")),
						tags: services.tags.list(),
					});
				}
				// POST = 用给定 tagIds 整体覆盖该技能的标签集合（空数组 = 清空关联）
				const tagIds = Array.isArray(body.tagIds) ? body.tagIds : [];
				if (tagIds.length === 0) await services.tags.unlinkSkill(skillName);
				else await services.tags.linkSkill(skillName, tagIds);
				return json(res, 200, { ok: true, skillName, tagIds: services.tags.tagsForSkill(skillName) });
			}
			if (path === "/state" && (method === "GET" || method === "POST")) {
				const links = [...services._caches.skillLinks.values()].map((l) => ({ ...l }));
				return json(res, 200, {
					ok: true,
					tags: services.tags.list(),
					skillLinks: links,
					templates: [...services._caches.templates.values()],
					workspaces: [...services._caches.workspaces.values()],
					conversations: [...services._caches.conversations.values()].map((c) => ({
						conversationId: c.conversationId,
						workspaceId: c.inherited.workspaceId,
						tags: Object.fromEntries([...c.tags].map(([k, v]) => [k, { ...v }])),
						config: {
							orTags: [...c.config.orTags],
							andGroups: c.config.andGroups.map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
						},
						inherited: {
							groups: c.inherited.groups.map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
							blockedGroups: [...c.inherited.blockedGroups],
						},
					})),
				});
			}

			// ── tags (§4) ──────────────────────────────────────────────────
			if (path === "/tags" && method === "POST") {
				const rec = await services.tags.create(q("tagId"), q("name"));
				return json(res, 200, { ok: true, tag: rec });
			}
			if (path === "/tags/rename" && method === "POST") {
				await services.tags.rename(q("tagId"), q("name"));
				return json(res, 200, { ok: true });
			}
			if (path === "/tags/link" && method === "POST") {
				await services.tags.linkSkill(q("skillId"), q("tagIds") ?? []);
				return json(res, 200, { ok: true });
			}
			if (path === "/tags/unlink" && method === "POST") {
				await services.tags.unlinkSkill(q("skillId"));
				return json(res, 200, { ok: true });
			}
			if (path === "/tags/delete" && method === "POST") {
				// §4.3: response carries affectedWorkspaces for the confirm dialog
				const out = await services.tags.globalDelete(q("tagId"));
				return json(res, 200, { ok: true, ...out });
			}

			// ── workspaces (§6) ────────────────────────────────────────────
			if (path === "/workspaces/ensure" && method === "POST") {
				// UI entry point: create-if-absent so the editor can start from zero
				const ws = await services.workspaces.ensure(q("workspaceId"));
				return json(res, 200, { ok: true, workspace: wsShape(ws) });
			}
			if (path === "/workspaces/edit" && method === "POST") {
				const ws = await services.workspaces.edit(q("workspaceId"), q("changeType"), q("payload") ?? {});
				return json(res, 200, { ok: true, workspace: wsShape(ws) });
			}
			if (path === "/workspaces/apply-template" && method === "POST") {
				const ws = await services.workspaces.applyTemplate(q("workspaceId"), q("templateId"));
				return json(res, 200, { ok: true, workspace: wsShape(ws) });
			}
			// §5.2 preview: expand a template's config without persisting anything
			if (path === "/templates/expand" && (method === "GET" || method === "POST")) {
				const tpl = services.templates.get(q("templateId"));
				if (!tpl) return json(res, 404, { ok: false, error: `template '${q("templateId")}' not found` });
				return json(res, 200, { ok: true, template: tpl });
			}
			if (path === "/workspaces/sync-all" && method === "POST") {
				const results = await services.workspaces.syncAll(q("workspaceId"));
				return json(res, 200, { ok: true, results });
			}

			// ── 「管理标签」双列界面 ───────────────────────────────────────
			// 左列 = 标签条件（表达式）；右列 = 该工作区掌握/禁用的技能。
			if (path === "/workspaces/expression" && (method === "POST" || method === "GET")) {
				// 保存左列表达式（空串 = 清空条件 = 回到"全部技能"）
				const out = await services.workspaces.setExpression(q("workspaceId"), q("expression") ?? "");
				return json(res, 200, { ok: true, workspace: wsShape(out.record), validation: out.validation });
			}
			if (path === "/workspaces/skills" && (method === "GET" || method === "POST")) {
				// 右列数据：命中技能 / 手动技能 / 禁用技能 / 可见技能
				const wid = q("workspaceId");
				const ws = await services.workspaces.ensure(wid);
				const ctxInfo = await skillContext(ws);
				return json(res, 200, {
					ok: true,
					workspaceId: wid,
					expression: ws.expression ?? "",
					config: ws.config,
					manualSkills: ws.manualSkills ?? [],
					disabledSkills: ws.disabledSkills ?? [],
					candidates: ctxInfo.candidates,
					universe: ctxInfo.universe,
					catalog: ctxInfo.catalog,
					view: services.workspaces.view(wid, ctxInfo),
				});
			}
			if (path === "/workspaces/skills/add" && method === "POST") {
				// 精细化添加技能（UI 已排除已有技能与被禁用技能）
				const ws = await services.workspaces.addManualSkill(q("workspaceId"), q("skillName"));
				return json(res, 200, { ok: true, workspace: wsShape(ws) });
			}
			if (path === "/workspaces/skills/remove" && method === "POST") {
				const ws = await services.workspaces.removeManualSkill(q("workspaceId"), q("skillName"));
				return json(res, 200, { ok: true, workspace: wsShape(ws) });
			}
			if (path === "/workspaces/skills/disable" && method === "POST") {
				const ws = await services.workspaces.disableSkill(q("workspaceId"), q("skillName"));
				return json(res, 200, { ok: true, workspace: wsShape(ws) });
			}
			if (path === "/workspaces/skills/enable" && method === "POST") {
				const ws = await services.workspaces.enableSkill(q("workspaceId"), q("skillName"));
				return json(res, 200, { ok: true, workspace: wsShape(ws) });
			}

			// ── templates (§5: 标签组 CRUD + 表达式校验/求值) ──────────────
			if (path === "/templates/validate" && (method === "POST" || method === "GET")) {
				// 实时校验：不落库，返回 errors/warnings/normalized/config/dnf。
				// 位置(character offset)直接用于输入框下方的高亮提示。
				// allowEmpty=true 用于「工作区条件」（空 = 无条件 = 掌握全部技能）；
				// 标签组不传，空表达式仍视为非法。
				const v = services.templates.validate(q("expression") ?? "", { allowEmpty: q("allowEmpty") === true || q("allowEmpty") === "true" });
				return json(res, 200, { ok: true, validation: v });
			}
			if (path === "/templates/evaluate" && (method === "POST" || method === "GET")) {
				// 下游打标签入口：给定"当前生效标签 id 集合"，判断标签组是否命中。
				const r = services.templates.evaluate(q("templateId"), q("activeTagIds") ?? []);
				return json(res, 200, { ok: true, ...r });
			}
			if (path === "/templates" && method === "POST") {
				const rec = await services.templates.create(q("templateId"), q("name"), {
					expression: q("expression"),
					config: q("config"),
				});
				return json(res, 200, { ok: true, template: rec });
			}
			if (path === "/templates/update" && method === "POST") {
				const rec = await services.templates.update(q("templateId"), {
					name: q("name"),
					expression: q("expression"),
					config: q("config"),
				});
				return json(res, 200, { ok: true, template: rec });
			}
			if (path === "/templates/delete" && method === "POST") {
				await services.templates.remove(q("templateId"));
				return json(res, 200, { ok: true });
			}

			// ── conversations (§7/§8) ──────────────────────────────────────
			if (path === "/conversations/ensure" && method === "POST") {
				// UI entry point: create-if-absent (with optional workspace init, §8.1)
				const cid = q("conversationId");
				if (!services.conversations.get(cid)) {
					await services.conversations.create(cid, q("workspaceId") ?? null);
				}
				return json(res, 200, { ok: true, conversationId: cid });
			}
			if (path === "/conversations/create" && method === "POST") {
				const conv = await services.conversations.create(q("conversationId"), q("workspaceId") ?? null);
				return json(res, 200, { ok: true, conversationId: conv.conversationId });
			}
			if (path === "/conversations/sync" && method === "POST") {
				const out = await services.conversations.syncWorkspace(q("conversationId"), q("workspaceConfig"));
				return json(res, 200, { ok: true, ...out });
			}
			if (path === "/conversations/user" && method === "POST") {
				// action ∈ addTag|setLoad|exempt|unexempt|block|unblock|removeEntirely|editOwnGroup|blockGroup|unblockGroup|detach
				const cid = q("conversationId");
				const action = q("action");
				const tagId = q("tagId");
				const s = services.conversations;
				switch (action) {
					case "addTag": await s.userAddTag(cid, tagId); break;
					case "setLoad": await s.userSetLoad(cid, tagId, q("load")); break;
					case "exempt": await s.userExempt(cid, tagId); break;
					case "unexempt": await s.userUnexempt(cid, tagId); break;
					case "block": await s.userBlock(cid, tagId); break;
					case "unblock": await s.userUnblock(cid, tagId); break;
					case "removeEntirely": await s.userRemoveTagEntirely(cid, tagId); break;
					case "editOwnGroup": await s.userEditOwnGroup(cid, q("changeType"), q("payload") ?? {}); break;
					case "blockGroup": await s.blockInheritedGroup(cid, q("groupId")); break;
					case "unblockGroup": await s.unblockInheritedGroup(cid, q("groupId")); break;
					case "detach": await s.detach(cid); break;
					default: return json(res, 400, { ok: false, error: "unknown action: " + action });
				}
				return json(res, 200, { ok: true });
			}
			if (path === "/conversations/candidates" && (method === "GET" || method === "POST")) {
				const links = [...services._caches.skillLinks.values()];
				return json(res, 200, {
					ok: true,
					candidates: services.conversations.candidates(q("conversationId"), links),
					activeTags: [...services.conversations.activeTags(q("conversationId"))],
				});
			}

			// ── 「对话 → 管理标签」双列界面 ────────────────────────────────
			// 对话拥有**自己的**配置快照（own）：标签条件 + 手动添加 + 禁用。
			// 工作区配置不会自动流入对话，除非：新建对话（自动继承一次）或
			// 用户点了「继承工作区配置」按钮。
			if (path === "/conversations/config" && (method === "GET" || method === "POST")) {
				const cid = q("conversationId");
				const wid = workspaceIdForConversation(cid);
				// 打开「管理标签（对话）」是**纯读**：只保证对话行存在，绝不播种 own。
				// （旧实现在这里用当前工作区播种，导致"看一眼就被冻结"，且冻结值
				//  取决于点开的先后顺序 —— 是「改工作区标签波及部分对话」的根因之一。）
				await services.conversations.ensureOwn(cid);
				return json(res, 200, await convPayload(cid, wid));
			}
			if (path === "/conversations/inherit" && method === "POST") {
				// 「继承工作区配置」按钮：整体覆盖对话的三件套（条件+手动+禁用）
				const cid = q("conversationId");
				const wid = q("workspaceId") ?? workspaceIdForConversation(cid);
				if (!wid) return json(res, 400, { ok: false, error: "没有可继承的工作区：请先为该对话选择工作区" });
				await services.conversations.inheritFromWorkspace(cid, wid);
				return json(res, 200, await convPayload(cid, wid));
			}
			if (path === "/conversations/expression" && method === "POST") {
				const cid = q("conversationId");
				const out = await services.conversations.setOwnExpression(cid, q("expression") ?? "");
				return json(res, 200, { ok: true, conversation: convShape(cid), validation: out.validation });
			}
			if (path === "/conversations/skills/add" && method === "POST") {
				await services.conversations.addOwnManualSkill(q("conversationId"), q("skillName"));
				return json(res, 200, { ok: true, conversation: convShape(q("conversationId")) });
			}
			if (path === "/conversations/skills/remove" && method === "POST") {
				await services.conversations.removeOwnManualSkill(q("conversationId"), q("skillName"));
				return json(res, 200, { ok: true, conversation: convShape(q("conversationId")) });
			}
			if (path === "/conversations/skills/disable" && method === "POST") {
				await services.conversations.disableOwnSkill(q("conversationId"), q("skillName"));
				return json(res, 200, { ok: true, conversation: convShape(q("conversationId")) });
			}
			if (path === "/conversations/skills/enable" && method === "POST") {
				await services.conversations.enableOwnSkill(q("conversationId"), q("skillName"));
				return json(res, 200, { ok: true, conversation: convShape(q("conversationId")) });
			}

			return json(res, 404, { ok: false, error: "not found: " + path });
		} catch (error) {
			log?.warn?.(`[skill-tag] api ${method} ${path} failed: ${error?.message ?? error}`);
			// 校验类错误回 400（带 code/position/issues，供 UI 就地提示）；其它 500。
			const isValidation = Array.isArray(error?.issues) || typeof error?.position === "number";
			return json(res, isValidation ? 400 : 500, {
				ok: false,
				error: String(error?.message ?? error),
				code: error?.code ?? null,
				position: error?.position ?? null,
				length: error?.length ?? null,
				issues: error?.issues ?? null,
			});
		}
	};
}

/** Mount the handler on a cordis ctx (inject webServer). */
export function mountApi(ctx, services, listSkills = null, resolveWorkspaceId = null, resolveWorkspacePath = null) {
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: "/skill-tag/api",
				handler: createApiHandler(services, ctx.logger, listSkills, resolveWorkspaceId, resolveWorkspacePath),
			}),
		"skill-tag: api",
	);
}
