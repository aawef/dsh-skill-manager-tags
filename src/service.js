// skill-tag-plugin — service layer: tag store / workspace service / conversation
// service (glue: domain pure functions + Repository persistence, spec §4-§10)
//
// All mutations are load-mutate-persist; repo is the only I/O boundary.

import {
	emptyTagConfig, addToOr, removeFromOr, addToGroup, removeFromGroup,
	deleteGroup, removeTagEntirely as domainRemoveTagEntirely, mergeTagConfig,
	groupIdOf, pruneGroups,
} from "./domain/model.js";
import {
	createConversationState, conversationAddTag, conversationSetLoad,
	conversationExempt, conversationUnexempt, conversationBlock, conversationUnblock,
	conversationRemoveTagEntirely, conversationActiveTags, conversationEffectiveConfig,
	inheritedGroupId, emptyOwnConfig, ownConfigFromWorkspace,
} from "./domain/conv.js";
import {
	initFromWorkspace, diffSync, applyWorkspaceAdd, applyWorkspaceRemove,
	detachFromWorkspace,
} from "./domain/sync.js";
import { candidatesFor } from "./domain/match.js";
import { workspaceSkillView, workspaceDeniedSkills } from "./domain/workspace.js";
import {
	validateExpression, evaluateDnf, configToExpression, renameTagInExpression,
	removeTagFromExpression,
} from "./domain/expr.js";
import { serializeConversation, deserializeConversation } from "./storage/repository.js";

/**
 * @typedef {Object} Services
 * @property {TagStore} tags
 * @property {TemplateStore} templates
 * @property {WorkspaceService} workspaces
 * @property {ConversationService} conversations
 */

/**
 * Build the service bundle over a Repository.
 * @param {import("../storage/repository.js").Repository} repo
 * @param {{log?:(msg:string)=>void}} [opts]
 * @returns {Services}
 */
export function createServices(repo, opts = {}) {
	const appLog = opts.log ?? null;
	// in-memory caches; repo is source of truth, cache is write-through
	const tags = new Map();
	const skillLinks = new Map();
	const templates = new Map();
	const workspaces = new Map();
	const conversations = new Map(); // conversationId -> live ConversationState
	const syncMeta = new Map(); // key -> {key, rev, updatedAt}

	async function loadAll() {
		for (const [k, v] of await repo.listTags()) tags.set(k, v);
		for (const [k, v] of await repo.listSkillLinks()) skillLinks.set(k, v);
		for (const [k, v] of await repo.listTemplates()) templates.set(k, v);
		for (const [k, v] of await repo.listWorkspaces()) workspaces.set(k, v);
		for (const [k, v] of await repo.listConversations()) conversations.set(k, deserializeConversation(v));
		for (const [k, v] of await repo.listSyncMeta()) syncMeta.set(k, v);
		// 旧数据回填：历史模板只有 config、没有 expression —— 反推出表达式并回写，
		// 保证"再次编辑必须回显"对存量数据同样成立。
		try {
			const n = await templateStore.migrate();
			if (n > 0) appLog?.(`[skill-tag] migrated ${n} legacy template(s) to expression form`);
		} catch (e) {
			appLog?.(`[skill-tag] template migration skipped: ${e?.message ?? e}`);
		}
		// 工作区历史行：只有 {workspaceId, config} → 反推 expression 并补齐 manual/disabled
		try {
			const n = await workspaceService.migrate();
			if (n > 0) appLog?.(`[skill-tag] migrated ${n} legacy workspace(s) to expression form`);
		} catch (e) {
			appLog?.(`[skill-tag] workspace migration skipped: ${e?.message ?? e}`);
		}
	}

	// ── 对话快照（own）的联动维护 ────────────────────────────────────────
	//
	// own 是"冻结的配置"，但**标签实体本身**是全局的：改名/删除标签必须同步
	// 写回 own，否则冻结住的表达式会指向一个不存在的标签名，用户下次打开
	// 「tag 设置」就会看到"标签不存在"，且保存被拒。
	//
	// 注意这**不是**"自动继承工作区"：改的是标签的名字/存废，不是条件本身。
	// 条件（哪些标签、手动列表、禁用列表）一律保持调用方原样。

	/**
	 * 对每个带 own 的对话快照应用一个纯变换，有实际变化才落库。
	 * @param {(own: object) => string|null} transform 返回新表达式或 null 表示不改
	 */
	async function renameTagInOwnConfigs(transform) {
		for (const [cid, conv] of conversations) {
			if (!conv.own) continue;
			const next = transform(conv.own);
			if (typeof next !== "string" || next === conv.own.expression) continue;
			conv.own.expression = next;
			await repo.putConversation(serializeConversation(conv));
		}
	}

	/**
	 * 全局删除标签后，把该标签从每个对话快照的 config/expression 里摘掉。
	 * 与 workspaces 的处理保持一致（domainRemoveTagEntirely + removeTagFromExpression），
	 * 差别只是数据挂在 own 上。
	 */
	async function dropTagFromOwnConfigs(tagId, removedName) {
		for (const [cid, conv] of conversations) {
			if (!conv.own) continue;
			let changed = false;
			if (conv.own.config) {
				domainRemoveTagEntirely(conv.own.config, tagId);
				changed = true;
			}
			if (removedName && conv.own.expression) {
				const next = removeTagFromExpression(conv.own.expression, removedName);
				if (next !== conv.own.expression) { conv.own.expression = next; changed = true; }
			}
			if (changed) await repo.putConversation(serializeConversation(conv));
		}
	}

	// ── TagStore (spec §4) ───────────────────────────────────────────────────
	const tagStore = {
		async create(tagId, name) {
			if ([...tags.values()].some((t) => t.name === name)) {
				throw new Error(`tag name '${name}' already exists`); // §4.1 name uniqueness
			}
			const rec = { tagId, name, createdAt: new Date().toISOString() };
			tags.set(tagId, rec);
			await repo.putTag(rec);
			return rec;
		},
		async rename(tagId, newName) {
			const rec = tags.get(tagId);
			if (!rec) throw new Error(`tag '${tagId}' not found`);
			if ([...tags.values()].some((t) => t.name === newName && t.tagId !== tagId)) {
				throw new Error(`tag name '${newName}' already exists`);
			}
			const oldName = rec.name;
			rec.name = newName; // §4.1: stable ID relations survive rename
			await repo.putTag(rec);
			// 表达式按名称引用标签 → 改名必须同步改写，否则标签组立刻变成"标签不存在"。
			// 按 token 原位替换，保留用户原有写法（空格/括号/大小写）。
			if (oldName !== newName) {
				for (const tpl of templates.values()) {
					const next = renameTagInExpression(tpl.expression ?? "", oldName, newName);
					if (next !== tpl.expression) {
						tpl.expression = next;
						tpl.updatedAt = new Date().toISOString();
						await repo.putTemplate(tpl);
					}
				}
				// 工作区标签条件同样按名称引用 → 一并改写（否则工作区条件失效）
				for (const ws of workspaces.values()) {
					if (typeof ws.expression !== "string") continue;
					const next = renameTagInExpression(ws.expression, oldName, newName);
					if (next !== ws.expression) {
						ws.expression = next;
						ws.updatedAt = new Date().toISOString();
						await repo.putWorkspace(ws);
					}
				}
				// 对话自己的快照（own）也按名称引用 → 必须一并改写。
				// 2026-10-31 补：此前只写 templates/workspaces，冻结的 own 会留下
				// 指向旧名的表达式，下次打开「tag 设置」直接报"标签不存在"。
				await renameTagInOwnConfigs((own) => renameTagInExpression(own.expression ?? "", oldName, newName));
			}
		},
		list() { return [...tags.values()]; },
		get(tagId) { return tags.get(tagId); },

		/** §4.2 skill↔tag links (bidirectional views derived) */
		async linkSkill(skillId, tagIds) {
			const rec = { skillId, tagIds: [...new Set(tagIds)] };
			for (const t of rec.tagIds) if (!tags.has(t)) throw new Error(`tag '${t}' does not exist (§15-A: no dangling tags)`);
			skillLinks.set(skillId, rec);
			await repo.putSkillLink(rec);
		},
		async unlinkSkill(skillId) {
			skillLinks.delete(skillId);
			await repo.deleteSkillLink(skillId);
		},
		skillsForTag(tagId) {
			return [...skillLinks.values()].filter((l) => l.tagIds.includes(tagId)).map((l) => l.skillId);
		},
		tagsForSkill(skillId) { return skillLinks.get(skillId)?.tagIds ?? []; },

		/**
		 * §4.3 global delete: cleans EVERYTHING referencing the tag. Returns
		 * {affectedWorkspaces: string[]} for the confirmation dialog.
		 */
		async globalDelete(tagId) {
			const affected = [...workspaces.values()]
				.filter((w) => workspaceUsesTag(w.config, tagId))
				.map((w) => w.workspaceId);
			// skill links
			for (const [sid, link] of [...skillLinks]) {
				if (link.tagIds.includes(tagId)) {
					const next = link.tagIds.filter((t) => t !== tagId);
					if (next.length === 0) { skillLinks.delete(sid); await repo.deleteSkillLink(sid); }
					else { link.tagIds = next; await repo.putSkillLink(link); }
				}
			}
			// templates + workspaces configs
			const removedName = tags.get(tagId)?.name;
			for (const tpl of templates.values()) {
				domainRemoveTagEntirely(tpl.config ?? emptyTagConfig(), tagId);
				// 表达式同步摘除该标签（保持 AND/OR 语义，全删空则留空串供 UI 提示）
				if (removedName && tpl.expression) {
					tpl.expression = removeTagFromExpression(tpl.expression, removedName);
				}
				await repo.putTemplate(tpl);
			}
			for (const ws of workspaces.values()) {
				domainRemoveTagEntirely(ws.config, tagId);
				if (removedName && ws.expression) {
					ws.expression = removeTagFromExpression(ws.expression, removedName);
				}
				await repo.putWorkspace(ws);
			}
			// 对话自己的快照（own）：同样摘除该标签。
			// 2026-10-31 补：此前漏了这一段，导致 own.config 里残留已经删除的
			// tagId（本机实测 3 条），而 hasFilter 仍为 true、candidates 变空
			// → 那条对话会把**全部技能**都屏蔽掉，且界面上看不出原因。
			await dropTagFromOwnConfigs(tagId, removedName);
			// conversations: tag state + OR/AND + inherited groups + block/exempt records
			for (const [cid, conv] of conversations) {
				const removed = domainRemoveTagEntirely(conv.config, tagId);
				conv.tags.delete(tagId); // §4.3: 豁免/屏蔽记录随实体删除而结束
				for (const g of conv.inherited.groups) {
					const i = g.tagIds.indexOf(tagId);
					if (i !== -1) g.tagIds.splice(i, 1);
				}
				pruneGroups(conv.inherited.groups);
				conv.inherited.groups = conv.inherited.groups.filter((g) => new Set(g.tagIds).size >= 2);
				await repo.putConversation(serializeConversation(conv));
			}
			tags.delete(tagId);
			await repo.deleteTag(tagId);
			return { affectedWorkspaces: affected };
		},
	};

	function workspaceUsesTag(config, tagId) {
		return config.orTags.includes(tagId) || config.andGroups.some((g) => g.tagIds.includes(tagId));
	}

	// ── TemplateStore (spec §5: 标签组模板 = reusable boolean tag group) ─────
	// 标签组数据结构（持久化于 templates 表）：
	//   {
	//     templateId: string,       稳定 id（名称可改，id 不变）
	//     name:       string,       显示名称，全局唯一
	//     expression: string,       布尔表达式（唯一事实来源），如 "A+B*C"、"（A+B）*C"
	//     config:     TagConfig,    由 expression 推导的 DNF（{orTags, andGroups}）
	//     createdAt / updatedAt:    时间戳
	//   }
	// expression 与 config 严格同步：写入时由 expression 生成 config；读取旧数据
	// （只有 config，无 expression）时用 config 反推表达式并回写 —— 即"再次编辑
	// 必须回显"的持久化保证。
	const templateStore = {
		list() { return [...templates.values()]; },
		get(templateId) { return templates.get(templateId) ?? null; },

		/** 校验表达式（不落库）。UI 实时校验与保存前校验共用同一实现。
		 *  `opts.allowEmpty`：工作区条件允许空表达式（空 = 无条件 = 掌握全部技能）；
		 *  标签组上下文传 false（默认）——标签组必须有运算。
		 */
		validate(expression, opts = {}) {
			return validateExpression(expression, {
				tags: [...tags.values()],
				maxDnfTerms: opts.maxDnfTerms ?? 512,
				allowEmpty: opts.allowEmpty === true,
			});
		},

		/** §5.1 create. 表达式先校验，失败即抛（错误里带 code/position）。 */
		async create(templateId, name, input, opts = {}) {
			if (!templateId) throw new Error("templateId required");
			if (!name || !String(name).trim()) throw new Error("标签组名称不能为空");
			if ([...templates.values()].some((t) => t.name === name)) {
				throw new Error(`template name '${name}' already exists`);
			}
			const now = new Date().toISOString();
			const built = buildTemplateBody(input, name, tags);
			const rec = {
				templateId,
				name,
				expression: built.expression,
				config: built.config,
				createdAt: now,
				updatedAt: now,
			};
			templates.set(templateId, rec);
			await repo.putTemplate(rec);
			return rec;
		},

		/** §5.1 edit (rename and/or replace expression). Identity (templateId) stable. */
		async update(templateId, { name, expression, config } = {}) {
			const rec = templates.get(templateId);
			if (!rec) throw new Error(`template '${templateId}' not found`);
			let nextName = rec.name;
			if (name !== undefined) {
				nextName = String(name).trim();
				if (!nextName) throw new Error("标签组名称不能为空");
				if ([...templates.values()].some((t) => t.name === nextName && t.templateId !== templateId)) {
					throw new Error(`template name '${nextName}' already exists`);
				}
			}
			// 只改表达式时沿用旧名（旧名参与"空名"提示，不影响语义）
			const body = expression !== undefined || config !== undefined
				? buildTemplateBody({ expression, config }, nextName, tags)
				: null;
			rec.name = nextName;
			if (body) {
				rec.expression = body.expression;
				rec.config = body.config;
			}
			rec.updatedAt = new Date().toISOString();
			await repo.putTemplate(rec);
			return rec;
		},

		/** §5.1 delete. Templates are never referenced at runtime (copy semantics
		 *  §5.3), so no cascade needed — applied workspaces stay independent. */
		async remove(templateId) {
			if (!templates.has(templateId)) throw new Error(`template '${templateId}' not found`);
			templates.delete(templateId);
			await repo.deleteTemplate(templateId);
		},

		/**
		 * 判断一组当前生效标签是否满足标签组的布尔条件（供打标签逻辑使用）。
		 * @param {string} templateId
		 * @param {Iterable<string>} activeTagIds  标签 id 集合
		 * @returns {{matched:boolean, expression:string, dnf:string[][]|null, error:string|null}}
		 */
		evaluate(templateId, activeTagIds) {
			const rec = templates.get(templateId);
			if (!rec) throw new Error(`template '${templateId}' not found`);
			const v = templateStore.validate(rec.expression ?? "");
			if (!v.ok) {
				return { matched: false, expression: rec.expression ?? "", dnf: null, error: v.errors[0]?.message ?? "表达式非法" };
			}
			return {
				matched: evaluateDnf(v.dnf, activeTagIds ?? new Set()),
				expression: rec.expression ?? "",
				dnf: v.dnf,
				error: null,
			};
		},

		/**
		 * 旧数据迁移：只有 config 没有 expression 的历史行，用 config 反推表达式。
		 * 幂等；在 ready() 之后、首次读取之前调用。
		 * @returns {number} 迁移条数
		 */
		async migrate() {
			const idToName = new Map([...tags.values()].map((t) => [t.tagId, t.name]));
			let count = 0;
			for (const rec of templates.values()) {
				let changed = false;
				if (typeof rec.expression !== "string") {
					rec.expression = configToExpression(rec.config, idToName);
					changed = true;
				}
				if (!rec.config) {
					const v = validateExpression(rec.expression, { tags: [...tags.values()] });
					rec.config = v.ok ? v.config : emptyTagConfig();
					changed = true;
				}
				if (!rec.createdAt) { rec.createdAt = rec.updatedAt ?? new Date().toISOString(); changed = true; }
				if (!rec.updatedAt) { rec.updatedAt = rec.createdAt; changed = true; }
				if (changed) { await repo.putTemplate(rec); count += 1; }
			}
			return count;
		},
	};

	/**
	 * 由「表达式」或「结构化 config」构造持久化字段。表达式优先（它是唯一事实来源）；
	 * 只给 config 时用 config 反推表达式（兼容旧客户端与模板导入）。
	 * @returns {{expression:string, config:{orTags:string[],andGroups:{groupId:string,tagIds:string[]}[]}}}
	 */
	function buildTemplateBody(input, label, tagMap) {
		const hasExpr = typeof input?.expression === "string" && input.expression.trim() !== "";
		if (hasExpr) {
			const v = validateExpression(input.expression, { tags: [...tagMap.values()] });
			if (!v.ok) {
				const first = v.errors[0];
				const err = new Error(`标签组「${label}」表达式非法: ${first.message}`);
				err.code = first.code;
				err.position = first.position;
				err.length = first.length;
				err.issues = v.errors;
				throw err;
			}
			return { expression: input.expression, config: normalizeTemplateConfig(v.config, tagMap) };
		}
		if (input?.config !== undefined) {
			const cfg = normalizeTemplateConfig(input.config, tagMap);
			const idToName = new Map([...tagMap.values()].map((t) => [t.tagId, t.name]));
			return { expression: configToExpression(cfg, idToName), config: cfg };
		}
		throw new Error(`标签组「${label}」表达式不能为空`);
	}

	/** Validate + canonicalize a template config against the global tag store:
	 *  every referenced tag must exist (§15-A), group ids derive from member
	 *  sets (§9.2), groups below 2 members are dropped (§9.4 prune). */
	function normalizeTemplateConfig(config, tagMap) {
		const orTags = [...new Set((config?.orTags ?? []).filter((id) => {
			if (!tagMap.has(id)) throw new Error(`tag '${id}' does not exist (§15-A: no dangling tags)`);
			return true;
		}))];
		const andGroups = (config?.andGroups ?? [])
			.map((g) => ({
				groupId: g.groupId ?? groupIdOf(g.tagIds ?? []),
				tagIds: [...new Set(g.tagIds ?? [])].filter((id) => {
					if (!tagMap.has(id)) throw new Error(`tag '${id}' does not exist (§15-A: no dangling tags)`);
					return true;
				}),
			}))
			.filter((g) => g.tagIds.length >= 2);
		return { orTags, andGroups };
	}

	// ── WorkspaceService (spec §5/§6) ────────────────────────────────────────
	// 「管理标签」双列界面之后，工作区不仅持标签条件，还持「手动添加的技能」与
	// 「被禁用的技能」，三者共同决定该工作区掌握哪些技能（见 domain/workspace.js）。
	const workspaceService = {
		async ensure(workspaceId) {
			let rec = workspaces.get(workspaceId);
			if (!rec) {
				rec = {
					workspaceId,
					config: emptyTagConfig(),
					expression: "",
					manualSkills: [],
					disabledSkills: [],
					updatedAt: new Date().toISOString(),
				};
				workspaces.set(workspaceId, rec);
				await repo.putWorkspace(rec);
			}
			// 归一：历史行只有 {workspaceId, config}
			if (typeof rec.expression !== "string") rec.expression = "";
			if (!Array.isArray(rec.manualSkills)) rec.manualSkills = [];
			if (!Array.isArray(rec.disabledSkills)) rec.disabledSkills = [];
			return rec;
		},
		get(workspaceId) { return workspaces.get(workspaceId); },
		/** §6.1 config edits; changeType ∈ 'addOr'|'removeOr'|'addGroup'|'removeGroup'|'deleteGroup' */
		async edit(workspaceId, changeType, payload) {
			const ws = await this.ensure(workspaceId);
			const c = ws.config;
			if (changeType === "addOr") addToOr(c, payload.tagId);
			else if (changeType === "removeOr") removeFromOr(c, payload.tagId);
			else if (changeType === "addGroup") addToGroup(c, payload.groupId, payload.tagId);
			else if (changeType === "removeGroup") removeFromGroup(c, payload.groupId, payload.tagId);
			else if (changeType === "deleteGroup") deleteGroup(c, payload.groupId);
			else throw new Error(`unknown changeType ${changeType}`);
			// §9.4 prune applies to groups that FELL below 2 via removal — never
			// during construction (a freshly started group legitimately holds 1).
			if (changeType === 'removeGroup' || changeType === 'deleteGroup') {
				c.andGroups = c.andGroups.filter((g) => new Set(g.tagIds).size >= 2);
			}
			// 结构化编缉会脱离表达式原文 → 用 config 反推回表达式，保持"回显"一致
			ws.expression = configToExpression(c, tagNameMap());
			ws.updatedAt = new Date().toISOString();
			await repo.putWorkspace(ws);
			return ws;
		},
		/** §5.2 apply template (copy semantics) then sync */
		async applyTemplate(workspaceId, templateId) {
			const tpl = templates.get(templateId);
			if (!tpl) throw new Error(`template '${templateId}' not found`);
			const ws = await this.ensure(workspaceId);
			mergeTagConfig(ws.config, tpl.config); // dedupe identical sets, keep partials
			ws.expression = configToExpression(ws.config, tagNameMap());
			ws.updatedAt = new Date().toISOString();
			await repo.putWorkspace(ws);
			return ws;
		},
		/** §6.1 保存配置触发关联对话增量同步 — diff vs each conversation */
		async syncAll(workspaceId) {
			const ws = workspaces.get(workspaceId);
			if (!ws) throw new Error(`workspace '${workspaceId}' not found`);
			const results = [];
			for (const [cid, conv] of conversations) {
				if (conv.inherited.workspaceId !== workspaceId) continue;
				results.push(await conversationService.syncWorkspace(cid, ws.config));
			}
			return results;
		},

		// ── 「tag 设置」弹窗：标签条件（表达式） ────────────────────────────
		/**
		 * 保存当前工作区的标签条件。表达式为空 = 清空条件（回到"全部技能"）。
		 * @param {string} workspaceId
		 * @param {string} expression
		 * @returns {Promise<{record:Object, validation:Object}>}
		 */
		async setExpression(workspaceId, expression) {
			const ws = await this.ensure(workspaceId);
			// 工作区条件允许空表达式：空 = 无条件 = 掌握全部技能（与标签组语义不同）
			const v = validateExpression(expression, { tags: [...tags.values()], allowEmpty: true });
			if (!v.ok) {
				const err = new Error(v.errors[0]?.message ?? "表达式非法");
				err.issues = v.errors;
				err.position = v.errors[0]?.position;
				throw err;
			}
			ws.expression = v.normalized;
			ws.config = v.normalized === "" ? emptyTagConfig() : v.config;
			ws.updatedAt = new Date().toISOString();
			await repo.putWorkspace(ws);
			return { record: ws, validation: v };
		},

		// ── 右列：手动添加 / 禁用 / 恢复 ───────────────────────────────────
		/** 精细化添加技能（已存在或被禁用的由调用方/UI 先排除） */
		async addManualSkill(workspaceId, skillName) {
			const ws = await this.ensure(workspaceId);
			const name = String(skillName ?? "").trim();
			if (!name) throw new Error("技能名不能为空");
			if (ws.disabledSkills.includes(name)) throw new Error(`技能 '${name}' 已被禁用，请先恢复`);
			if (!ws.manualSkills.includes(name)) ws.manualSkills.push(name);
			ws.updatedAt = new Date().toISOString();
			await repo.putWorkspace(ws);
			return ws;
		},
		/** 移出手动添加（不影响标签命中） */
		async removeManualSkill(workspaceId, skillName) {
			const ws = await this.ensure(workspaceId);
			ws.manualSkills = ws.manualSkills.filter((s) => s !== skillName);
			ws.updatedAt = new Date().toISOString();
			await repo.putWorkspace(ws);
			return ws;
		},
		/** 禁用技能：即使标签命中也不加载。若在手动列表里，一并摘除。 */
		async disableSkill(workspaceId, skillName) {
			const ws = await this.ensure(workspaceId);
			const name = String(skillName ?? "").trim();
			if (!name) throw new Error("技能名不能为空");
			ws.manualSkills = ws.manualSkills.filter((s) => s !== name);
			if (!ws.disabledSkills.includes(name)) ws.disabledSkills.push(name);
			ws.updatedAt = new Date().toISOString();
			await repo.putWorkspace(ws);
			return ws;
		},
		/** 恢复被禁用的技能 */
		async enableSkill(workspaceId, skillName) {
			const ws = await this.ensure(workspaceId);
			ws.disabledSkills = ws.disabledSkills.filter((s) => s !== skillName);
			ws.updatedAt = new Date().toISOString();
			await repo.putWorkspace(ws);
			return ws;
		},

		/**
		 * 计算工作区技能视图（右列数据源）。
		 * @param {string} workspaceId
		 * @param {{candidates?:string[], universe?:string[]}} ctx
		 */
		view(workspaceId, ctx = {}) {
			const ws = workspaces.get(workspaceId);
			const config = ws?.config ?? emptyTagConfig();
			return workspaceSkillView({
				config,
				manualSkills: ws?.manualSkills ?? [],
				disabledSkills: ws?.disabledSkills ?? [],
				candidates: ctx.candidates ?? [],
				universe: ctx.universe ?? [],
			});
		},
		/** 该工作区应被屏蔽的技能名集合（供 deny-shadow 使用） */
		denied(workspaceId, ctx = {}) {
			const ws = workspaces.get(workspaceId);
			return workspaceDeniedSkills({
				config: ws?.config ?? emptyTagConfig(),
				manualSkills: ws?.manualSkills ?? [],
				disabledSkills: ws?.disabledSkills ?? [],
				candidates: ctx.candidates ?? [],
				universe: ctx.universe ?? [],
			});
		},

		/** 历史行回填：只有 config 没有 expression 时用 config 反推表达式（回显） */
		async migrate() {
			let count = 0;
			const names = tagNameMap();
			for (const rec of workspaces.values()) {
				let changed = false;
				if (typeof rec.expression !== "string") {
					rec.expression = configToExpression(rec.config, names);
					changed = true;
				}
				if (!Array.isArray(rec.manualSkills)) { rec.manualSkills = []; changed = true; }
				if (!Array.isArray(rec.disabledSkills)) { rec.disabledSkills = []; changed = true; }
				if (changed) { await repo.putWorkspace(rec); count += 1; }
			}
			return count;
		},
	};

	/** tagId → name 映射（表达式用的是名字） */
	function tagNameMap() {
		return new Map([...tags.values()].map((t) => [t.tagId, t.name]));
	}

	// ── MetaService：插件级里程碑（当前只有 installed_at）────────────────
	//
	// installed_at = 本版**首次运行**的时刻，一旦写下永不改变。
	// 三种对话的判定依赖它（见 lib/index.js seedOwnOnBirth）。
	const INSTALLED_AT_KEY = "installed_at";
	const metaService = {
		/** 读已记录的安装时刻（ISO 字符串），没有则 null。 */
		installedAt() {
			return syncMeta.get(INSTALLED_AT_KEY)?.value ?? null;
		},
		/** 首次运行时写入；已有则原样返回（幂等，永不覆盖）。 */
		async ensureInstalledAt(now = new Date().toISOString()) {
			const existing = syncMeta.get(INSTALLED_AT_KEY);
			if (existing?.value) return existing.value;
			const rec = { key: INSTALLED_AT_KEY, rev: 1, updatedAt: now, value: now };
			syncMeta.set(INSTALLED_AT_KEY, rec);
			await repo.putSyncMeta(rec);
			appLog?.(`[skill-tag] installed_at recorded: ${now}`);
			return now;
		},
	};


	// ── ConversationService (spec §7/§8) ─────────────────────────────────────
	//
	// 「own 只写一次」不变量（2026-10-31 统一口径）：
	//
	//   一条对话的 own 快照只允许在**两个**时刻产生：
	//     ① 出生（新建对话 / 首次观察到 createdAt ≥ installedAt 的会话）→ 继承一次
	//     ② 用户点「继承工作区配置」→ 覆盖
	//
	//   除此之外永不自动写入。尤其：**打开「管理标签（对话）」不是写入时机**
	//   （旧实现会在打开瞬间用当前工作区播种，导致"看一眼就被冻结"，且冻结值
	//   取决于看的先后顺序 —— 这就是 0.1.8 之前「改工作区标签有些对话会被改」
	//   的根因之一）。
	//
	//   own === null 的语义固定为「从未配置过 = 空 = 掌握全部技能」，运行时
	//   绝不再回退到工作区实时配置（见 lib/index.js effectiveSkillsConfig）。
	const conversationService = {
		/** 新建对话（出生）：绑工作区则继承一次。 */
		async create(conversationId, workspaceId = null) {
			const conv = createConversationState();
			conv.conversationId = conversationId;
			if (workspaceId) {
				const ws = workspaces.get(workspaceId);
				if (!ws) throw new Error(`workspace '${workspaceId}' not found`);
				initFromWorkspace(conv, ws.config, workspaceId);
				conv.own = ownConfigFromWorkspace(ws);
			}
			conversations.set(conversationId, conv);
			await repo.putConversation(serializeConversation(conv));
			return conv;
		},
		get(conversationId) { return conversations.get(conversationId); },

		/**
		 * 取（必要时**建行**）对话记录。**不写 own**：own 只由出生播种与
		 * 「继承工作区配置」写。历史对话第一次被打开时 own 仍是 null（= 全部技能），
		 * 直到用户显式继承或编辑。
		 */
		async ensureOwn(conversationId) {
			let conv = conversations.get(conversationId);
			if (!conv) {
				conv = createConversationState();
				conv.conversationId = conversationId;
				conversations.set(conversationId, conv);
				await repo.putConversation(serializeConversation(conv));
			}
			return conv;
		},

		/**
		 * 出生播种（幂等）：只在 own 为 null 且能解析到工作区时继承一次。
		 * 调用方负责「是不是新出生」的判定（见 lib/index.js seedOwnOnBirth）。
		 * @returns {Promise<boolean>} 是否真的播种了
		 */
		async seedOwnOnBirth(conversationId, workspaceId) {
			if (!conversationId || !workspaceId) return false;
			const ws = workspaces.get(workspaceId);
			if (!ws) return false; // 工作区还没登记 → 留空，下次再说（留空 = 全部技能，与"没播种"一致）
			const conv = await this.ensureOwn(conversationId);
			if (conv.own) return false; // 已有配置，绝不覆盖
			conv.own = ownConfigFromWorkspace(ws);
			if (!conv.inherited.workspaceId) conv.inherited.workspaceId = ws.workspaceId;
			await repo.putConversation(serializeConversation(conv));
			return true;
		},

		/** 该对话是否已经有自己的配置快照（own 存在即"配置过"）。 */
		isConfigured(conversationId) {
			return Boolean(conversations.get(conversationId)?.own);
		},

		/**
		 * 「一键下发到工作区下所有对话」：把工作区当前三件套批量写进一批对话的 own。
		 *
		 * 与 inheritFromWorkspace 的区别是**批量**且带**选择性覆盖**：
		 *   overwrite=false（默认）→ 只填 own 为 null 的对话（从未配置过）；
		 *   overwrite=true          → 连已配置的也一起覆盖（界面要求二次确认）。
		 *
		 * 为什么默认不覆盖：已配置的对话要么是出生时继承的快照，要么是用户手工
		 * 调过的。无差别覆盖会抹掉用户意志 —— 0.1.9 那次修复的核心教训。
		 *
		 * @param {string} workspaceId
		 * @param {string[]} conversationIds 该工作区下的对话（由宿主 sessionIds 解析）
		 * @param {{overwrite?: boolean}} [opts]
		 * @returns {Promise<{updated: string[], skipped: string[], overwritten: string[]}>}
		 */
		async pushWorkspaceToConversations(workspaceId, conversationIds, opts = {}) {
			const overwrite = opts.overwrite === true;
			const ws = workspaces.get(workspaceId);
			if (!ws) throw new Error(`workspace '${workspaceId}' not found`);
			const updated = [];
			const skipped = [];
			const overwritten = [];
			for (const cid of [...new Set(conversationIds ?? [])].filter(Boolean)) {
				const conv = await this.ensureOwn(cid);
				const hadOwn = Boolean(conv.own);
				if (hadOwn && !overwrite) { skipped.push(cid); continue; }
				conv.own = ownConfigFromWorkspace(ws);
				if (!conv.inherited.workspaceId) conv.inherited.workspaceId = ws.workspaceId;
				await repo.putConversation(serializeConversation(conv));
				updated.push(cid);
				if (hadOwn) overwritten.push(cid);
			}
			return { updated, skipped, overwritten };
		},

		/**
		 * 试算「一键下发」会影响哪些对话（不写任何数据）。
		 * 界面在确认框里展示这个结果，用户看清范围再决定。
		 */
		previewPushWorkspace(conversationIds) {
			const fresh = [];
			const configured = [];
			for (const cid of [...new Set(conversationIds ?? [])].filter(Boolean)) {
				(this.isConfigured(cid) ? configured : fresh).push(cid);
			}
			return { fresh, configured, total: fresh.length + configured.length };
		},

		/** 对话自己的配置快照（只读视图；保证字段完整） */
		own(conversationId) {
			const conv = conversations.get(conversationId);
			if (!conv) return null;
			const o = conv.own ?? emptyOwnConfig();
			return {
				expression: o.expression ?? "",
				config: {
					orTags: [...(o.config?.orTags ?? [])],
					andGroups: (o.config?.andGroups ?? []).map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
				},
				manualSkills: [...(o.manualSkills ?? [])],
				disabledSkills: [...(o.disabledSkills ?? [])],
				inheritedAt: o.inheritedAt ?? null,
				sourceWorkspaceId: o.sourceWorkspaceId ?? null,
			};
		},

		/**
		 * 「继承工作区配置」按钮：把**当前**工作区的三件套（标签条件 + 手动添加 +
		 * 禁用）深拷贝到对话，覆盖对话已有的快照。这是对话与工作区之间唯一的
		 * 主动同步通道（新建对话时也会走一次）。
		 */
		async inheritFromWorkspace(conversationId, workspaceId) {
			await this.ensureOwn(conversationId);
			const conv = conversations.get(conversationId);
			const ws = workspaceId
				? await workspaceService.ensure(workspaceId)
				: null;
			if (workspaceId && !ws) throw new Error(`workspace '${workspaceId}' not found`);
			conv.own = ownConfigFromWorkspace(ws);
			if (!conv.inherited.workspaceId && ws) conv.inherited.workspaceId = ws.workspaceId;
			await repo.putConversation(serializeConversation(conv));
			return conv;
		},

		/**
		 * 写路径专用：取对话并保证 own 是一个可编辑对象。
		 * 只有**用户在对话页里动手编辑**才会走到这里 —— 这是除「出生」与
		 * 「继承」之外的第三种合法写入时机（用户显式操作，不是自动同步）。
		 */
		async ownForEdit(conversationId) {
			const conv = await this.ensureOwn(conversationId);
			if (!conv.own) conv.own = emptyOwnConfig();
			return conv;
		},

		/** 保存对话的标签条件表达式（空串 = 无条件 = 掌握全部技能）。 */
		async setOwnExpression(conversationId, expression) {
			const conv = await this.ownForEdit(conversationId);
			const v = validateExpression(expression, { tags: [...tags.values()], allowEmpty: true });
			if (!v.ok) {
				const err = new Error(v.errors[0]?.message ?? "表达式非法");
				err.issues = v.errors;
				err.position = v.errors[0]?.position;
				throw err;
			}
			conv.own.expression = v.normalized;
			conv.own.config = v.normalized === "" ? emptyTagConfig() : v.config;
			await repo.putConversation(serializeConversation(conv));
			return { record: conv, validation: v };
		},

		// ── 对话页右列：手动添加 / 禁用 / 恢复 ──────────────────────────
		async addOwnManualSkill(conversationId, skillName) {
			const conv = await this.ownForEdit(conversationId);
			const name = String(skillName ?? "").trim();
			if (!name) throw new Error("技能名不能为空");
			if (conv.own.disabledSkills.includes(name)) throw new Error(`技能 '${name}' 已被禁用，请先恢复`);
			if (!conv.own.manualSkills.includes(name)) conv.own.manualSkills.push(name);
			await repo.putConversation(serializeConversation(conv));
			return conv;
		},
		async removeOwnManualSkill(conversationId, skillName) {
			const conv = await this.ownForEdit(conversationId);
			conv.own.manualSkills = conv.own.manualSkills.filter((s) => s !== skillName);
			await repo.putConversation(serializeConversation(conv));
			return conv;
		},
		async disableOwnSkill(conversationId, skillName) {
			const conv = await this.ownForEdit(conversationId);
			const name = String(skillName ?? "").trim();
			if (!name) throw new Error("技能名不能为空");
			conv.own.manualSkills = conv.own.manualSkills.filter((s) => s !== name);
			if (!conv.own.disabledSkills.includes(name)) conv.own.disabledSkills.push(name);
			await repo.putConversation(serializeConversation(conv));
			return conv;
		},
		async enableOwnSkill(conversationId, skillName) {
			const conv = await this.ownForEdit(conversationId);
			conv.own.disabledSkills = conv.own.disabledSkills.filter((s) => s !== skillName);
			await repo.putConversation(serializeConversation(conv));
			return conv;
		},

		/** 对话页右列数据源（与工作区共用同一份领域实现）。 */
		ownView(conversationId, ctx = {}) {
			const o = this.own(conversationId) ?? emptyOwnConfig();
			return workspaceSkillView({
				config: o.config,
				manualSkills: o.manualSkills,
				disabledSkills: o.disabledSkills,
				candidates: ctx.candidates ?? [],
				universe: ctx.universe ?? [],
			});
		},
		/** 该对话应被 deny-shadow 的技能名集合。 */
		ownDenied(conversationId, ctx = {}) {
			const o = this.own(conversationId) ?? emptyOwnConfig();
			return workspaceDeniedSkills({
				config: o.config,
				manualSkills: o.manualSkills,
				disabledSkills: o.disabledSkills,
				candidates: ctx.candidates ?? [],
				universe: ctx.universe ?? [],
			});
		},

		/** §8.2/8.3 incremental sync of one conversation to CURRENT workspace config */
		async syncWorkspace(conversationId, workspaceConfig) {
			const conv = conversations.get(conversationId);
			if (!conv || !conv.inherited.workspaceId) return { ops: 0 };
			const d = diffSync(conv, workspaceConfig);
			applyWorkspaceRemove(conv, workspaceConfig, { removedOr: d.removedOr, removedGroups: d.removedGroups });
			applyWorkspaceAdd(conv, workspaceConfig, { addedOr: d.addedOr, addedGroups: d.addedGroups });
			await repo.putConversation(serializeConversation(conv));
			return { ops: d.addedOr.length + d.removedOr.length + d.addedGroups.length + d.removedGroups.length, diff: d };
		},

		// user transitions (§7.5) — all persist; none touch workspace/other convs
		async userAddTag(conversationId, tagId) {
			const conv = conversations.get(conversationId);
			conversationAddTag(conv, tagId);
			await repo.putConversation(serializeConversation(conv));
		},
		async userSetLoad(conversationId, tagId, load) {
			conversationSetLoad(conversations.get(conversationId), tagId, load);
			await repo.putConversation(serializeConversation(conversations.get(conversationId)));
		},
		async userExempt(conversationId, tagId) {
			conversationExempt(conversations.get(conversationId), tagId);
			await repo.putConversation(serializeConversation(conversations.get(conversationId)));
		},
		async userUnexempt(conversationId, tagId) {
			conversationUnexempt(conversations.get(conversationId), tagId);
			await repo.putConversation(serializeConversation(conversations.get(conversationId)));
		},
		async userBlock(conversationId, tagId) {
			conversationBlock(conversations.get(conversationId), tagId);
			await repo.putConversation(serializeConversation(conversations.get(conversationId)));
		},
		async userUnblock(conversationId, tagId) {
			conversationUnblock(conversations.get(conversationId), tagId);
			await repo.putConversation(serializeConversation(conversations.get(conversationId)));
		},
		async userRemoveTagEntirely(conversationId, tagId) {
			conversationRemoveTagEntirely(conversations.get(conversationId), tagId);
			await repo.putConversation(serializeConversation(conversations.get(conversationId)));
		},
		async userEditOwnGroup(conversationId, changeType, payload) {
			const conv = conversations.get(conversationId);
			const c = conv.config;
			if (changeType === "addGroup") addToGroup(c, payload.groupId, payload.tagId);
			else if (changeType === "removeGroup") removeFromGroup(c, payload.groupId, payload.tagId);
			else if (changeType === "deleteGroup") deleteGroup(c, payload.groupId);
			else throw new Error(`unknown changeType ${changeType}`);
			c.andGroups = c.andGroups.filter((g) => new Set(g.tagIds).size >= 2);
			await repo.putConversation(serializeConversation(conv));
		},
		async blockInheritedGroup(conversationId, groupId) {
			const conv = conversations.get(conversationId);
			conv.inherited.blockedGroups.add(groupId); // §9.2 persisted
			await repo.putConversation(serializeConversation(conv));
		},
		async unblockInheritedGroup(conversationId, groupId) {
			const conv = conversations.get(conversationId);
			conv.inherited.blockedGroups.delete(groupId);
			await repo.putConversation(serializeConversation(conv));
		},

		/** §8.6 detach (conversation leaves workspace → ungrouped) */
		async detach(conversationId) {
			const conv = conversations.get(conversationId);
			detachFromWorkspace(conv);
			await repo.putConversation(serializeConversation(conv));
		},

		/** §11: current candidates for a conversation */
		candidates(conversationId, skillTagLinks) {
			const conv = conversations.get(conversationId);
			return candidatesFor({
				skillTagLinks,
				config: conversationEffectiveConfig(conv),
				active: conversationActiveTags(conv),
			});
		},
		effectiveConfig(conversationId) {
			return conversationEffectiveConfig(conversations.get(conversationId));
		},
		activeTags(conversationId) {
			return conversationActiveTags(conversations.get(conversationId));
		},
	};

	return {
		tags: tagStore,
		templates: templateStore,
		workspaces: workspaceService,
		conversations: conversationService,
		meta: metaService,
		ready: loadAll,
		/** repository back-reference (api layer: template create) */
		_repo: repo,
		/** exposed for tests/inspection */
		_caches: { tags, skillLinks, templates, workspaces, conversations, syncMeta },
	};
}

/** §4.3 helper re-export for tests */
export { inheritedGroupId };
