// skill-tag-plugin — repository port + dsh-storage-domain adapter
//
// Port (Repository) is what services depend on; the adapter wraps a real
// dsh-storage-domain handle. An in-memory implementation serves unit tests.

/**
 * @typedef {Object} Repository
 * All methods async to hide dsh's write-chain promises.
 * @property {() => Promise<Map<string, any>>} listTags
 * @property {(rec: any) => Promise<void>} putTag
 * @property {(tagId: string) => Promise<void>} deleteTag
 * @property {() => Promise<Map<string, any>>} listSkillLinks
 * @property {(rec: any) => Promise<void>} putSkillLink
 * @property {(skillId: string) => Promise<void>} deleteSkillLink
 * @property {() => Promise<Map<string, any>>} listTemplates
 * @property {(rec: any) => Promise<void>} putTemplate
 * @property {(templateId: string) => Promise<void>} deleteTemplate
 * @property {() => Promise<Map<string, any>>} listWorkspaces
 * @property {(rec: any) => Promise<void>} putWorkspace
 * @property {(workspaceId: string) => Promise<void>} deleteWorkspace
 * @property {() => Promise<Map<string, any>>} listConversations
 * @property {(rec: any) => Promise<void>} putConversation
 * @property {(conversationId: string) => Promise<void>} deleteConversation
 */

// ── In-memory implementation (unit tests) ───────────────────────────────────

/** @returns {Repository} */
export function createMemoryRepository() {
	const tables = {
		tags: new Map(),
		"skill_links": new Map(),
		templates: new Map(),
		workspaces: new Map(),
		conversations: new Map(),
		"sync_meta": new Map(),
	};
	const t = (name) => tables[name];
	return {
		async listTags() { return new Map(t("tags")); },
		async putTag(rec) { t("tags").set(rec.tagId, structuredClone(rec)); },
		async deleteTag(id) { t("tags").delete(id); },
		async listSkillLinks() { return new Map(t("skill_links")); },
		async putSkillLink(rec) { t("skill_links").set(rec.skillId, structuredClone(rec)); },
		async deleteSkillLink(id) { t("skill_links").delete(id); },
		async listTemplates() { return new Map(t("templates")); },
		async putTemplate(rec) { t("templates").set(rec.templateId, structuredClone(rec)); },
		async deleteTemplate(id) { t("templates").delete(id); },
		async listWorkspaces() { return new Map(t("workspaces")); },
		async putWorkspace(rec) { t("workspaces").set(rec.workspaceId, structuredClone(rec)); },
		async deleteWorkspace(id) { t("workspaces").delete(id); },
		async listConversations() { return new Map(t("conversations")); },
		async putConversation(rec) { t("conversations").set(rec.conversationId, structuredClone(rec)); },
		async deleteConversation(id) { t("conversations").delete(id); },
	};
}

// ── dsh-storage-domain adapter (real runtime) ───────────────────────────────

/**
 * Wrap an opened dsh-storage-domain handle (see schema.js skillTagDomain).
 * @param {object} domain  opened domain (KvTable handles via domain.table)
 * @returns {Repository}
 */
export function createDshRepository(domain) {
	const tables = {
		tags: domain.table("tags"),
		"skill_links": domain.table("skill_links"),
		templates: domain.table("templates"),
		workspaces: domain.table("workspaces"),
		conversations: domain.table("conversations"),
		"sync_meta": domain.table("sync_meta"),
	};
	const rows = async (name) => {
		const out = new Map();
		for (const [k, v] of tables[name].entries()) out.set(k, v);
		return out;
	};
	return {
		async listTags() { return rows("tags"); },
		async putTag(rec) { await tables.tags.put(rec.tagId, rec); },
		async deleteTag(id) { await tables.tags.delete(id); },
		async listSkillLinks() { return rows("skill_links"); },
		async putSkillLink(rec) { await tables["skill_links"].put(rec.skillId, rec); },
		async deleteSkillLink(id) { await tables["skill_links"].delete(id); },
		async listTemplates() { return rows("templates"); },
		async putTemplate(rec) { await tables.templates.put(rec.templateId, rec); },
		async deleteTemplate(id) { await tables.templates.delete(id); },
		async listWorkspaces() { return rows("workspaces"); },
		async putWorkspace(rec) { await tables.workspaces.put(rec.workspaceId, rec); },
		async deleteWorkspace(id) { await tables.workspaces.delete(id); },
		async listConversations() { return rows("conversations"); },
		async putConversation(rec) { await tables.conversations.put(rec.conversationId, rec); },
		async deleteConversation(id) { await tables.conversations.delete(id); },
	};
}

// ── Conversation state ⇄ record serialization (spec §12: must persist) ─────

/**
 * Serialize a live ConversationState (Maps/Sets) into a storable record.
 * @param {object} conv  ConversationState (domain/conv.js)
 */
export function serializeConversation(conv) {
	return {
		conversationId: conv.conversationId,
		tags: Object.fromEntries([...conv.tags].map(([k, v]) => [k, { ...v }])),
		config: {
			orTags: [...conv.config.orTags],
			andGroups: conv.config.andGroups.map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
		},
		inherited: {
			workspaceId: conv.inherited.workspaceId,
			groups: conv.inherited.groups.map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
			blockedGroups: [...conv.inherited.blockedGroups],
		},
		own: conv.own
			? {
				expression: conv.own.expression ?? "",
				config: {
					orTags: [...(conv.own.config?.orTags ?? [])],
					andGroups: (conv.own.config?.andGroups ?? []).map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
				},
				manualSkills: [...(conv.own.manualSkills ?? [])],
				disabledSkills: [...(conv.own.disabledSkills ?? [])],
				inheritedAt: conv.own.inheritedAt ?? null,
				sourceWorkspaceId: conv.own.sourceWorkspaceId ?? null,
			}
			: undefined,
		syncedWorkspace: conv.syncedWorkspace ? { ...conv.syncedWorkspace } : null,
	};
}

/**
 * Deserialize a stored record back into a live ConversationState.
 * @param {object} rec
 */
export function deserializeConversation(rec) {
	return {
		conversationId: rec.conversationId,
		tags: new Map(Object.entries(rec.tags ?? {}).map(([k, v]) => [k, { ...v }])),
		config: {
			orTags: [...(rec.config?.orTags ?? [])],
			andGroups: (rec.config?.andGroups ?? []).map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
		},
		inherited: {
			workspaceId: rec.inherited?.workspaceId ?? null,
			groups: (rec.inherited?.groups ?? []).map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
			blockedGroups: new Set(rec.inherited?.blockedGroups ?? []),
		},
		own: rec.own
			? {
				expression: rec.own.expression ?? "",
				config: {
					orTags: [...(rec.own.config?.orTags ?? [])],
					andGroups: (rec.own.config?.andGroups ?? []).map((g) => ({ groupId: g.groupId, tagIds: [...g.tagIds] })),
				},
				manualSkills: [...(rec.own.manualSkills ?? [])],
				disabledSkills: [...(rec.own.disabledSkills ?? [])],
				inheritedAt: rec.own.inheritedAt ?? null,
				sourceWorkspaceId: rec.own.sourceWorkspaceId ?? null,
			}
			: null,
		syncedWorkspace: rec.syncedWorkspace ? { ...rec.syncedWorkspace } : null,
	};
}
