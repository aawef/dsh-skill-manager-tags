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
 * 把「标签选出的可见集合」再按**宿主的下发口径**切一刀。
 *
 * 背景（2026-11-02 用户报告的 64 vs 48）：右列长期只有一层「标签过滤」，
 * 而模型侧拿到的是 `snapshot().skills.filter(isModelInvocable)` —— 两道闸：
 *   ​① frontmatter 的 `disable-model-invocation: true`（只能 `/name` 手动调用）
 *   ​② 宿主根本不认识的名字（插件自扫描补进来的，宿主 registry 里没有）
 * 于是「右列 N 条」永远大于「模型实际 N 条」。这里把口径拆开，不再让前端
 * 把两者混成一个数字。
 *
 * 注意：这**只影响展示口径**。deny-shadow 的分母仍是 world universe − visible，
 * 不能拿 modelVisible 去算，否则那些只能手动调用的技能会重新变回可见。
 *
 * @param {string[]} visible 标签口径下的可见技能名
 * @param {Array<{name:string, invocation?:{modelInvocable?:boolean}, registered?:boolean}>} [catalog]
 *        技能目录（宿主快照 ∪ 自扫描兜底的合并结果）
 * @returns {{modelVisible:string[], userOnly:{name:string, reason:string}[], unregistered:string[]}}
 */
export function splitModelVisible(visible, catalog = []) {
	const byName = new Map();
	for (const s of catalog ?? []) {
		const name = typeof s === "string" ? s : s?.name;
		if (name) byName.set(name, typeof s === "string" ? { name } : s);
	}
	const modelVisible = [];
	const userOnly = [];
	const unregistered = [];
	for (const name of normalizeSkillIds(visible)) {
		const entry = byName.get(name);
		// 自扫描兜底补进来的名字：宿主 registry 里没有 → 模型侧根本不存在
		if (entry && entry.registered === false) { unregistered.push(name); continue; }
		if (entry?.invocation?.modelInvocable === false) {
			userOnly.push({ name, reason: "disable-model-invocation" });
			continue;
		}
		modelVisible.push(name);
	}
	return { modelVisible, userOnly, unregistered };
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
