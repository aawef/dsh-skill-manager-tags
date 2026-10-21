// skill-tag-plugin — workspace-scoped skill selection (「管理标签」双列界面)
//
// Pure functions. Inputs are plain data; no DSH, no I/O, no state.
//
// 语义（用户确认）：
//   - 左列 = 当前工作区的标签条件（布尔表达式）。空条件 = 无筛选。
//   - 右列 = 当前工作区有的技能 = 「标签规则命中的技能 ∪ 手动添加的技能」−「被禁用的技能」。
//     * 空条件 + 无手动添加  → 右列 = 全部技能（工作区默认掌握全部）
//     * 有条件              → 右列 = 命中子集（严格子集：没打 tag 的技能被排除）
//   - 被禁用的技能即使标签命中也不出现（并且真的不加载，见 lib/index.js deny-shadow）。
//
// 打标签逻辑消费的是「允许集合」visible；deny-shadow 消费的是其补集。

/**
 * 规范化技能 id 列表（去空白、去重、保持顺序）。
 * @param {Iterable<string>|undefined|null} list
 * @returns {string[]}
 */
export function normalizeSkillIds(list) {
	const out = [];
	for (const raw of list ?? []) {
		const s = String(raw ?? "").trim();
		if (s !== "" && !out.includes(s)) out.push(s);
	}
	return out;
}

/**
 * 标签条件是否为「有筛选」。空 OR 集合 + 空 AND 组 = 无筛选 = 全部技能。
 * @param {{orTags?:string[], andGroups?:{tagIds:string[]}[]}|undefined|null} config
 * @returns {boolean}
 */
export function hasFilter(config) {
	const or = config?.orTags?.length ?? 0;
	const groups = config?.andGroups?.length ?? 0;
	return or > 0 || groups > 0;
}

/**
 * 工作区条件里出现过的全部标签 id（工作区级视角下这些标签都视为"生效"，
 * 会话级生效集合另由 conversations.candidates 处理）。
 * @param {{orTags?:string[], andGroups?:{tagIds:string[]}[]}|undefined|null} config
 * @returns {Set<string>}
 */
export function activeTagsOf(config) {
	const active = new Set(config?.orTags ?? []);
	for (const g of config?.andGroups ?? []) for (const t of g.tagIds ?? []) active.add(t);
	return active;
}

/**
 * 计算工作区技能视图。
 *
 * @param {Object} p
 * @param {{orTags:string[], andGroups:{groupId:string,tagIds:string[]}[]}} p.config
 * @param {string[]} [p.manualSkills]     手动添加的技能名
 * @param {string[]} [p.disabledSkills]   被禁用的技能名
 * @param {string[]} [p.candidates]       标签规则命中的技能名（hasFilter 为真时有效）
 * @param {string[]} [p.universe]         本机/本工作区可发现的全部技能名
 * @returns {{hasFilter:boolean, matched:string[], manual:string[], disabled:string[], visible:string[]}}
 */
export function workspaceSkillView({ config, manualSkills, disabledSkills, candidates, universe }) {
	const disabled = normalizeSkillIds(disabledSkills);
	const manual = normalizeSkillIds(manualSkills);
	const filter = hasFilter(config);
	// 有筛选 → 只认标签命中的；无筛选 → 全部技能
	const base = filter ? normalizeSkillIds(candidates) : normalizeSkillIds(universe);

	const visible = [];
	const matched = [];
	for (const id of base) {
		if (disabled.includes(id)) continue;
		if (!matched.includes(id)) matched.push(id);
		if (!visible.includes(id)) visible.push(id);
	}
	// 手动添加的技能并进来（禁用的仍然排除）
	const manualVisible = [];
	for (const id of manual) {
		if (disabled.includes(id)) continue;
		manualVisible.push(id);
		if (!visible.includes(id)) visible.push(id);
	}
	return { hasFilter: filter, matched, manual: manualVisible, disabled, visible };
}

/**
 * 该工作区应被 deny-shadow（真正屏蔽）的技能名集合。
 * denied = universe − visible，再并上 disabled（禁用的名字即使不在 universe 里也要屏蔽）。
 *
 * @param {Object} p  同 workspaceSkillView
 * @returns {Set<string>}
 */
export function workspaceDeniedSkills(p) {
	const view = workspaceSkillView(p);
	const allowed = new Set(view.visible);
	const denied = new Set();
	for (const id of normalizeSkillIds(p?.universe)) if (!allowed.has(id)) denied.add(id);
	for (const id of view.disabled) denied.add(id);
	return denied;
}

/**
 * 路径规范化（Windows 大小写不敏感、分隔符不敏感、去尾部分隔符）。
 * 用于把会话 cwd 绑定到工作区记录。
 * @param {string|undefined|null} p
 * @returns {string}
 */
export function normalizeWorkspacePath(p) {
	const s = String(p ?? "").trim();
	if (s === "") return "";
	return s.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
