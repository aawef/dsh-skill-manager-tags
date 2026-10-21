// skill-tag-plugin — workspace→conversation incremental sync (spec §8)
//
// THE core invariant: never full-overwrite. Workspace changes are applied as
// incremental events onto each linked conversation's own persisted state.
//
// Verified against spec §8.1–8.6 examples:
//   §8.4  workspace {a,b,c} emptied → conversation keeps its own {d,e}
//   §8.5  conversation-owned x + workspace adds x → adopted (kept user state)
//         unless exempt/blocked
//   §8.6  detach = distinct event: remove managed+loaded, keep everything else

import { groupIdOf, pruneGroups, addToOr, removeFromOr } from "./model.js";
import { inheritedGroupId } from "./conv.js";

/**
 * §8.1 Initialize a conversation from its workspace (called once at creation).
 * Copies workspace OR config + AND groups + load state, marks managed,
 * stores inherited group identities. OR/AND relations stay independent.
 * @param {ConversationState} conv   fresh conversation state
 * @param {TagConfig} workspace      workspace config {orTags, andGroups}
 * @param {string} workspaceId
 */
export function initFromWorkspace(conv, workspace, workspaceId) {
	conv.inherited.workspaceId = workspaceId;
	for (const tagId of workspace.orTags) {
		addToOr(conv.config, tagId);
		conv.tags.set(tagId, {
			load: "loaded", exempt: false, blocked: false,
			managed: "workspace", workspaceSource: workspaceId,
		});
	}
	for (const g of workspace.andGroups) {
		const gid = inheritedGroupId(g.tagIds);
		for (const tagId of g.tagIds) {
			if (!conv.tags.has(tagId)) {
				conv.tags.set(tagId, {
					load: "loaded", exempt: false, blocked: false,
					managed: "workspace", workspaceSource: workspaceId,
				});
			}
		}
		if (!conv.inherited.groups.some((x) => x.groupId === gid)) {
			conv.inherited.groups.push({ groupId: gid, tagIds: [...new Set(g.tagIds)] });
		}
	}
	snapshotSync(conv, workspace);
}

/** §12 同步状态 — remember last synced workspace config for diffing. */
function snapshotSync(conv, workspace) {
	conv.syncedWorkspace = {
		workspaceId: conv.inherited.workspaceId,
		orTags: [...new Set(workspace.orTags)],
		groupIds: workspace.andGroups.map((g) => groupIdOf(g.tagIds)),
	};
}

/**
 * Diff current workspace config vs last-synced snapshot → incremental events.
 * Repeated events with no config change produce zero ops (idempotence, §8.2).
 * @param {ConversationState} conv
 * @param {TagConfig} workspace  current workspace config
 * @returns {{addedOr:string[], removedOr:string[], addedGroups:string[], removedGroups:string[]}}
 */
export function diffSync(conv, workspace) {
	const prev = conv.syncedWorkspace ?? { workspaceId: conv.inherited.workspaceId, orTags: [], groupIds: [] };
	const curOr = [...new Set(workspace.orTags)];
	const curGroups = workspace.andGroups.map((g) => groupIdOf(g.tagIds));
	const curGroupSet = new Set(curGroups);
	const prevGroupSet = new Set(prev.groupIds);
	return {
		addedOr: curOr.filter((t) => !prev.orTags.includes(t)),
		removedOr: prev.orTags.filter((t) => !curOr.includes(t)),
		addedGroups: curGroups.filter((g) => !prevGroupSet.has(g)),
		removedGroups: prev.groupIds.filter((g) => !curGroupSet.has(g)),
	};
}

/**
 * §8.2 Workspace ADDED tags/groups → apply incrementally to one conversation.
 * Zone rules (per §8.2 + §8.5 + §7.2/7.3/7.4):
 *   absent tag           → copy workspace config + manage
 *   conversation-owned   → adopt, keep user state
 *   exempt               → untouched
 *   blocked / unloaded   → untouched (never auto-load)
 * @param {ConversationState} conv   mutated
 * @param {TagConfig} workspace      CURRENT workspace config (post-change)
 * @param {{addedOr?:string[], addedGroups?:string[]}} [precomputed]  optional diff
 */
export function applyWorkspaceAdd(conv, workspace, precomputed) {
	const wid = conv.inherited.workspaceId;
	const addedOr = precomputed?.addedOr ?? workspace.orTags;
	const addedGroupIds = precomputed?.addedGroups ?? workspace.andGroups.map((g) => groupIdOf(g.tagIds));

	for (const tagId of addedOr) {
		const st = conv.tags.get(tagId);
		if (!st) {
			conv.tags.set(tagId, {
				load: "loaded", exempt: false, blocked: false,
				managed: "workspace", workspaceSource: wid,
			});
			addToOr(conv.config, tagId);
		} else if (st.managed === "none" && st.load === "loaded" && !st.exempt && !st.blocked) {
			// §8.5 adoption — conversation-owned, loaded, not exempt/blocked
			st.managed = "adopted";
			st.workspaceSource = wid;
			addToOr(conv.config, tagId); // ensure OR membership mirrors workspace copy
		}
		// exempt/blocked/unloaded: keep as-is (§8.2 bullets 3-5)
	}

	for (const g of workspace.andGroups) {
		const gid = groupIdOf(g.tagIds);
		if (!addedGroupIds.includes(gid)) continue;
		// ensure every member tag exists in conversation state (workspace-managed
		// unless the conversation already holds it with user state)
		for (const tagId of g.tagIds) {
			if (!conv.tags.has(tagId)) {
				conv.tags.set(tagId, {
					load: "loaded", exempt: false, blocked: false,
					managed: "workspace", workspaceSource: wid,
				});
			}
		}
		if (!conv.inherited.groups.some((x) => x.groupId === gid)) {
			conv.inherited.groups.push({ groupId: gid, tagIds: [...new Set(g.tagIds)] });
		}
	}
	snapshotSync(conv, workspace);
}

/**
 * §8.3 Workspace REMOVED tags/groups → apply incrementally.
 * Removes only managed+loaded zone-1 relations. Keeps conversation-owned,
 * exempt, blocked, unloaded (unloaded keeps intent, drops stale management).
 * Removes the tag's membership from inherited groups; prunes <2 groups.
 * Never touches conversation-owned groups (§8.3 bullet: 对话自有 AND 组…不得被覆盖).
 * @param {ConversationState} conv  mutated
 * @param {TagConfig} workspace     CURRENT workspace config (post-change)
 * @param {{removedOr?:string[], removedGroups?:string[]}} [precomputed]
 */
export function applyWorkspaceRemove(conv, workspace, precomputed) {
	const removedOr = precomputed?.removedOr ?? [];
	const removedGroupIds = precomputed?.removedGroups ?? [];

	for (const tagId of removedOr) {
		const st = conv.tags.get(tagId);
		if (!st) continue;
		const stillInWorkspace = workspace.orTags.includes(tagId) ||
			workspace.andGroups.some((g) => g.tagIds.includes(tagId));
		if (stillInWorkspace) continue; // removed from OR but still in a group etc.
		if (st.managed !== "none" && st.load === "loaded" && !st.exempt && !st.blocked) {
			// zone-1 managed tag → remove entirely from conversation
			conv.tags.delete(tagId);
			removeFromOr(conv.config, tagId);
		} else {
			// keep state; clear stale management relation (§8.3 bullet 5)
			st.managed = "none";
			st.workspaceSource = null;
		}
	}

	for (const gid of removedGroupIds) {
		const idx = conv.inherited.groups.findIndex((g) => g.groupId === gid);
		if (idx !== -1) conv.inherited.groups.splice(idx, 1);
		// §9.2: block record for this identity is KEPT (persisted) so a
		// delete+re-add of the same group stays blocked.
	}

	// §8.3 bullet 6: remove removed tags' membership from remaining inherited
	// groups, then prune groups falling below 2 members (§9.4).
	if (removedOr.length > 0) {
		const removedSet = new Set(removedOr);
		for (const g of conv.inherited.groups) {
			g.tagIds = g.tagIds.filter((t) => !removedSet.has(t));
		}
		pruneGroups(conv.inherited.groups);
		conv.inherited.groups = conv.inherited.groups.filter((g) => new Set(g.tagIds).size >= 2);
	}
	snapshotSync(conv, workspace);
}

/**
 * §8.6 Conversation DETACHES from workspace (moved to ungrouped, or workspace
 * deleted). A distinct event — never implement as "clear all" (§8.6 last line).
 * Removes managed+loaded zone-1 tags; clears inheritance; keeps owned, exempt,
 * blocked, unloaded intent; keeps own groups; inherited blocked-group records
 * survive (§8.6: 已被屏蔽的继承组，应保留足以防止误恢复的屏蔽记录).
 * @param {ConversationState} conv  mutated
 */
export function detachFromWorkspace(conv) {
	const wid = conv.inherited.workspaceId;
	if (wid == null) return;
	for (const [tagId, st] of [...conv.tags]) {
		const fromThisWorkspace = st.workspaceSource === wid || st.managed === "workspace" || st.managed === "adopted";
		if (!fromThisWorkspace) continue;
		if (st.managed !== "none" && st.load === "loaded" && !st.exempt && !st.blocked) {
			conv.tags.delete(tagId);
			removeFromOr(conv.config, tagId);
		} else {
			// exempt/blocked/unloaded keep state; clear stale management
			st.managed = "none";
			st.workspaceSource = null;
		}
	}
	// inherited groups: cleared, EXCEPT block records for blocked identities,
	// which persist so a future re-link doesn't silently revive them (§8.6/§9.2).
	const blockedIdentities = [...conv.inherited.blockedGroups];
	conv.inherited.groups = [];
	conv.inherited.workspaceId = null;
	conv.inherited.blockedGroups = new Set(blockedIdentities);
	conv.syncedWorkspace = null;
}
