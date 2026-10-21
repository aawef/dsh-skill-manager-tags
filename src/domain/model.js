// skill-tag-plugin — domain model types & constructors
// Spec basis: 实现规格 §3(布尔逻辑) §7(四区) §8(增量同步) §9(组继承) §12(持久化)
//
// Pure data layer: no DSH imports, no I/O. Everything here is JSON-serializable
// and validated on load (storage layer responsibility, see src/storage/* later).

/**
 * Load state of a tag within a conversation. Spec §7 orthogonal dimensions:
 *   1. loaded        — does it participate in matching? (loaded=true / unloaded=false)
 *   2. exempt        — loaded but detached from workspace sync (spec §7.2)
 *   3. blocked       — explicit block intent ⊆ unloaded (spec §7.4)
 *   4. managedByWorkspace — provenance: workspace-managed vs conversation-owned
 * These are stored per (conversationId, tagId) as ONE record (four dimensions of
 * one row), never inferred from each other. Spec §7: "实现时可以使用状态字段…
 * 不要求必须用四张独立数据表".
 *
 * @typedef {'loaded'|'unloaded'} LoadState
 * @typedef {'none'|'exempt'} ExemptState
 * @typedef {'none'|'blocked'} BlockState
 * @typedef {'none'|'workspace'|'adopted'} ManagedState
 *   none = conversation-owned (user added, workspace has no claim)
 *   workspace = created by workspace init/sync (spec §8.1/8.2)
 *   adopted = conversation-owned first, later adopted by workspace (spec §8.5)
 */

/** @typedef {string} TagId    stable UUID — name NEVER substitutes (spec §12) */
/** @typedef {string} SkillId  stable skill identity (see discovery: name-based) */

/**
 * @typedef {Object} AndGroup
 * @property {TagId[]} tagIds       member tag ids (order irrelevant for identity)
 * @property {string} groupId       stable identity within owning object
 */

/**
 * Identity key of an AND group. Spec §9.2: stable = sorted tag-ID set + source,
 * never array index. Two groups with identical member sets are the same
 * *semantic* group even if workspace recreates it after deletion.
 * @param {TagId[]} tagIds
 * @returns {string} canonical identity, e.g. "t1|t2|t3" (sorted, deduped)
 */
export function groupIdOf(tagIds) {
	return [...new Set(tagIds)].sort().join("|");
}

/**
 * Validate an AND group invariant: ≥2 distinct members (spec §9.4:
 * "如果某个组的成员少于两个，删除该组" — enforced by callers via prune).
 * @param {AndGroup} g
 */
export function isValidGroup(g) {
	return new Set(g.tagIds).size >= 2;
}

/**
 * Prune groups falling below 2 members. Spec §3.5/§9.4: <2 → delete group,
 * never convert remaining tags to OR. Returns [prunedGroups, removedGroupIds].
 * @template {AndGroup} T
 * @param {T[]} groups
 * @returns {[T[], string[]]}
 */
export function pruneGroups(groups) {
	const kept = [];
	const removed = [];
	for (const g of groups) {
		if (isValidGroup(g)) kept.push(g);
		else removed.push(g.groupId ?? groupIdOf(g.tagIds));
	}
	return [kept, removed];
}

// ── Object config (workspace / conversation / template share this shape) ────

/**
 * @typedef {Object} TagConfig
 * @property {TagId[]} orTags          ordinary OR set (independent dimension)
 * @property {AndGroup[]} andGroups    AND groups (independent dimension)
 */

export function emptyTagConfig() {
	return { orTags: [], andGroups: [] };
}

/**
 * Add a tag to the OR set. NEVER touches AND membership (spec §3.5).
 * @param {TagConfig} config  mutated in place (callers own persistence)
 * @param {TagId} tagId
 */
export function addToOr(config, tagId) {
	if (!config.orTags.includes(tagId)) config.orTags.push(tagId);
}

/**
 * Remove a tag from the OR set. NEVER touches AND membership (spec §3.5:
 * "用户从普通 OR 集合移除一个标签，不应自动删除它在 AND 组中的成员关系").
 */
export function removeFromOr(config, tagId) {
	const i = config.orTags.indexOf(tagId);
	if (i !== -1) config.orTags.splice(i, 1);
}

/**
 * Add a tag to an AND group (creating the group if absent). NEVER touches OR
 * membership (spec §3.5: "把标签加入 AND 组，不自动把它从普通 OR 集合移除").
 * @param {TagConfig} config
 * @param {string} groupId  stable identity key (groupIdOf)
 * @param {TagId} tagId
 */
export function addToGroup(config, groupId, tagId) {
	let g = config.andGroups.find((x) => x.groupId === groupId);
	if (!g) {
		g = { groupId, tagIds: [] };
		config.andGroups.push(g);
	}
	if (!g.tagIds.includes(tagId)) g.tagIds.push(tagId);
}

/**
 * Remove a tag from one AND group only. Does not touch OR membership, does not
 * touch other groups (spec §3.5). Caller decides whether to prune afterwards.
 */
export function removeFromGroup(config, groupId, tagId) {
	const g = config.andGroups.find((x) => x.groupId === groupId);
	if (!g) return;
	const i = g.tagIds.indexOf(tagId);
	if (i !== -1) g.tagIds.splice(i, 1);
}

/**
 * Delete a whole AND group. Does NOT convert members to OR (spec §3.5/§9.4).
 */
export function deleteGroup(config, groupId) {
	const i = config.andGroups.findIndex((x) => x.groupId === groupId);
	if (i !== -1) config.andGroups.splice(i, 1);
}

/**
 * "彻底移除标签" from THIS object only (spec §3.5 last bullet): remove OR
 * membership + all AND memberships in this config; groups left with <2 members
 * are deleted. Returns the ids of groups deleted by the prune.
 * @param {TagConfig} config
 * @param {TagId} tagId
 * @returns {string[]} deleted group ids
 */
export function removeTagEntirely(config, tagId) {
	removeFromOr(config, tagId);
	for (const g of config.andGroups) removeFromGroup(config, g.groupId, tagId);
	const [, removed] = pruneGroups(config.andGroups);
	config.andGroups = config.andGroups.filter((g) => isValidGroup(g));
	return removed;
}

// ── Copy semantics (template → workspace, spec §5.2) ────────────────────────

/**
 * Merge a template's expanded config into a target config (copy semantics).
 * OR tags dedupe; groups dedupe ONLY when member-ID sets are fully identical
 * (spec §5.2: compare ID sets, not order, not names); partially-overlapping
 * groups are kept as distinct groups. Dual membership (OR+AND) preserved.
 * @param {TagConfig} target  mutated
 * @param {TagConfig} source
 */
export function mergeTagConfig(target, source) {
	for (const t of source.orTags) addToOr(target, t);
	for (const g of source.andGroups) {
		const gid = g.groupId ?? groupIdOf(g.tagIds);
		const existing = target.andGroups.find((x) => x.groupId === gid);
		if (existing) {
			for (const t of g.tagIds) if (!existing.tagIds.includes(t)) existing.tagIds.push(t);
		} else {
			target.andGroups.push({ groupId: gid, tagIds: [...new Set(g.tagIds)] });
		}
	}
	pruneGroups(target.andGroups);
	target.andGroups = target.andGroups.filter((g) => isValidGroup(g));
}
