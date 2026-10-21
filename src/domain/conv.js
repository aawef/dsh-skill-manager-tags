// skill-tag-plugin — conversation tag state (four-zone model, spec §7)
//
// A conversation tag sits in exactly ONE of the four zones at any moment:
//   1 普通加载区  loaded + ¬exempt + ¬blocked
//   2 豁免区      loaded + exempt            (still matches; detached from sync)
//   3 普通未加载区 unloaded + ¬blocked        (stored, not matching)
//   4 屏蔽区      unloaded + blocked         (explicit block intent, persisted)
//
// Orthogonal stored dimensions per (conversation, tag):
//   load / exempt / blocked / managed / workspaceSource
// plus the conversation's own OR set + own AND groups (spec §12 对话标签状态,
// 对话 OR/AND 配置 as separate entities).

import { emptyTagConfig, addToOr, removeFromOr, groupIdOf, pruneGroups } from "./model.js";

/** @returns {ConversationState} */
export function createConversationState() {
	return {
		tags: new Map(), // tagId -> {load, exempt, blocked, managed, workspaceSource}
		config: emptyTagConfig(), // own OR set + own AND groups
		inherited: {
			workspaceId: null,
			groups: [], // copies of workspace AND groups [{groupId, tagIds}]
			blockedGroups: new Set(), // blocked inherited-group identity keys (persist, §9.2)
		},
		syncedWorkspace: null, // last-synced workspace config snapshot (§12 同步状态)
		// 对话自己的「工作区配置」快照（「对话 → 管理标签」双列界面）。
		//   用户口径：除非点击继承按钮或新建对话，工作区配置不自动继承到对话。
		//   null = 从未继承/初始化 → 该对话无条件 = 掌握全部技能。
		own: null,
	};
}

/** 对话自己的配置快照的空白形态（无条件、无手动、无禁用）。 */
export function emptyOwnConfig() {
	return {
		expression: "",
		config: emptyTagConfig(),
		manualSkills: [],
		disabledSkills: [],
		inheritedAt: null,
		sourceWorkspaceId: null,
	};
}

/**
 * 由工作区记录生成一份**独立副本**（深拷贝，之后的编辑不会互串）。
 * @param {object} ws  workspace record
 * @param {string} [now]
 */
export function ownConfigFromWorkspace(ws, now = new Date().toISOString()) {
	return {
		expression: ws?.expression ?? "",
		config: {
			orTags: [...(ws?.config?.orTags ?? [])],
			andGroups: (ws?.config?.andGroups ?? []).map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
		},
		manualSkills: [...(ws?.manualSkills ?? [])],
		disabledSkills: [...(ws?.disabledSkills ?? [])],
		inheritedAt: now,
		sourceWorkspaceId: ws?.workspaceId ?? null,
	};
}

function freshTagState(managed = "none", workspaceSource = null) {
	return { load: "loaded", exempt: false, blocked: false, managed, workspaceSource };
}

function zoneOf(st) {
	if (st.load === "loaded") return st.exempt ? "exempt" : "loaded";
	return st.blocked ? "blocked" : "unloaded";
}

// ── User transitions (conversation page ops, spec §7.5) ─────────────────────
// None of these touch the workspace, other conversations, global tags or
// templates (§7.5: 对话操作不能反向修改…).

/**
 * Add a tag to the conversation. Defaults to 普通加载区, conversation-owned.
 * @param {ConversationState} conv
 * @param {string} tagId
 * @param {{workspaceSource?: string|null}} [opts]
 */
export function conversationAddTag(conv, tagId, opts = {}) {
	if (!conv.tags.has(tagId)) {
		conv.tags.set(tagId, freshTagState("none", opts.workspaceSource ?? null));
	}
	return conv.tags.get(tagId);
}

/**
 * Switch load state (§7.5 切换加载与未加载状态). Unloading keeps all stored
 * relations (§7.3: 不能因为切到未加载状态就丢失用户配置或错误解除屏蔽).
 */
export function conversationSetLoad(conv, tagId, load) {
	const st = conv.tags.get(tagId);
	if (!st) return;
	st.load = load;
	if (load === "unloaded") st.exempt = false; // exempt implies loaded
}

/** 普通加载区 → 豁免区 (§7.2). Detaches from workspace sync control. */
export function conversationExempt(conv, tagId) {
	const st = conv.tags.get(tagId);
	if (!st || st.load !== "loaded") return;
	st.exempt = true;
	st.managed = "none"; // exemption ends workspace management by definition
	st.workspaceSource = null;
}

/** 豁免区 → 普通加载区 (user-initiated only; workspace can never do this). */
export function conversationUnexempt(conv, tagId) {
	const st = conv.tags.get(tagId);
	if (!st) return;
	st.exempt = false;
}

/** Any zone → 屏蔽区 (§7.4). Persisted; only user or global delete ends it. */
export function conversationBlock(conv, tagId) {
	const st = conv.tags.get(tagId);
	if (!st) return;
	st.load = "unloaded";
	st.blocked = true;
	st.exempt = false;
	st.managed = "none"; // block detaches from workspace control
	st.workspaceSource = null;
}

/**
 * 屏蔽区 → 普通加载区 (user-initiated unblock, §7.5/§9.3). Restores loaded so
 * the unblocked tag can immediately participate again (§9.3: 解除屏蔽后…
 * 便可恢复匹配). A user who wants unloaded-without-block can unload separately.
 */
export function conversationUnblock(conv, tagId) {
	const st = conv.tags.get(tagId);
	if (!st) return;
	st.blocked = false;
	st.load = "loaded";
}

/**
 * 从当前对话彻底移除标签 (§7.5 / §3.5): removes the tag's OR membership and all
 * AND memberships (own groups pruned when <2) plus its per-tag state. This is
 * the ONLY conversation-side op that clears everything — distinct from
 * "移出 OR" and "移出某个 AND 组".
 * @returns {string[]} group ids deleted by pruning
 */
export function conversationRemoveTagEntirely(conv, tagId) {
	const st = conv.tags.get(tagId);
	if (!st) return [];
	conv.tags.delete(tagId);
	removeFromOr(conv.config, tagId);
	for (const g of conv.config.andGroups) {
		const i = g.tagIds.indexOf(tagId);
		if (i !== -1) g.tagIds.splice(i, 1);
	}
	for (const g of conv.inherited.groups) {
		const i = g.tagIds.indexOf(tagId);
		if (i !== -1) g.tagIds.splice(i, 1);
	}
	pruneGroups(conv.config.andGroups);
	conv.config.andGroups = conv.config.andGroups.filter((g) => new Set(g.tagIds).size >= 2);
	pruneGroups(conv.inherited.groups);
	conv.inherited.groups = conv.inherited.groups.filter((g) => new Set(g.tagIds).size >= 2);
	// user-initiated removal ends this conversation's block/exempt records for the tag
	return [];
}

// ── Effective match inputs (spec §11.1) ─────────────────────────────────────

/**
 * Active tag set: loaded ∧ ¬blocked (zones 1+2 participate, 3+4 do not).
 * @returns {Set<string>}
 */
export function conversationActiveTags(conv) {
	const active = new Set();
	for (const [tagId, st] of conv.tags) {
		if (st.load === "loaded" && !st.blocked) active.add(tagId);
	}
	return active;
}

/**
 * Effective boolean config = conversation's own OR set + own AND groups +
 * inherited AND groups that are not blocked (§11.1; §9.2 blocked groups out).
 * @returns {{orTags: string[], andGroups: {groupId: string, tagIds: string[]}[]}}
 */
export function conversationEffectiveConfig(conv) {
	const andGroups = [
		...conv.config.andGroups.map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
		...conv.inherited.groups
			.filter((g) => !conv.inherited.blockedGroups.has(g.groupId))
			.map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
	];
	return { orTags: [...conv.config.orTags], andGroups };
}

/**
 * Stable identity of an inherited group (spec §9.2): canonical member-ID set.
 * Workspace delete + re-add of the same member set → same identity → block
 * persists. Multiple identical workspace groups dedupe to one identity.
 */
export function inheritedGroupId(tagIds) {
	return groupIdOf(tagIds);
}

export { zoneOf };
