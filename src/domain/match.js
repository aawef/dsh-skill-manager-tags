// skill-tag-plugin — boolean match engine (spec §3 + §11.1)
//
// Pure functions. Inputs are plain data; no DSH, no I/O, no state.
//
// Expression semantics (spec §3):
//   match = ∃ t ∈ orTags:            t is active AND skill has t
//        OR ∃ g ∈ andGroups:         every t ∈ g is active AND skill has every t
//
// "Active" = loaded AND not blocked (spec §11.1: 普通加载区+豁免区 participate;
// 普通未加载区+屏蔽区 do not). An AND group with any inactive member cannot match.

/** @typedef {'loaded'|'unloaded'} LoadState */
/** @typedef {'none'|'blocked'} BlockState */

/**
 * Compute the active tag set for a conversation (spec §11.1).
 * active = loaded ∧ ¬blocked. Exempt tags are loaded → active.
 * @param {Map<string, {load: LoadState, block: BlockState}>} convTagState
 *        per-tag conversation state (four-zone model reduced to match inputs)
 * @returns {Set<string>}
 */
export function activeTags(convTagState) {
	const active = new Set();
	for (const [tagId, st] of convTagState) {
		if (st.load === "loaded" && st.block !== "blocked") active.add(tagId);
	}
	return active;
}

/**
 * Evaluate whether a skill's associated tag set matches the conversation's
 * boolean expression (spec §3.2–3.4, §11.1).
 *
 * @param {Object} p
 * @param {string[]} p.skillTags      tag ids actually associated with the skill
 * @param {string[]} p.orTags         conversation/workspace OR set
 * @param {{groupId:string, tagIds:string[]}[]} p.andGroups
 * @param {Set<string>} p.active      active tag set (activeTags())
 * @returns {boolean}
 */
export function matches({ skillTags, orTags, andGroups, active }) {
	const skill = new Set(skillTags);

	// OR path — spec §3.2: a tag in both OR and AND may still hit via OR alone.
	for (const t of orTags) {
		if (active.has(t) && skill.has(t)) return true;
	}

	// AND path — every member active AND skill has every member (§11.1:
	// "Skill 必须同时关联该组全部成员，且该组成员在当前对话中均处于有效加载状态").
	for (const g of andGroups) {
		if (groupMatches(g, skill, active)) return true;
	}
	return false;
}

/**
 * One AND group's match. Incomplete group (any member not active, or skill
 * missing any member) fails the group entirely (spec §3.3, §9.3, §11.1).
 */
export function groupMatches(group, skillTagSet, active) {
	if (group.tagIds.length === 0) return false;
	for (const t of group.tagIds) {
		if (!active.has(t)) return false;   // unloaded/blocked member → group can't match
		if (!skillTagSet.has(t)) return false;
	}
	return true;
}

/**
 * Filter a skill catalog down to candidates for a conversation (spec §11.2:
 * 匹配成功只是候选; actual loading stays with DSH's own mechanism).
 *
 * @param {Object} p
 * @param {{skillId: string, tagIds: string[]}[]} p.skillTagLinks
 * @param {Object} p.config                    {orTags, andGroups}
 * @param {Set<string>} p.active
 * @returns {string[]} candidate skill ids (stable order: input order)
 */
export function candidatesFor({ skillTagLinks, config, active }) {
	const out = [];
	for (const link of skillTagLinks) {
		if (
			matches({
				skillTags: link.tagIds,
				orTags: config.orTags,
				andGroups: config.andGroups,
				active,
			})
		) {
			out.push(link.skillId);
		}
	}
	return out;
}
