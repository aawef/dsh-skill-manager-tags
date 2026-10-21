// skill-tag-plugin — storage domain schema (spec §12: 9 entity classes)
//
// Backed by @deepseek-ai/dsh-storage-domain defineDomain (evidence:
// docs/evidence/extract-dsh-storage-domain.js — zod record schemas, KvTable
// get/put/delete/update/entries, domain/changed events, caller closes).
//
// Entity → table mapping (§12 table, one row per entity unless noted):
//   tags            全局标签        {tagId, name, createdAt}   key=tagId
//   skillLinks      Skill标签关联   {skillId, tagIds[]}        key=skillId
//   templates       标签组模板      {templateId, name, config} key=templateId
//   workspaces      工作区配置      {workspaceId, config}      key=workspaceId
//   conversations   对话标签状态    convTagState               key=conversationId
//   syncMeta        同步状态        {rev, eventLog tail}       key=conversationId|'global'
// (屏蔽记录/继承关系/对话ORAND are nested inside conversations rows — §12 allows
//  "不要求必须用四张独立数据表"; they must persist, which they do here.)

import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

// ── record schemas ──────────────────────────────────────────────────────────

export const tagRecord = z.object({
	tagId: z.string().min(1),
	name: z.string().min(1),
	createdAt: z.string(),
});

export const skillLinkRecord = z.object({
	skillId: z.string().min(1),
	tagIds: z.array(z.string()),
});

export const andGroupSchema = z.object({
	groupId: z.string(),
	tagIds: z.array(z.string()),
});

export const tagConfigSchema = z.object({
	orTags: z.array(z.string()),
	andGroups: z.array(andGroupSchema),
});

// 标签组（template）：expression 是唯一事实来源，config 是由表达式推导出的
// 可执行条件（DNF ⇄ {orTags, andGroups}），下游匹配引擎直接消费 config。
// 旧数据只有 config 没有 expression —— 读取时由 service 层用 config 反推回填
// （migrate），因此两字段都保持可选以兼容磁盘上的历史行。
export const templateRecord = z.object({
	templateId: z.string(),
	name: z.string(),
	expression: z.string().optional(),
	config: tagConfigSchema.optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

// 工作区配置（「管理标签」双列界面的持久化单位）
//   config      标签条件（DNF，由 expression 编译而来；空 = 无筛选 = 全部技能）
//   expression  标签条件的表达式原文（再次打开「tag 设置」时回显）
//   manualSkills   手动添加的技能名（在标签命中之外额外允许）
//   disabledSkills 被禁用的技能名（即使标签命中也不加载）
// 三个新增字段都可选：磁盘上的历史行只有 {workspaceId, config}。
export const workspaceRecord = z.object({
	workspaceId: z.string(),
	config: tagConfigSchema,
	path: z.string().optional(),
	expression: z.string().optional(),
	manualSkills: z.array(z.string()).optional(),
	disabledSkills: z.array(z.string()).optional(),
	updatedAt: z.string().optional(),
});

// per-tag conversation state (four orthogonal dimensions, spec §7)
export const convTagStateSchema = z.object({
	load: z.enum(["loaded", "unloaded"]),
	exempt: z.boolean(),
	blocked: z.boolean(),
	managed: z.enum(["none", "workspace", "adopted"]),
	workspaceSource: z.string().nullable(),
});

export const inheritedStateSchema = z.object({
	workspaceId: z.string().nullable(),
	groups: z.array(andGroupSchema),
	blockedGroups: z.array(z.string()), // identity keys (groupIdOf) — persisted (§9.2)
});

// 对话自己的「工作区配置」快照（「对话 → 管理标签」双列界面的持久化单位）。
//
// 为什么是**快照**而不是实时引用工作区：用户要求「除非点击继承按钮，或者新创建
// 对话，否则工作区的配置不自动继承到对话」。因此对话一旦建立（或点击继承）
// 就把工作区的三件套拷一份到自己身上，之后工作区再改也影响不到它；对话内的
// 任何编辑都只落在快照上。
//   expression      标签条件表达式（回显用，唯一事实来源）
//   config          由 expression 编译的 DNF
//   manualSkills    手动添加的技能（在标签命中之外额外允许）
//   disabledSkills  被禁用的技能（即使标签命中也不加载）
//   inheritedAt     最近一次从工作区快照的时间（null = 从未继承过）
//   sourceWorkspaceId 快照来源工作区
export const conversationOwnConfigSchema = z.object({
	expression: z.string().optional(),
	config: tagConfigSchema.optional(),
	manualSkills: z.array(z.string()).optional(),
	disabledSkills: z.array(z.string()).optional(),
	inheritedAt: z.string().nullable().optional(),
	sourceWorkspaceId: z.string().nullable().optional(),
});

export const conversationRecord = z.object({
	conversationId: z.string(),
	tags: z.record(z.string(), convTagStateSchema), // tagId -> state
	config: tagConfigSchema, // conversation's own OR + own AND groups
	inherited: inheritedStateSchema,
	// 对话自己的「工作区配置」快照（可选：磁盘上的历史行没有这个字段）
	own: conversationOwnConfigSchema.optional(),
	syncedWorkspace: z
		.object({
			workspaceId: z.string().nullable(),
			orTags: z.array(z.string()),
			groupIds: z.array(z.string()),
		})
		.nullable(),
});

export const syncMetaRecord = z.object({
	key: z.string(),
	rev: z.number().int().nonnegative(),
	updatedAt: z.string(),
});

// ── domain spec ─────────────────────────────────────────────────────────────

export const skillTagDomain = defineDomain({
	name: "skill_tag",
	version: 1,
	tables: {
		tags: domainTable(tagRecord),
		"skill_links": domainTable(skillLinkRecord),
		templates: domainTable(templateRecord),
		workspaces: domainTable(workspaceRecord),
		conversations: domainTable(conversationRecord),
		"sync_meta": domainTable(syncMetaRecord),
	},
});
