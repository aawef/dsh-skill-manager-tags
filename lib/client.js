// skill-tag-plugin — client half: settings-page tab (React, rc.5 two-arg register)
//
// Protocol facts (guide-ui, source-verified):
//  - window.__ModuleLoader__.load({ id, factory }); factory(require) returns exports.
//  - slots.register(options, ReactComponent) — TWO args, second is a React component.
//  - slots.inject('settings.section', () => slots.register(...)) with ctx.effect.
//  - fetch relative paths: /skill-tag/api/... (same origin as host).
//  - client.js is served no-cache: page refresh picks changes up, no restart.

window.__ModuleLoader__.load({
	id: "dsh-skill-tag",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];
		const API = "/skill-tag/api";

		// ── api helpers ────────────────────────────────────────────────
		async function apiGet(path) {
			const r = await fetch(API + path, { credentials: "same-origin" });
			return r.json();
		}
		async function apiPost(path, body) {
			const r = await fetch(API + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify(body ?? {}),
			});
			return r.json();
		}

		// ── pure view-model helpers ────────────────────────────────────
		//
		// fmtLocalTime：把服务端存的 ISO-8601（**始终是 UTC，带 Z**）渲染成本地
		// 时间。曾经这里直接 `String(iso).replace("T", " ").slice(0, 19)`——
		// slice(0,19) 把结尾的 Z 连同时区信息一起切掉了，于是 UTC 被当成本地
		// 时间显示，东八区整整偏 8 小时（"凌晨 2 点"其实是上午 10 点）。
		// 一律走 Date 解析 + 本地字段拼接，不做字符串截断。
		function fmtLocalTime(iso) {
			if (iso === null || iso === undefined || iso === "") return "";
			const d = new Date(iso);
			if (Number.isNaN(d.getTime())) return String(iso); // 非法值原样显示，不编造时间
			const p = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
				+ `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		}

		// ── 失效技能（stale）的判定与分区 ──────────────────────────────
		//
		// 「失效」= 有标签关联，但**这次发现不到**（通常是贡献它的插件被关闭）。
		// 服务端在 GET /skills 里把这类记录放在 stale 数组里报告，不删数据。
		//
		// 三处界面共用这一套判定，保证口径一致：
		//   · skill 联系 tag（技能清单）：失效项置底 + 标红
		//   · 主页面标签列表（TagList）：含失效技能的**标签名**标红
		//   · tag 联系 skill（左列标签）：同上；右列技能列表失效项置底 + 标红

		/** 失效技能名集合（来自 /skills 的 stale 报告）。 */
		function staleSetOf(state) {
			return new Set((state?.stale ?? []).map((s) => s?.skillId).filter(Boolean));
		}

		/** 这个标签是否含至少一个失效技能（决定标签名要不要标红）。 */
		function tagHasStale(links, tagId, staleSet) {
			if (!staleSet || staleSet.size === 0) return false;
			return (links ?? []).some((l) => (l.tagIds ?? []).includes(tagId) && staleSet.has(l.skillId));
		}

		/**
		 * 技能名分区：存活在前、失效在后，**各分区内部保持原顺序**。
		 * 稳定分区（不是排序），所以用户看到的相对次序不会因为标红而跳动。
		 * @param {Array<{skillId:string}|string>} items
		 * @param {Set<string>} staleSet
		 * @param {(x:any)=>string} nameOf
		 */
		function partitionStaleSkills(items, staleSet, nameOf = (x) => (typeof x === "string" ? x : x?.skillId)) {
			const alive = [];
			const stale = [];
			for (const it of items ?? []) (staleSet.has(nameOf(it)) ? stale : alive).push(it);
			return { alive, stale };
		}

		/** 失效技能的统一配色（与「全局删除」的红一致，但更暗一点，避免抢眼）。 */
		const STALE_COLOR = "#e74c3c";

		// zoneOf: §7 four-zone classification of a conversation tag entry.
		function zoneOf(entry) {
			if (entry.blocked) return "blocked";
			if (entry.exempt) return "exempt";
			if (entry.load === "unloaded") return "unloaded";
			return "loaded";
		}
		const ZONE_LABEL = { loaded: "加载", exempt: "豁免", unloaded: "未加载", blocked: "屏蔽" };

		/** flat list of rows for the conversation editor */
		function conversationRows(conv) {
			const rows = [];
			for (const [tagId, entry] of Object.entries(conv.tags ?? {})) {
				rows.push({ tagId, zone: zoneOf(entry), managed: entry.managed ?? "none", source: entry.workspaceSource ?? null });
			}
			rows.sort((a, b) => a.tagId.localeCompare(b.tagId));
			return rows;
		}

		/** display a workspace config compactly */
		function configSummary(config) {
			const or = config?.orTags ?? [];
			const groups = (config?.andGroups ?? []).map((g) => "(" + g.tagIds.join(" AND ") + ")");
			return [...or, ...groups].join(" OR ") || "∅";
		}

		/** tagName lookup: tagId -> name (UI displays names, wire carries ids) */
		function tagNameOf(data, tagId) {
			return data.tags?.find((t) => t.tagId === tagId)?.name ?? tagId;
		}

		/**
		 * 渲染表达式字面量：名称含空格/运算符/括号/路径分隔等时用双引号包裹，
		 * 与服务端 src/domain/expr.js 的 quoteName 保持一致（客户端只做插入文本）。
		 */
		function quoteTagName(name) {
			const s = String(name ?? "");
			const needQuote = s === "" || /[\s()*+"'\uFF08\uFF09\uFF0B\uFF0A]/.test(s) || /[\uFF01-\uFF60\uFFE0-\uFFEE]/.test(s);
			if (!needQuote) return s;
			return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
		}

		/** tag chips of a config in display form ("name OR (a AND b)") */
		function configDisplay(data, config) {
			const or = (config?.orTags ?? []).map((id) => tagNameOf(data, id));
			const groups = (config?.andGroups ?? []).map((g) => "(" + g.tagIds.map((id) => tagNameOf(data, id)).join(" AND ") + ")");
			return [...or, ...groups].join(" OR ") || "∅";
		}

		/** skillIds currently linked to a tag (link records whose tagIds contain it) */
		function skillsLinkedTo(links, tagId) {
			if (!tagId) return [];
			return links.filter((l) => l.tagIds.includes(tagId)).map((l) => ({ skillId: l.skillId, ghost: false }));
		}

		/** skills NOT linked to the tag: scanned ones first, then link-only ghosts */
		function skillsNotLinkedTo(links, tagId, skills) {
			const linked = new Set(skillsLinkedTo(links, tagId).map((s) => s.skillId));
			const seen = new Set();
			const out = [];
			for (const s of skills ?? []) {
				if (!linked.has(s.name) && !seen.has(s.name)) { out.push({ skillId: s.name, ghost: false }); seen.add(s.name); }
			}
			for (const l of links ?? []) {
				if (!linked.has(l.skillId) && !seen.has(l.skillId)) { out.push({ skillId: l.skillId, ghost: true }); seen.add(l.skillId); }
			}
			return out;
		}

		/**
		 * 「技能已有的标签排前面」：稳定分区，不改变各分区内部的原有顺序。
		 * 只排显示顺序——勾选状态与写库内容都不受影响。
		 * @param {Array<{tagId:string}>} tags 全部标签（顺序来自服务端）
		 * @param {Iterable<string>} ownedIds 该技能已拥有的 tagId
		 */
		function ownedTagsFirst(tags, ownedIds) {
			const owned = new Set(ownedIds ?? []);
			const yes = [];
			const no = [];
			for (const t of tags ?? []) (owned.has(t?.tagId) ? yes : no).push(t);
			return [...yes, ...no];
		}

		// ── 「打开技能所在文件夹」 ────────────────────────────────────
		// 宿主没有给插件 reveal API，服务端由 src/reveal.js 拉起文件管理器。
		// 这里只负责：名字 → 绝对路径（扫描结果自带 path）、发请求、缺路径时
		// 退回按名字让服务端再查一次（UI 手里没有 path 的场合也能用）。
		function skillPathOf(skills, name) {
			const hit = (skills ?? []).find((s) => (typeof s === "string" ? s === name : s?.name === name));
			return typeof hit === "string" || !hit ? null : hit.path ?? null;
		}

		async function openSkillFolder(skillName, skills, explicitPath) {
			const path = explicitPath ?? skillPathOf(skills, skillName);
			let d;
			try {
				d = await apiPost("/skills/reveal", path ? { path } : { skillName });
			} catch (e) {
				d = { ok: false, error: String(e?.message ?? e) };
			}
			if (!d?.ok) {
				const msg = "打开技能文件夹失败: " + (d?.error ?? "未知错误");
				if (typeof window !== "undefined" && typeof window.alert === "function") window.alert(msg);
				return d;
			}
			return d;
		}

		/** 通用「打开所在文件夹」按钮：插件内所有列出技能的位置复用同一个。 */
		function RevealButton({ skillName, skills, path, label, style }) {
			const known = !!(path ?? skillPathOf(skills, skillName));
			return react.createElement("button", {
				style: { ...btn, padding: "1px 7px", fontSize: "11px", ...(style ?? {}) },
				title: known
					? "在文件管理器中显示该技能的 SKILL.md"
					: "本机扫描结果里没有该技能文件（仍会按名称再查一次）",
				"data-skill-tag-reveal": skillName,
				onClick: (e) => {
					if (e?.stopPropagation) e.stopPropagation();
					// 返回 promise 便于测试 await；React 会忽略事件处理器的返回值
					return openSkillFolder(skillName, skills, path);
				},
			}, label ?? "📁 打开文件夹");
		}

		// ── components ─────────────────────────────────────────────────
		function Section() {
			const [state, setState] = react.useState({
				loading: true, error: null, data: null, skills: [],
				// stale = 有标签关联、但当前发现不到的技能（贡献它的插件被关了）。
				// 只标记，不自动删除 —— 用户显式点「清理失效关联」才动数据。
				stale: [],
				newTagName: "", busy: false, notice: null,
				// sub-page routing: "main" | "links" | "skilltags" | "templates"
				view: "main",
				// link page state: selected tag + per-panel search + add-select
				linkTagId: null, tagSearch: "", skillSearch: "", pickOpen: false, pickSearch: "",
				// skill→tag page state: selected skill + its tag search / add-select
				linkSkillName: null, skillTagSearch: "", skillPickSearch: "", skillTagPickOpen: false,
				// workspace editor
				wsId: "", wsDraft: null,
				// conversation editor
				convId: "", convWsId: "",
				// tag list: per-tag collapsed/expanded (undefined = collapsed)
				openTags: {},
				// 标签组配置页: 选中 id / 是否新建 / 名称 / 表达式文本
				tplId: null, tplIsNew: false, tplName: "", tplExpression: "",
			});
			const reload = react.useCallback(async () => {
				try {
					const [d, sk] = await Promise.all([apiGet("/state"), apiGet("/skills")]);
					setState((s) => ({
						...s,
						loading: false,
						error: d?.ok ? null : JSON.stringify(d),
						data: d?.ok ? d : null,
						skills: sk?.ok ? sk.skills : [],
						stale: sk?.ok ? (sk.stale ?? []) : [],
					}));
				} catch (e) {
					setState((s) => ({ ...s, loading: false, error: String(e), data: null }));
				}
			}, []);
			react.useEffect(() => { void reload(); }, [reload]);

			const act = react.useCallback(async (path, body, okNote) => {
				setState((s) => ({ ...s, busy: true }));
				try {
					const d = await apiPost(path, body);
					if (!d?.ok) throw new Error(d?.error ?? JSON.stringify(d));
					setState((s) => ({ ...s, busy: false, notice: okNote ?? "完成", newTagName: "" }));
					await reload();
					return d;
				} catch (e) {
					setState((s) => ({ ...s, busy: false, notice: "失败: " + (e?.message ?? e) }));
					return null;
				}
			}, [reload]);

			/**
			 * 刷新技能列表：重新问宿主一次当前真正可见的技能。
			 * 用于「贡献技能的插件被关掉/打开」之后同步界面 —— 这类技能不落在任何
			 * 文件系统根里，只能靠宿主注册表发现，插件启动后不会自动感知变化。
			 */
			const refreshSkills = react.useCallback(async () => {
				setState((s) => ({ ...s, busy: true, notice: null }));
				try {
					await reload();
					setState((s) => ({ ...s, busy: false, notice: `技能列表已刷新：${(s.skills ?? []).length} 个可见技能` }));
				} catch (e) {
					setState((s) => ({ ...s, busy: false, notice: "刷新失败: " + (e?.message ?? e) }));
				}
			}, [reload]);

			/**
			 * 清理失效关联（显式、可取消）：只删「有标签、但当前发现不到」的记录。
			 * 服务端在发现结果为空时会拒绝执行（避免宿主未就绪时误删全部）。
			 */
			const purgeStale = react.useCallback(async () => {
				const list = state.stale ?? [];
				if (list.length === 0) return;
				const names = list.map((s) => s.skillId);
				const preview = names.slice(0, 8).join("\u3001") + (names.length > 8 ? ` 等 ${names.length} 个` : "");
				if (!window.confirm(`清理 ${names.length} 条失效关联？\n\n${preview}\n\n这些技能当前发现不到（通常是贡献它的插件被关闭）。清理后它们的标签关联会删除；若之后重新启用那个插件，需要重新打标签。`)) return;
				setState((s) => ({ ...s, busy: true, notice: null }));
				try {
					const d = await apiPost("/skills/purge-stale", { skillIds: names });
					if (!d?.ok) throw new Error(d?.error ?? JSON.stringify(d));
					await reload();
					setState((s) => ({ ...s, busy: false, notice: `已清理 ${d.count ?? 0} 条失效关联` }));
				} catch (e) {
					setState((s) => ({ ...s, busy: false, notice: "清理失败: " + (e?.message ?? e) }));
				}
			}, [state.stale, reload]);

			const { loading, error, data, busy, notice } = state;
			if (loading) return react.createElement("div", { style: pad }, "加载中…");
			if (error) return react.createElement("div", { style: pad }, "加载失败: " + error);
			if (!data) return react.createElement("div", { style: pad }, "无数据");

			// sub-page: full-width tag→skill link manager
			if (state.view === "links") {
				return react.createElement(SkillLinkPage, { key: "links", data, state, setState, act, busy });
			}
			// sub-page: full-width skill→tag link manager（反向视角）
			if (state.view === "skilltags") {
				return react.createElement(SkillTagPage, { key: "skilltags", data, state, setState, act, busy });
			}
			// sub-page: full-width tag-group (template) editor
			if (state.view === "templates") {
				return react.createElement(TemplateGroupPage, { key: "templates", data, state, setState, act, busy });
			}

			return react.createElement("div", { style: { ...pad, maxWidth: "960px" } }, [
				react.createElement("h3", { key: "h" }, "Skill 标签管理"),
				notice && react.createElement("div", { key: "n", style: noteStyle }, notice),
				react.createElement("div", { key: "nav", style: { marginBottom: "12px", display: "flex", gap: "8px", flexWrap: "wrap" } },
					react.createElement("button", {
						style: { ...btn, padding: "6px 16px", fontSize: "13px" },
						title: "从标签出发：选中一个标签，管理它关联了哪些技能",
						onClick: () => setState((s) => ({ ...s, view: "links" })),
					}, "tag 联系 skill"),
					react.createElement("button", {
						style: { ...btn, padding: "6px 16px", fontSize: "13px" },
						title: "从技能出发：选中一个技能，编辑它拥有哪些标签",
						onClick: () => setState((s) => ({ ...s, view: "skilltags", linkSkillName: null, skillPickSearch: "", skillTagSearch: "" })),
					}, "skill 联系 tag"),
					react.createElement("button", {
						style: { ...btn, padding: "6px 16px", fontSize: "13px" },
						onClick: () => setState((s) => ({ ...s, view: "templates", tplId: null, tplIsNew: false, tplName: "", tplExpression: "" })),
					}, "编辑标签组"),
					// 刷新技能列表：贡献技能的插件被关闭/打开后界面不会自动感知，
					// 这里显式重新问宿主一次（这类技能不落在任何文件系统根里）。
					react.createElement("button", {
						key: "refresh",
						style: { ...btn, padding: "6px 16px", fontSize: "13px" },
						disabled: busy,
						title: "重新向宿主查询当前真正可用的技能（插件被关闭后用它同步列表）",
						"data-skill-tag-refresh": "1",
						onClick: () => void refreshSkills(),
					}, "刷新技能列表")),
				// 失效关联提示条：有标签、但当前发现不到的技能。
				// 只提示不自动删；给一个显式清理入口（点击会二次确认）。
				!loading && (state.stale ?? []).length > 0 && react.createElement("div", {
					key: "stale",
					style: { background: "rgba(230,126,34,0.12)", border: "1px solid rgba(230,126,34,0.4)", borderRadius: "8px", padding: "8px 10px", marginBottom: "12px", fontSize: "12px", color: "#e67e22", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" },
				}, [
					react.createElement("span", { key: "t", style: { flex: 1 } },
						`有 ${(state.stale ?? []).length} 个技能仍有标签关联，但当前发现不到（通常是贡献它的插件被关闭）。`),
					react.createElement("button", {
						key: "p",
						style: { ...btn, padding: "2px 10px", fontSize: "12px", color: "#e67e22" },
						disabled: busy,
						"data-skill-tag-purge": "1",
						onClick: () => void purgeStale(),
					}, "清理失效关联")]),
				react.createElement(TagCreateForm, { key: "create", state, setState, act, busy }),
				react.createElement(TagList, { key: "list", data, act, busy, state, setState }),
			]);
		}

		const pad = { fontFamily: "ui-sans-serif,system-ui", fontSize: "13px", padding: "14px 16px" };
		const noteStyle = { padding: "6px 10px", borderRadius: "6px", background: "var(--theme-bg-tertiary,#223)", marginBottom: "10px", whiteSpace: "pre-wrap" };
		const card = { border: "1px solid var(--theme-border,#333)", borderRadius: "10px", padding: "10px 12px", marginBottom: "12px" };
		const btn = { padding: "3px 10px", borderRadius: "6px", border: "1px solid var(--theme-border,#444)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12px" };
		const input = { padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--theme-border,#444)", background: "transparent", color: "inherit", fontSize: "12px" };
		const thTd = { border: "1px solid var(--theme-border,#333)", padding: "4px 8px" };
		const zoneColor = { loaded: "#2ecc71", exempt: "#3498db", unloaded: "#888", blocked: "#e74c3c" };

		function TagCreateForm({ state, setState, act, busy }) {
			return react.createElement("div", { style: card }, [
				react.createElement("div", { key: "t", style: { fontWeight: 600, marginBottom: "6px" } }, "新建标签"),
				react.createElement("div", { key: "row", style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } }, [
					react.createElement("input", {
						key: "name", style: input, placeholder: "标签名称",
						value: state.newTagName,
						onChange: (e) => setState((s) => ({ ...s, newTagName: e.target.value })),
					}),
					react.createElement("button", {
						key: "go", style: btn, disabled: busy || !state.newTagName.trim(),
						onClick: () => act("/tags", { tagId: "t-" + Date.now().toString(36), name: state.newTagName.trim() }, "标签已创建"),
					}, "创建"),
				]),
			]);
		}

		function TagList({ data, act, busy, state, setState }) {
			const tags = data.tags ?? [];
			const links = data.skillLinks ?? [];
			const workspaces = data.workspaces ?? [];
			const catalog = state.skills ?? [];
			// 失效技能集合：决定"哪些标签名要标红"以及"展开后哪些名字置底标红"。
			const staleSet = staleSetOf(state);
			// 每个标签默认折叠，只显示数量；点「▸」才展开下面的技能名。
			// 本机 96 个技能 / 34 个标签，全展开会让这一页变成几百行的墙。
			const open = state.openTags ?? {};
			const toggleOpen = (tagId) => setState((s) => ({
				...s,
				openTags: { ...(s.openTags ?? {}), [tagId]: !(s.openTags ?? {})[tagId] },
			}));
			return react.createElement("div", { style: card }, [
				react.createElement("div", { key: "t", style: { fontWeight: 600, marginBottom: "6px" } }, `标签 (${tags.length})`),
				tags.length === 0 && react.createElement("div", { key: "empty", style: { color: "#888" } }, "暂无标签"),
				...tags.map((t) => {
					const skills = links.filter((l) => l.tagIds.includes(t.tagId)).map((l) => l.skillId);
					// 标签内技能分区：存活在前、失效在后（分区稳定，内部保序）
					const split = partitionStaleSkills(skills, staleSet, (x) => x);
					const hasStale = split.stale.length > 0;
					const usedBy = workspaces.filter((w) => (w.config?.orTags ?? []).includes(t.tagId) || (w.config?.andGroups ?? []).some((g) => g.tagIds.includes(t.tagId))).map((w) => w.workspaceId);
					const isOpen = !!open[t.tagId];
					return react.createElement("div", { key: t.tagId, style: { padding: "4px 0", borderBottom: "1px solid var(--theme-border,#222)" } }, [
						react.createElement("div", { key: "row", style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } }, [
							skills.length === 0
								? react.createElement("span", { key: "tw", style: { width: "14px", display: "inline-block" } })
								: react.createElement("button", {
									key: "tw",
									style: { ...btn, padding: "0 4px", fontSize: "10px", border: "none", background: "transparent" },
									title: isOpen ? "收起技能列表" : "展开技能列表",
									"data-skill-tag-toggle": t.tagId,
									onClick: () => toggleOpen(t.tagId),
								}, isOpen ? "▾" : "▸"),
							// 标签名：含失效技能时标红（图二/图三的要求 —— 只标红标签本身，
							// 让用户一眼看出"这个标签关联到了已消失的技能"）。
							react.createElement("span", {
								key: "n",
								style: { fontWeight: 500, ...(hasStale ? { color: STALE_COLOR } : {}) },
								title: hasStale ? `该标签含 ${split.stale.length} 个失效技能（当前发现不到）` : undefined,
								"data-skill-tag-stale-tag": hasStale ? t.tagId : undefined,
							}, t.name),
							react.createElement("span", { key: "id", style: { color: "#888", fontSize: "11px" } }, t.tagId),
							react.createElement("span", {
								key: "cnt", style: { color: "#888", fontSize: "11px" },
								"data-skill-tag-count": t.tagId,
							}, skills.length === 0
								? "无 Skill 关联"
								: `${skills.length} 个 Skill` + (hasStale ? `（${split.stale.length} 失效）` : "")),
							react.createElement("button", {
								key: "del", style: { ...btn, color: "#e74c3c" }, disabled: busy,
								onClick: () => {
									const msg = usedBy.length ? `该标签被工作区使用: ${usedBy.join(", ")}。全局删除将清理所有引用, 确定?` : "全局删除该标签? 所有引用将被清理。";
									if (window.confirm(msg)) void act("/tags/delete", { tagId: t.tagId }, "已删除(工作区引用已清理)");
								},
							}, "全局删除"),
						]),
						// 展开后才列出技能（每行仍带「打开文件夹」，这里也是"列出 skill 的界面"）
						isOpen && skills.length > 0 && react.createElement("div", { key: "sk", style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", fontSize: "11px", color: "#888", padding: "4px 0 2px 22px" } }, [
							// 存活技能在前
							...split.alive.map((sid, i) => react.createElement("span", { key: sid + i, style: { display: "inline-flex", gap: "2px", alignItems: "center" } }, [
								sid,
								react.createElement(RevealButton, { key: "rev", skillName: sid, path: skillPathOf(catalog, sid), label: "📁", style: { padding: "0 4px", fontSize: "10px" } }),
							])),
							// 失效技能置底：标红、删除线、不给 📁（本机没有该文件，点了必然失败）
							...split.stale.map((sid, i) => react.createElement("span", {
								key: "st" + i,
								style: { display: "inline-flex", gap: "2px", alignItems: "center", color: STALE_COLOR, textDecoration: "line-through" },
								title: "失效技能：当前发现不到（通常是贡献它的插件被关闭）。标签关联仍保留。",
								"data-skill-tag-stale-skill": sid,
							}, [sid])),
						]),
					]);
				}),
			]);
		}

		// Add-link modal: multi-select skills for the selected tag (§4.2).
		// z-index 900 band per guide-ui (settings overlay sits at 1000).
		function SkillPickerModal({ data, state, setState, act, busy }) {
			const selId = state.linkTagId;
			const sel = (data.tags ?? []).find((t) => t.tagId === selId);
			const all = skillsNotLinkedTo(data.skillLinks ?? [], selId, state.skills ?? [])
				.filter((s) => !state.pickSearch.trim() || s.skillId.toLowerCase().includes(state.pickSearch.trim().toLowerCase()));
			const [picked, setPicked] = react.useState(() => new Set());
			const toggle = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
			const overlay = { position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" };
			const box = { width: "560px", maxWidth: "92vw", maxHeight: "70vh", display: "flex", flexDirection: "column", background: "var(--theme-bg-secondary,#1a1f2e)", border: "1px solid var(--theme-border,#444)", borderRadius: "12px", padding: "14px 16px", boxShadow: "0 8px 30px rgba(0,0,0,0.5)" };
			const row = { display: "flex", alignItems: "center", gap: "8px", padding: "6px 4px", borderBottom: "1px solid var(--theme-border,#222)", fontSize: "12px", cursor: "pointer" };
			// 每行 = 勾选区 + 「打开文件夹」，所以行本身不再是 <label>
			const rrow = { ...row, cursor: "default" };
			const confirm = async () => {
				for (const id of picked) {
					const rec = (data.skillLinks ?? []).find((l) => l.skillId === id);
					const next = [...new Set([...(rec?.tagIds ?? []), selId])];
					const ok = await act("/tags/link", { skillId: id, tagIds: next }, `已关联 ${picked.size} 个 Skill`);
					if (!ok) break;
				}
				setState((s) => ({ ...s, pickOpen: false, pickSearch: "" }));
			};
			return react.createElement("div", { style: overlay, onMouseDown: (e) => { if (e.target === e.currentTarget) setState((s) => ({ ...s, pickOpen: false, pickSearch: "" })); } },
				react.createElement("div", { style: box, onClick: (e) => e.stopPropagation() }, [
					react.createElement("div", { key: "h", style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" } }, [
						react.createElement("strong", { key: "t" }, `添加关联 Skill — ${sel?.name ?? ""}`),
						react.createElement("button", { key: "x", style: btn, onClick: () => setState((s) => ({ ...s, pickOpen: false, pickSearch: "" })) }, "✕"),
					]),
					react.createElement("input", {
						key: "search", style: { ...input, width: "100%", marginBottom: "8px" }, placeholder: "搜索 Skill…", autoFocus: true,
						value: state.pickSearch, onChange: (e) => setState((s) => ({ ...s, pickSearch: e.target.value })),
					}),
					react.createElement("div", { key: "list", style: { flex: 1, overflowY: "auto", minHeight: "120px" } }, [
						all.length === 0 && react.createElement("div", { style: { color: "#888", fontSize: "12px", padding: "10px 2px" } }, "没有可添加的 Skill(全部已关联, 或本机未扫描到)"),
						...all.map((s) => {
							const ghost = s.ghost || !(state.skills ?? []).some((x) => x.name === s.skillId);
							return react.createElement("div", { key: s.skillId, style: rrow }, [
								react.createElement("label", { key: "l", style: { display: "flex", alignItems: "center", gap: "8px", flex: 1, cursor: "pointer" } }, [
									react.createElement("input", { key: "c", type: "checkbox", checked: picked.has(s.skillId), onChange: () => toggle(s.skillId) }),
									react.createElement("span", { key: "n", style: { flex: 1 } }, s.skillId + (ghost ? " *" : "")),
								]),
								!ghost && react.createElement(RevealButton, { key: "rev", skillName: s.skillId, skills: state.skills, label: "📁" }),
							]);
						}),
					]),
					react.createElement("div", { key: "f", style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "10px" } }, [
						react.createElement("span", { key: "cnt", style: { color: "#888", fontSize: "12px", marginRight: "auto" } }, picked.size ? `已选 ${picked.size} 个` : ""),
						react.createElement("button", { key: "c", style: btn, onClick: () => setState((s) => ({ ...s, pickOpen: false, pickSearch: "" })) }, "取消"),
						react.createElement("button", { key: "ok", style: { ...btn, color: "#2ecc71" }, disabled: busy || picked.size === 0, onClick: () => void confirm() }, `添加(${picked.size})`),
					]),
					(data.skillLinks ?? []).some((l) => !(state.skills ?? []).some((s) => s.name === l.skillId)) &&
						react.createElement("div", { key: "g", style: { color: "#888", fontSize: "11px", marginTop: "6px" } }, "* 未在本机扫描到的关联仍生效; 带星号项同样可以添加。"),
				]));
		}

		// ── Skill↔Tag link manager (§4.2) — full sub-page, two columns ───────
		// Left: existing tags (+create, +search, row-end delete).
		// Right: skills linked to the selected tag (+add, +search, row-end remove).
		function SkillLinkPage({ data, state, setState, act, busy }) {
			const { notice } = state;
			const tags = data.tags ?? [];
			const links = data.skillLinks ?? [];
			const skills = state.skills ?? [];
			const selId = state.linkTagId;
			const sel = tags.find((t) => t.tagId === selId) ?? null;
			const tagMatch = (t) => !state.tagSearch.trim() || t.name.toLowerCase().includes(state.tagSearch.trim().toLowerCase());
			const skillMatch = (s) => !state.skillSearch.trim() || s.skillId.toLowerCase().includes(state.skillSearch.trim().toLowerCase());
			// 失效技能集合：标签名标红 + 右列技能列表分区（存活在前、失效置底标红）
			const staleSet = staleSetOf(state);
			const linkedSkills = skillsLinkedTo(links, selId).filter(skillMatch);
			const linkedSplit = partitionStaleSkills(linkedSkills, staleSet);
			const createTag = async () => {
				const name = state.newTagName.trim();
				if (!name) return;
				const d = await act("/tags", { tagId: "t-" + Date.now().toString(36), name }, "标签已创建");
				if (d) setState((s) => ({ ...s, newTagName: "" }));
			};
			const removeSkill = async (skillId) => {
				// remove this tag from the skill's link record (other tags stay)
				const rec = links.find((l) => l.skillId === skillId);
				const next = (rec?.tagIds ?? []).filter((x) => x !== selId);
				await (next.length === 0
					? act("/tags/unlink", { skillId }, `已移除 ${skillId}`)
					: act("/tags/link", { skillId, tagIds: next }, `已移除 ${skillId}`));
			};
			const colStyle = { flex: "1 1 0", minWidth: "260px", border: "1px solid var(--theme-border,#333)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column" };
			const rowStyle = { display: "flex", gap: "8px", alignItems: "center", padding: "5px 4px", borderBottom: "1px solid var(--theme-border,#222)", fontSize: "12px" };
			const selRowStyle = { ...rowStyle, background: "var(--theme-bg-tertiary,#2a3350)", borderRadius: "6px" };
			return react.createElement("div", { style: { ...pad, maxWidth: "960px" } }, [
				react.createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" } }, [
					react.createElement("button", { key: "back", style: btn, disabled: busy, onClick: () => setState((s) => ({ ...s, view: "main", linkTagId: null })) }, "← 返回"),
					react.createElement("h3", { key: "t", style: { margin: 0 } }, "tag 联系 skill"),
					sel && react.createElement("span", { key: "cur", style: { color: "#888", fontSize: "12px" } }, `当前标签: ${sel.name}`),
				]),
				notice && react.createElement("div", { key: "n", style: noteStyle }, notice),
				react.createElement("div", { key: "cols", style: { display: "flex", gap: "12px", alignItems: "flex-start" } }, [
					// ── left column: tags ──────────────────────────────────────
					react.createElement("div", { key: "left", style: colStyle }, [
						react.createElement("div", { key: "lt", style: { fontWeight: 600, marginBottom: "6px" } }, `标签 (${tags.length})`),
						react.createElement("input", {
							key: "search", style: { ...input, width: "100%", marginBottom: "6px" }, placeholder: "搜索标签…",
							value: state.tagSearch, onChange: (e) => setState((s) => ({ ...s, tagSearch: e.target.value })),
						}),
						react.createElement("div", { key: "rows", style: { maxHeight: "420px", overflowY: "auto" } }, [
							tags.filter(tagMatch).length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px", padding: "6px 2px" } }, "无匹配标签"),
							...tags.filter(tagMatch).map((t) => {
								const n = links.filter((l) => l.tagIds.includes(t.tagId)).length;
								// 含失效技能的标签：只把**标签名**标红（图三的要求），其余样式不变
								const hasStale = tagHasStale(links, t.tagId, staleSet);
								return react.createElement("div", {
									key: t.tagId, style: t.tagId === selId ? selRowStyle : rowStyle,
									onClick: () => setState((s) => ({ ...s, linkTagId: t.tagId })),
									title: hasStale ? "该标签含失效技能（当前发现不到），点开可见" : "点击选中",
								}, [
									react.createElement("span", {
										key: "n",
										style: { fontWeight: t.tagId === selId ? 600 : 400, flex: 1, cursor: "pointer", ...(hasStale ? { color: STALE_COLOR } : {}) },
										"data-skill-tag-stale-tag": hasStale ? t.tagId : undefined,
									}, t.name),
									react.createElement("span", { key: "c", style: { color: "#888", fontSize: "11px" } }, n ? `${n} skill` : ""),
									react.createElement("button", {
										key: "del", style: { ...btn, color: "#e74c3c", padding: "1px 8px" }, disabled: busy,
										onClick: (e) => {
											e.stopPropagation();
											const usedBy = (data.workspaces ?? []).filter((w) => (w.config?.orTags ?? []).includes(t.tagId) || (w.config?.andGroups ?? []).some((g) => g.tagIds.includes(t.tagId))).map((w) => w.workspaceId);
											const msg = usedBy.length ? `该标签被工作区使用: ${usedBy.join(", ")}。全局删除将清理所有引用, 确定?` : "全局删除该标签? 所有引用将被清理。";
											if (window.confirm(msg)) {
												void act("/tags/delete", { tagId: t.tagId }, "已删除").then(() => {
													setState((s) => ({ ...s, linkTagId: s.linkTagId === t.tagId ? null : s.linkTagId }));
												});
											}
										},
									}, "删除"),
								]);
							}),
						]),
						react.createElement("div", { key: "create", style: { display: "flex", gap: "8px", marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--theme-border,#222)" } }, [
							react.createElement("input", {
								key: "name", style: { ...input, flex: 1 }, placeholder: "新标签名称",
								value: state.newTagName, onChange: (e) => setState((s) => ({ ...s, newTagName: e.target.value })),
								onKeyDown: (e) => { if (e.key === "Enter") void createTag(); },
							}),
							react.createElement("button", { key: "go", style: btn, disabled: busy || !state.newTagName.trim(), onClick: () => void createTag() }, "创建标签"),
						]),
					]),
					// ── right column: skills of the selected tag ──────────────
					react.createElement("div", { key: "right", style: colStyle }, [
						react.createElement("div", { key: "rt", style: { fontWeight: 600, marginBottom: "6px" } }, sel ? `关联 Skill — ${sel.name}` : "关联 Skill"),
						!sel && react.createElement("div", { key: "hint", style: { color: "#888", fontSize: "12px", padding: "8px 0" } }, "← 先在左侧选中一个标签"),
						sel && react.createElement(react.Fragment, { key: "panel" }, [
							react.createElement("input", {
								key: "search", style: { ...input, width: "100%", marginBottom: "6px" }, placeholder: "搜索 Skill…",
								value: state.skillSearch, onChange: (e) => setState((s) => ({ ...s, skillSearch: e.target.value })),
							}),
							react.createElement("div", { key: "rows", style: { maxHeight: "340px", overflowY: "auto" } }, [
								linkedSkills.length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px", padding: "6px 2px" } }, "该标签暂未关联任何 Skill"),
								// 存活技能在前
								...linkedSplit.alive.map((s) => {
									const ghost = !skills.some((x) => x.name === s.skillId);
									return react.createElement("div", { key: s.skillId, style: rowStyle, title: ghost ? "未在本机扫描到(关联仍生效)" : "" }, [
										react.createElement("span", { key: "n", style: { flex: 1 } }, s.skillId + (ghost ? " *" : "")),
										react.createElement(RevealButton, { key: "rev", skillName: s.skillId, skills }),
										react.createElement("button", {
											key: "rm", style: { ...btn, color: "#e67e22", padding: "1px 8px" }, disabled: busy,
											onClick: () => void removeSkill(s.skillId),
										}, "移除"),
									]);
								}),
								// 失效技能置底：名字标红 + 删除线；不给 📁（本机没有该文件）
								...linkedSplit.stale.map((s) => react.createElement("div", {
									key: "st" + s.skillId,
									style: { ...rowStyle, opacity: 0.85 },
									title: "失效技能：当前发现不到（通常是贡献它的插件被关闭）。标签关联仍保留。",
									"data-skill-tag-stale-skill": s.skillId,
								}, [
									react.createElement("span", { key: "n", style: { flex: 1, color: STALE_COLOR, textDecoration: "line-through" } }, s.skillId),
									// 仍允许移除（用户可能就是想清掉它）
									react.createElement("button", {
										key: "rm", style: { ...btn, color: "#e67e22", padding: "1px 8px" }, disabled: busy,
										onClick: () => void removeSkill(s.skillId),
									}, "移除"),
								])),
							]),
							react.createElement("div", { key: "add", style: { display: "flex", gap: "8px", marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--theme-border,#222)" } }, [
								react.createElement("button", {
									key: "open", style: { ...btn, color: "#2ecc71" }, disabled: busy,
									onClick: () => setState((s) => ({ ...s, pickOpen: true, pickSearch: "" })),
								}, "添加关联…"),
							]),
						]),
					]),
				]),
				links.some((l) => !skills.some((s) => s.name === l.skillId)) &&
					react.createElement("div", { key: "ghost", style: { color: "#888", fontSize: "11px", marginTop: "8px" } }, "* 带星号的关联在本机扫描中未找到对应 Skill(关联仍生效)。"),
				state.pickOpen && sel && react.createElement(SkillPickerModal, { key: "modal", data, state, setState, act, busy }),
			]);
		}

		// ── skill 联系 tag（反向视角，§4.2 对偶） ──────────────────────────
		// 左列 = 技能（扫描结果 + 仅有连接记录的幽灵技能），每行末尾带
		//        「📁 打开文件夹」—— 本机有这个技能就能直接跳到 SKILL.md。
		// 右列 = 该技能拥有的标签：勾选即保存（整组覆盖 /skills/tags），
		//        不设「保存」按钮，避免用户忘点丢失。
		function SkillTagPage({ data, state, setState, act, busy }) {
			const { notice } = state;
			const tags = data.tags ?? [];
			const links = data.skillLinks ?? [];
			const scanned = state.skills ?? [];
			const selName = state.linkSkillName;

			// 技能清单：**只列当前真正存在的技能**（scanned = 这次刷新发现到的）。
			//
			// 2026-10-31 改：此前会把"只存在连接记录"的幽灵技能也算进 `技能 (N)`，
			// 于是关掉贡献技能的插件后，数字仍然不变（本机 82 真 + 25 幽灵 = 107）。
			// 现在幽灵单独归类为 stale，计数只算真技能 —— 用户说的"更新列表和数目"。
			const names = [];
			const seen = new Set();
			for (const s of scanned) { if (s?.name && !seen.has(s.name)) { names.push({ name: s.name, ghost: false }); seen.add(s.name); } }
			const stale = (state.stale ?? []).filter((s) => s?.skillId && !seen.has(s.skillId));
			const staleIds = new Set(stale.map((s) => s.skillId));
			// 已选中但当前失效的技能：仍然显示，否则右侧会突然空白且没有解释。
			const selIsStale = Boolean(selName && staleIds.has(selName));
			const match = (n) => !state.skillPickSearch.trim() || n.toLowerCase().includes(state.skillPickSearch.trim().toLowerCase());
			const shown = names.filter((n) => match(n.name));

			const ownedIds = selName ? (links.find((l) => l.skillId === selName)?.tagIds ?? []) : [];
			const owned = new Set(ownedIds);
			const tagMatch = (t) => !state.skillTagSearch.trim() || t.name.toLowerCase().includes(state.skillTagSearch.trim().toLowerCase());
			// 已拥有的标签排在前面（不再是纯粹按服务端返回的字母序），便于确认"这个技能到底挂了什么"
			const tagsOrdered = ownedTagsFirst(tags, ownedIds);
			const tagsShown = tagsOrdered.filter(tagMatch);

			/** 整组覆盖该技能的标签集合（勾选/取消都走这里，立即落库） */
			const saveTags = async (nextIds) => {
				if (!selName) return;
				await act("/skills/tags", { skillName: selName, tagIds: nextIds }, nextIds.length ? "已更新该技能的标签" : "已清空该技能的标签");
			};
			const toggleTag = (tagId) => {
				const next = owned.has(tagId) ? ownedIds.filter((x) => x !== tagId) : [...ownedIds, tagId];
				void saveTags(next);
			};

			const colStyle = { flex: "1 1 0", minWidth: "260px", border: "1px solid var(--theme-border,#333)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column" };
			const rowStyle = { display: "flex", gap: "8px", alignItems: "center", padding: "5px 4px", borderBottom: "1px solid var(--theme-border,#222)", fontSize: "12px" };
			const selRowStyle = { ...rowStyle, background: "var(--theme-bg-tertiary,#2a3350)", borderRadius: "6px" };

			return react.createElement("div", { style: { ...pad, maxWidth: "960px" } }, [
				react.createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px", flexWrap: "wrap" } }, [
					react.createElement("button", { key: "back", style: btn, disabled: busy, onClick: () => setState((s) => ({ ...s, view: "main", linkSkillName: null })) }, "← 返回"),
					react.createElement("h3", { key: "t", style: { margin: 0 } }, "skill 联系 tag"),
					selName && react.createElement("span", { key: "cur", style: { color: "#888", fontSize: "12px" } }, `当前技能: ${selName}`),
					// 刷新技能列表：插件关停/启用后手动同步（服务端每次都是实时查询，
					// 这里只是把前端那份缓存重新拉一遍）。
					react.createElement("button", {
						key: "refresh",
						style: { ...btn, marginLeft: "auto" },
						disabled: busy,
						title: "重新向宿主查询当前真正可用的技能",
						"data-skill-tag-refresh": "1",
						onClick: () => void refreshSkills(),
					}, "刷新技能列表"),
				]),
				notice && react.createElement("div", { key: "n", style: noteStyle }, notice),
				// 选中了一个当前已经失效的技能：右侧标签仍可看/可改，但要讲清原因。
				selIsStale && react.createElement("div", {
					key: "staleSel",
					style: { background: "rgba(230,126,34,0.12)", border: "1px solid rgba(230,126,34,0.4)", borderRadius: "8px", padding: "6px 10px", marginBottom: "10px", fontSize: "12px", color: "#e67e22" },
				}, `「${selName}」当前发现不到（通常是贡献它的插件被关闭）。标签关联仍保留，重新启用插件后自动恢复可见。`),
				react.createElement("div", { key: "cols", style: { display: "flex", gap: "12px", alignItems: "flex-start" } }, [
					// ── 左列：技能 ──────────────────────────────────────────
					react.createElement("div", { key: "left", style: colStyle }, [
						react.createElement("div", { key: "lt", style: { fontWeight: 600, marginBottom: "6px" } },
							`技能 (${names.length})` + (stale.length ? ` · 失效 ${stale.length}` : "")),
						react.createElement("input", {
							key: "search", style: { ...input, width: "100%", marginBottom: "6px" }, placeholder: "搜索技能…",
							value: state.skillPickSearch, onChange: (e) => setState((s) => ({ ...s, skillPickSearch: e.target.value })),
						}),
						react.createElement("div", { key: "rows", style: { maxHeight: "420px", overflowY: "auto" } }, [
							shown.length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px", padding: "6px 2px" } },
								names.length === 0 ? "本机没有扫描到任何技能" : "无匹配技能"),
							...shown.map((n) => {
								const nTags = links.find((l) => l.skillId === n.name)?.tagIds?.length ?? 0;
								return react.createElement("div", {
									key: n.name, style: n.name === selName ? selRowStyle : rowStyle,
									onClick: () => setState((s) => ({ ...s, linkSkillName: n.name })),
									title: n.ghost ? "本机扫描中未找到该技能(连接记录仍生效)" : "点击选中",
								}, [
									react.createElement("span", { key: "n", style: { fontWeight: n.name === selName ? 600 : 400, flex: 1, cursor: "pointer" } }, n.name + (n.ghost ? " *" : "")),
									react.createElement("span", { key: "c", style: { color: "#888", fontSize: "11px" } }, nTags ? `${nTags} tag` : ""),
									!n.ghost && react.createElement(RevealButton, { key: "rev", skillName: n.name, skills: scanned, label: "📁" }),
								]);
							}),
						]),
						// 失效技能单列：只在有标签关联、但当前发现不到时出现。
						// 位置固定在最底部（图一的要求），名字标红 + 删除线；
						// 计数不算进上面的「技能 (N)」；默认不删，给一个显式清理入口。
						stale.length > 0 && react.createElement("div", { key: "staleBox", style: { marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--theme-border,#222)" } }, [
							react.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "#e67e22", marginBottom: "4px" } }, [
								react.createElement("span", { key: "t", style: { flex: 1 } }, `失效 ${stale.length} 个（有标签关联，但当前发现不到）`),
								react.createElement("button", {
									key: "p",
									style: { ...btn, padding: "1px 8px", fontSize: "11px", color: "#e67e22" },
									disabled: busy,
									"data-skill-tag-purge": "1",
									onClick: () => void purgeStale(),
								}, "清理失效关联")]),
							...stale.slice(0, 30).map((s) => react.createElement("div", {
								key: s.skillId,
								style: { ...rowStyle, cursor: "pointer" },
								title: "失效技能：当前发现不到（通常是贡献它的插件被关闭）。点击查看它保留的标签关联。",
								"data-skill-tag-stale-skill": s.skillId,
								onClick: () => setState((st) => ({ ...st, linkSkillName: s.skillId })),
							}, [
								react.createElement("span", { key: "n", style: { flex: 1, color: STALE_COLOR, textDecoration: "line-through" } }, s.skillId),
								react.createElement("span", { key: "c", style: { fontSize: "11px" } }, `${(s.tagIds ?? []).length} tag`),
							])),
							stale.length > 30 && react.createElement("div", { key: "more", style: { color: "#888", fontSize: "11px", padding: "2px 4px" } }, `…还有 ${stale.length - 30} 个`),
						]),
					]),
					// ── 右列：该技能的标签 ──────────────────────────────────
					react.createElement("div", { key: "right", style: colStyle }, [
						react.createElement("div", { key: "rt", style: { fontWeight: 600, marginBottom: "6px" } },
							selName ? `标签 — ${selName} (${ownedIds.length})` : "标签"),
						!selName && react.createElement("div", { key: "hint", style: { color: "#888", fontSize: "12px", padding: "8px 0" } }, "← 先在左侧选中一个技能"),
						selName && react.createElement(react.Fragment, { key: "panel" }, [
							react.createElement("div", { key: "hint", style: { color: "#888", fontSize: "11px", marginBottom: "6px" } },
								"勾选即保存：这个技能拥有的标签决定它在各工作区/对话里是否被标签规则命中。"),
							react.createElement("input", {
								key: "search", style: { ...input, width: "100%", marginBottom: "6px" }, placeholder: "搜索标签…",
								value: state.skillTagSearch, onChange: (e) => setState((s) => ({ ...s, skillTagSearch: e.target.value })),
							}),
							react.createElement("div", { key: "rows", style: { maxHeight: "360px", overflowY: "auto" } }, [
								tags.length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px", padding: "6px 2px" } }, "还没有任何标签，请先在主页面新建"),
								tagsShown.length === 0 && tags.length > 0 &&
									react.createElement("div", { key: "e2", style: { color: "#888", fontSize: "12px", padding: "6px 2px" } }, "无匹配标签"),
								...tagsShown.map((t) => react.createElement("label", { key: t.tagId, style: { ...rowStyle, cursor: "pointer" } }, [
									react.createElement("input", {
										key: "c", type: "checkbox", checked: owned.has(t.tagId), disabled: busy,
										onChange: () => toggleTag(t.tagId),
									}),
									react.createElement("span", { key: "n", style: { flex: 1 } }, t.name),
									...ownedIds.slice(0, 0),
								])),
							]),
							react.createElement("div", { key: "f", style: { display: "flex", gap: "8px", marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--theme-border,#222)", flexWrap: "wrap" } }, [
								react.createElement("span", { key: "cnt", style: { color: "#888", fontSize: "11px", marginRight: "auto" } },
									ownedIds.length ? "已拥有: " + ownedIds.map((id) => tags.find((t) => t.tagId === id)?.name ?? id).join(", ") : "该技能没有任何标签"),
								react.createElement("button", {
									key: "clr", style: { ...btn, color: "#e74c3c" }, disabled: busy || ownedIds.length === 0,
									onClick: () => void saveTags([]),
								}, "清空标签"),
							]),
						]),
					]),
				]),
				links.some((l) => !scanned.some((s) => s.name === l.skillId)) &&
					react.createElement("div", { key: "ghost", style: { color: "#888", fontSize: "11px", marginTop: "8px" } }, "* 带星号的技能在本机扫描中未找到(连接记录仍生效)。"),
			]);
		}

		// ── 标签组配置 (§5) — 上：已有标签；下：表达式输入区 ─────────────────
		// 数据结构（persisted in templates table）：
		//   { templateId, name, expression, config, createdAt, updatedAt }
		//   - expression 是唯一事实来源：`+` = OR, `*` = AND，优先级 * > +，支持括号
		//   - config 由服务端从 expression 推导（DNF ⇄ {orTags, andGroups}），
		//     下游打标签/筛选逻辑直接消费 config，无需二次解析
		// 交互契约：
		//   1. 点「编辑」或列表行 → 从 t.expression 回显（服务端已迁移旧数据，绝不清空）
		//   2. 点上方标签 → 在光标处插入标签名（必要时自动加引号/补 `+`）
		//   3. 输入即校验（/templates/validate），错误带位置并可点击定位
		//   4. 保存 → /templates(/update)，失败不落库；再次打开仍回显同一表达式
		function TemplateGroupPage({ data, state, setState, act, busy }) {
			const { notice } = state;
			const templates = data.templates ?? [];
			const tags = data.tags ?? [];
			const sel = templates.find((t) => t.templateId === state.tplId) ?? null;
			const editing = state.tplId !== null || state.tplIsNew === true;
			const expr = state.tplExpression ?? "";

			const textareaRef = react.useRef(null);
			const [tagQuery, setTagQuery] = react.useState("");
			const [validation, setValidation] = react.useState(null);
			const [checking, setChecking] = react.useState(false);
			const [localNotice, setLocalNotice] = react.useState(null);

			// 实时校验：输入变化 250ms 后请求服务端；服务端与保存走同一份实现。
			react.useEffect(() => {
				if (!editing) { setValidation(null); return undefined; }
				let live = true;
				const timer = setTimeout(async () => {
					setChecking(true);
					try {
						const d = await apiPost("/templates/validate", { expression: expr });
						if (!live) return;
						setValidation(d?.ok ? d.validation : { ok: false, errors: [{ message: d?.error ?? "校验失败", position: 0 }], warnings: [] });
					} catch (e) {
						if (live) setValidation({ ok: false, errors: [{ message: String(e?.message ?? e), position: 0 }], warnings: [] });
					} finally {
						if (live) setChecking(false);
					}
				}, 250);
				return () => { live = false; clearTimeout(timer); };
			}, [expr, editing, state.tplId, tags.length]);

			const openTpl = (t) => setState((s) => ({
				...s, tplId: t.templateId, tplIsNew: false, tplName: t.name, tplExpression: t.expression ?? "",
			}));
			const newTpl = () => setState((s) => ({
				...s, tplId: null, tplIsNew: true, tplName: "", tplExpression: "",
			}));
			const closeEditor = () => setState((s) => ({
				...s, tplId: null, tplIsNew: false, tplName: "", tplExpression: "",
			}));

			/** 光标处插入（保留选区外内容；operand=true 时自动补 `+` 连接） */
			const insertAtCursor = (text, opts = {}) => {
				const el = textareaRef.current;
				const cur = state.tplExpression ?? "";
				const start = el && typeof el.selectionStart === "number" ? el.selectionStart : cur.length;
				const end = el && typeof el.selectionEnd === "number" ? el.selectionEnd : start;
				let insert = text;
				if (opts.operand) {
					const before = cur.slice(0, start).replace(/\s+$/, "");
					const prev = before.slice(-1);
					if (prev !== "" && prev !== "+" && prev !== "*" && prev !== "(") insert = " + " + insert;
					const after = cur.slice(end).replace(/^\s+/, "");
					const next = after.slice(0, 1);
					if (next !== "" && next !== "+" && next !== "*" && next !== ")") insert = insert + " + ";
				}
				const value = cur.slice(0, start) + insert + cur.slice(end);
				setState((s) => ({ ...s, tplExpression: value }));
				const caret = start + insert.length;
				setTimeout(() => {
					const e2 = textareaRef.current;
					if (!e2) return;
					e2.focus();
					try { e2.setSelectionRange(caret, caret); } catch { /* 放弃定位 */ }
				}, 0);
			};

			const saveTpl = async () => {
				const name = (state.tplName ?? "").trim();
				if (!name) { setLocalNotice("失败: 标签组名称不能为空"); return; }
				if (!validation || !validation.ok) {
					const first = validation?.errors?.[0];
					setLocalNotice("失败: " + (first?.message ?? "表达式未通过校验，请先修正"));
					return;
				}
				setLocalNotice(null);
				const body = { name, expression: state.tplExpression };
				if (state.tplIsNew) {
					const d = await act("/templates", {
						templateId: "tpl-" + Date.now().toString(36),
						...body,
					}, "标签组已创建");
					if (d?.template) setState((s) => ({ ...s, tplId: d.template.templateId, tplIsNew: false, tplName: d.template.name, tplExpression: d.template.expression ?? "" }));
					return;
				}
				await act("/templates/update", { templateId: state.tplId, ...body }, "标签组已保存");
			};

			const deleteTpl = async (id, name) => {
				const label = name ?? id;
				if (!window.confirm(`删除标签组「${label}」? 已应用到工作区/对话的配置不受影响(复制语义)。`)) return;
				const ok = await act("/templates/delete", { templateId: id }, "标签组已删除");
				if (ok !== null && id === state.tplId) closeEditor();
			};

			const panel = { border: "1px solid var(--theme-border,#333)", borderRadius: "10px", padding: "10px 12px", marginBottom: "10px" };
			const panelTitle = { fontWeight: 600, marginBottom: "6px", fontSize: "12px" };
			const chip = { display: "inline-flex", alignItems: "center", gap: "4px", border: "1px solid var(--theme-border,#444)", borderRadius: "8px", padding: "2px 8px", margin: "0 6px 6px 0", fontSize: "12px" };
			const mono = { fontFamily: "ui-monospace,monospace" };
			const errText = { color: "#e74c3c", fontSize: "12px", marginTop: "4px" };
			const okText = { color: "#2ecc71", fontSize: "12px", marginTop: "4px" };
			const warnText = { color: "#e6a23c", fontSize: "12px", marginTop: "4px" };

			const visibleTags = tags.filter((t) => !tagQuery.trim() || t.name.toLowerCase().includes(tagQuery.trim().toLowerCase()));
			const errors = validation?.errors ?? [];
			const warnings = validation?.warnings ?? [];

			// 结构化预览：把推导出的 config 渲染成人类可读的布尔式（用标签名）
			const preview = validation?.ok && validation.config
				? configDisplay({ tags }, validation.config)
				: null;

			return react.createElement("div", { style: { ...pad, maxWidth: "960px" } }, [
				// ── 头部 ────────────────────────────────────────────────────
				react.createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px", flexWrap: "wrap" } }, [
					react.createElement("button", { key: "back", style: btn, disabled: busy, onClick: () => setState((s) => ({ ...s, view: "main" })) }, "← 返回"),
					react.createElement("h3", { key: "t", style: { margin: 0 } }, "标签组配置"),
					react.createElement("button", { key: "new", style: { ...btn, color: "#2ecc71" }, disabled: busy, onClick: newTpl }, "+ 新建标签组"),
					sel && react.createElement("span", { key: "cur", style: { color: "#888", fontSize: "12px" } }, `当前: ${sel.name}`),
					!sel && state.tplIsNew && react.createElement("span", { key: "draft", style: { color: "#888", fontSize: "12px" } }, "新标签组（未保存）"),
				]),
				notice && react.createElement("div", { key: "n", style: noteStyle }, notice),
				localNotice && react.createElement("div", { key: "ln", style: { ...noteStyle, color: "#e74c3c" } }, localNotice),

				// ── 标签组列表（选择/删除）──────────────────────────────────
				react.createElement("div", { key: "list", style: panel }, [
					react.createElement("div", { key: "lt", style: panelTitle }, `标签组 (${templates.length})`),
					templates.length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px" } }, "暂无标签组，点上方「+ 新建标签组」开始"),
					react.createElement("div", { key: "chips" }, templates.map((t) => react.createElement("span", {
						key: t.templateId,
						style: { ...chip, cursor: "pointer", borderColor: t.templateId === state.tplId ? "#2ecc71" : "var(--theme-border,#444)" },
						title: "点击编辑",
						onClick: () => openTpl(t),
					}, [
						react.createElement("strong", { key: "n" }, t.name),
						react.createElement("span", { key: "x", style: { ...mono, color: "#888", fontSize: "11px" } }, t.expression || "(空)"),
						react.createElement("button", {
							key: "d", style: { ...btn, padding: "0 5px", fontSize: "11px", color: "#e74c3c" }, disabled: busy,
							onClick: (e) => { e.stopPropagation(); void deleteTpl(t.templateId, t.name); },
						}, "×"),
					]))),
				]),

				// ── 上方：已有标签（查看 + 点击插入）────────────────────────
				react.createElement("div", { key: "tags", style: panel }, [
					react.createElement("div", { key: "tt", style: { ...panelTitle, display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
						react.createElement("span", { key: "l" }, `已有标签 (${tags.length})`),
						react.createElement("input", {
							key: "q", style: { ...input, width: "180px" }, placeholder: "搜索标签…",
							value: tagQuery, onChange: (e) => setTagQuery(e.target.value),
						}),
						react.createElement("span", { key: "hint", style: { color: "#888", fontSize: "11px", fontWeight: 400 } },
							"点击标签插入到表达式光标处；含空格或运算符的名称会自动加引号"),
					]),
					tags.length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px" } }, "还没有标签 — 请先回到「Skill 标签」页创建标签"),
					tags.length > 0 && visibleTags.length === 0 && react.createElement("div", { key: "nf", style: { color: "#888", fontSize: "12px" } }, "无匹配标签"),
					react.createElement("div", { key: "chips" }, visibleTags.map((t) => react.createElement("button", {
						key: t.tagId,
						style: { ...chip, cursor: editing ? "pointer" : "not-allowed", opacity: editing ? 1 : 0.5, background: "transparent", color: "inherit" },
						disabled: busy || !editing,
						title: editing ? "插入表达式" : "请先新建或选中一个标签组",
						onClick: () => insertAtCursor(quoteTagName(t.name), { operand: true }),
					}, t.name))),
					!editing && react.createElement("div", { key: "need", style: { color: "#888", fontSize: "11px", marginTop: "4px" } },
						"提示：先在下方「新建标签组」或点列表中的标签组，标签才可点击插入"),
				]),

				// ── 下方：表达式输入区 ──────────────────────────────────────
				react.createElement("div", { key: "expr", style: panel }, [
					react.createElement("div", { key: "et", style: panelTitle }, "表达式"),
					!editing && react.createElement("div", { key: "idle", style: { color: "#888", fontSize: "12px", padding: "6px 0" } },
						"未在编辑。点上方「+ 新建标签组」创建，或点列表中的标签组编辑（将回显已保存的表达式）。"),
					editing && react.createElement(react.Fragment, { key: "form" }, [
						react.createElement("div", { key: "name", style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px" } }, [
							react.createElement("span", { key: "l", style: { fontWeight: 600, fontSize: "12px", minWidth: "48px" } }, "名称"),
							react.createElement("input", {
								key: "i", style: { ...input, flex: 1 }, placeholder: "标签组名称（唯一）",
								value: state.tplName ?? "",
								onChange: (e) => setState((s) => ({ ...s, tplName: e.target.value })),
							}),
						]),
						react.createElement("textarea", {
							key: "ta", ref: textareaRef,
							style: { ...input, width: "100%", minHeight: "88px", ...mono, lineHeight: "1.5", resize: "vertical", boxSizing: "border-box" },
							placeholder: "例如: A+B*C  或  (A+B)*C    快捷键: 点上方标签/下方按钮插入",
							value: expr,
							disabled: busy,
							onChange: (e) => setState((s) => ({ ...s, tplExpression: e.target.value })),
						}),
						// 运算符工具条
						react.createElement("div", { key: "ops", style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "6px" } }, [
							react.createElement("span", { key: "l", style: { color: "#888", fontSize: "11px" } }, "插入:"),
							...[[ "+", "OR" ], [ "*", "AND" ], [ "(", "" ], [ ")", "" ]].map(([sym, label]) => react.createElement("button", {
								key: sym, style: { ...btn, ...mono, padding: "1px 9px" }, disabled: busy,
								title: label ? `${sym} = ${label}` : `插入 ${sym}`,
								onClick: () => insertAtCursor(sym),
							}, sym + (label ? ` ${label}` : ""))),
							react.createElement("button", {
								key: "clr", style: { ...btn, color: "#e67e22", marginLeft: "auto" }, disabled: busy || !expr,
								onClick: () => { setState((s) => ({ ...s, tplExpression: "" })); setLocalNotice(null); },
							}, "清空"),
						]),
						// 校验结果
						react.createElement("div", { key: "val", style: { marginTop: "8px" } }, [
							checking && react.createElement("div", { key: "c", style: { color: "#888", fontSize: "12px" } }, "校验中…"),
							!checking && validation && validation.ok && react.createElement("div", { key: "ok", style: okText }, "✓ 表达式合法"),
							!checking && validation && !validation.ok && react.createElement("div", { key: "err" },
								errors.map((er, i) => react.createElement("div", { key: i, style: errText }, [
									react.createElement("span", { key: "m" }, "✗ " + er.message),
									typeof er.position === "number" && er.position >= 0 && react.createElement("button", {
										key: "loc", style: { ...btn, marginLeft: "8px", padding: "0 6px", fontSize: "11px" },
										onClick: () => {
											const el = textareaRef.current;
											if (!el) return;
											el.focus();
											const p = Math.min(er.position, el.value.length);
											try { el.setSelectionRange(p, Math.min(p + (er.length ?? 0), el.value.length)); } catch { /* 忽略 */ }
										},
									}, `定位 第${er.position + 1}字符`),
								]))),
							!checking && warnings.map((w, i) => react.createElement("div", { key: "w" + i, style: warnText }, "⚠ " + w.message)),
							!checking && validation && validation.ok && validation.normalized && validation.normalized !== expr.trim() &&
								react.createElement("div", { key: "norm", style: { color: "#888", fontSize: "11px", marginTop: "4px" } },
									"规范化: " + validation.normalized),
							!checking && preview && react.createElement("div", { key: "pv", style: { color: "#888", fontSize: "11px", marginTop: "2px" } },
								"解析结果: " + preview),
						]),
						// 保存 / 删除
						react.createElement("div", { key: "acts", style: { display: "flex", gap: "8px", marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--theme-border,#222)" } }, [
							react.createElement("button", {
								key: "save", style: { ...btn, color: "#2ecc71" },
								disabled: busy || checking || !(state.tplName ?? "").trim() || !validation?.ok,
								title: !validation?.ok ? "表达式需先通过校验" : "",
								onClick: () => void saveTpl(),
							}, state.tplIsNew ? "保存新建" : "保存"),
							!state.tplIsNew && react.createElement("button", {
								key: "del", style: { ...btn, color: "#e74c3c" }, disabled: busy,
								onClick: () => void deleteTpl(state.tplId, sel?.name),
							}, "删除标签组"),
							react.createElement("button", { key: "cancel", style: btn, disabled: busy, onClick: closeEditor }, "关闭编辑"),
						]),
						react.createElement("div", { key: "use", style: { color: "#888", fontSize: "11px", marginTop: "8px" } },
							"语法: + 表示 OR，* 表示 AND，优先级 * 高于 +，可用括号。例 A+B*C = A OR (B AND C); (A+B)*C = (A OR B) AND C。"),
					]),
				]),
			]);
		}

		// ══════════════════════════════════════════════════════════════════
		// 「管理标签」— 工作区维度双列界面
		// ══════════════════════════════════════════════════════════════════
		//
		// 宿主的工作区行菜单（重命名 / 删除工作区）是硬编码的，没有任何插件槽位
		// （见 docs/technical-discovery.md：「宿主 asar 里的 ProjectRowItem」）。
		// 因此入口靠 DOM 注入：MutationObserver 盯 body（宿主 Menu 走 portal 挂到
		// body 下），识别"恰好两个菜单项、第一个是重命名、第二个是删除"的那份菜单，
		// 在末尾追加一项「管理标签」。
		//
		// 浮层本身走官方槽位 shell.overlay（root scope 的 list），不用 DOM 造界面。

		/** 菜单注入 ↔ 浮层渲染之间唯一的通信通道（模块级 store） */
		const manage = { open: false, workspaceId: "", workspaceTitle: "", conversationId: "", sessionTitle: "", listeners: new Set() };
		function manageSet(patch) {
			// 作用域互斥：workspaceId 与 conversationId 绝不能同时有值。
			// manageScope() 只看 conversationId 是否为空来决定走「工作区版」还是「对话版」，
			// 所以只要残留一个上次打开对话管理时留下的 conversationId，
			// 工作区的「管理标签」就会打开成「管理标签（对话）」。
			// 三个打开入口里，会话行菜单和聊天框「+」都显式清了 workspaceId，
			// 只有 DOM 注入的工作区菜单这一处漏了 —— 于是在这里统一兜住，免得以后再漏。
			if (patch.open === true) {
				if (patch.conversationId) {
					patch.workspaceId = "";
				} else if (patch.workspaceId) {
					patch.conversationId = "";
					patch.sessionTitle = "";
				}
			}
			Object.assign(manage, patch);
			for (const fn of [...manage.listeners]) fn();
		}
		function useManage() {
			const [, bump] = react.useState(0);
			react.useEffect(() => {
				const fn = () => bump((n) => n + 1);
				manage.listeners.add(fn);
				return () => { manage.listeners.delete(fn); };
			}, []);
			return manage;
		}

		/**
		 * 从 data-row-key 里取出 workspaceId（`workspace:<id>`）。
		 * ungrouped 组是 `workspace:`（空 id），要排除。
		 * @returns {string|null}
		 */
		function workspaceIdOfRowKey(rowKey) {
			const s = String(rowKey ?? "");
			if (!s.startsWith("workspace:")) return null;
			const id = s.slice("workspace:".length).trim();
			return id === "" ? null : id;
		}

		/**
		 * 判断一份菜单是不是宿主的工作区行菜单。
		 * 宿主源码里它就是 [{id:"rename"},{id:"delete",danger:true}] 两项；
		 * 会话行菜单项更多，且不含"删除工作区"。
		 * @param {string[]} labels 各 menuitem 的可见文本
		 */
		function isWorkspaceMenu(labels) {
			if (!Array.isArray(labels) || labels.length !== 2) return false;
			const [first, second] = labels.map((s) => String(s ?? "").trim());
			return /^(rename|重命名)$/i.test(first) && /(delete|删除)/i.test(second);
		}

		/** 「管理标签」菜单项按钮（内联样式模拟宿主菜单项，不依赖 CSS Module 类名） */
		function makeManageMenuItem(workspaceId, workspaceTitle) {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "menuitem");
			button.setAttribute("data-skill-tag-manage", "1");
			button.textContent = "管理标签";
			button.style.cssText = [
				"display:flex", "align-items:center", "gap:8px", "width:100%",
				"padding:7px 10px", "border:0", "border-radius:6px",
				"background:transparent", "color:inherit", "cursor:pointer",
				"font:inherit", "text-align:left",
			].join(";");
			button.addEventListener("mouseenter", () => { button.style.background = "var(--theme-bg-tertiary,rgba(255,255,255,0.08))"; });
			button.addEventListener("mouseleave", () => { button.style.background = "transparent"; });
			button.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				manageSet({ open: true, workspaceId, workspaceTitle });
				// 让宿主菜单自行关闭（它监听 body 上的 pointerdown）
				try {
					document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
				} catch { /* 老浏览器兜底 */ }
			});
			return button;
		}

		/**
		 * 安装菜单注入。返回 cleanup。
		 * 记录"最近一次 pointerdown 落在哪个工作区行"，菜单出现时据此反推 workspaceId
		 * （宿主用 React 状态渲染菜单，菜单本身不携带 workspaceId）。
		 */
		function installWorkspaceMenuInjector() {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
			let lastRowKey = null;
			const onPointerDown = (e) => {
				const target = e?.target;
				if (!target || typeof target.closest !== "function") return;
				const row = target.closest('[data-row-key^="workspace:"]');
				if (row) lastRowKey = row.getAttribute("data-row-key");
			};
			document.addEventListener("pointerdown", onPointerDown, true);

			const tryInject = () => {
				for (const menu of document.querySelectorAll('[role="menu"]')) {
					if (menu.querySelector("[data-skill-tag-manage]")) continue;
					const items = [...menu.querySelectorAll('button[role="menuitem"]')];
					if (!isWorkspaceMenu(items.map((b) => b.textContent ?? ""))) continue;
					const workspaceId = workspaceIdOfRowKey(lastRowKey);
					if (!workspaceId) continue;
					const last = items[items.length - 1];
					// 宿主结构：div.list > div.viewport > div.itemWrap > button
					const host = last?.parentElement?.parentElement ?? menu;
					const row = last?.closest('[data-row-key^="workspace:"]');
					void row;
					host.appendChild(makeManageMenuItem(workspaceId, ""));
				}
			};
			const mo = new MutationObserver(() => { tryInject(); });
			mo.observe(document.body, { childList: true, subtree: true });
			return () => {
				try { mo.disconnect(); } catch { /* 已断开 */ }
				document.removeEventListener("pointerdown", onPointerDown, true);
				for (const b of document.querySelectorAll("[data-skill-tag-manage]")) b.remove();
			};
		}

		// ── 浮层宿主（shell.overlay 槽位） ──────────────────────────────
		function OverlayHost() {
			const st = useManage();
			if (!st.open) return null;
			return react.createElement(ManageTagsDialog, {
				key: st.conversationId ? "manage-tags-conv" : "manage-tags-ws",
				workspaceId: st.workspaceId,
				conversationId: st.conversationId,
				onClose: () => manageSet({ open: false }),
			});
		}

		// ── 会话行「...」菜单项：管理标签（对话版入口） ──────────────────
		//
		// 走宿主官方槽位 sidebar.workspaces.session.menu.item（kind:list, scope:root）：
		// 槽位 owner 给 props {sessionId, displayTitle}，并注入 useMenuOpenState，
		// 行动后必须 setMenuOpen(false) 关掉菜单。工作区那一侧没这个待遇（硬编码菜单），
		// 所以那边才要 DOM 注入 —— 这里不需要。
		function SessionManageMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
			const closeMenu = typeof useMenuOpenState === "function"
				? useMenuOpenState()[1]
				: () => {};
			const onClick = () => {
				try { closeMenu(false); } catch { /* 宿主未提供 */ }
				manageSet({ open: true, workspaceId: "", workspaceTitle: "", conversationId: sessionId, sessionTitle: displayTitle ?? "" });
			};
			return react.createElement("button", {
				type: "button",
				role: "menuitem",
				"data-skill-tag-manage-session": "1",
				style: {
					display: "flex", alignItems: "center", gap: "8px", width: "100%",
					padding: "7px 10px", border: "0", borderRadius: "6px",
					background: "transparent", color: "inherit", cursor: "pointer",
					font: "inherit", textAlign: "left",
				},
				onClick,
			}, "管理标签");
		}

		// ── 聊天框左下角「+」里的「管理对话标签」入口 ─────────────────────
		//
		// 那个「+」不是普通按钮，它打开的是宿主的 `/` 命令菜单
		// （dsh-client-ui-conversation 的 InputBar → toggleCommandMenu →
		//  inputTriggers.toggleSource("command", ...)），候选来自
		//  dsh-client-ui-commands 的 ctx.commandUi，那里**预留了客户端贡献位**：
		//
		//   ctx.inject(["commandUi"], (scope) => scope.effect(() => scope.commandUi.register({
		//     name, available(session), label(), description(), icon,
		//     ui: { kind: "action", run(session) },
		//   })))
		//
		// 走这条正式通道（官方插件 dsh-client-ui-message-feedback 就这么挂 /feedback），
		// 不用去 DOM 里扒「+」按钮。action 型贡献被选中时会先消费掉 token 再跑 run，
		// 不往输入框里写字、也不发消息。
		function registerComposerEntry(ctx) {
			if (typeof ctx.inject !== "function") return;
			ctx.inject(["commandUi"], (scope) => {
				const commandUi = scope?.commandUi;
				if (!commandUi || typeof commandUi.register !== "function") return;
				scope.effect(() => commandUi.register({
					name: "skill-tag-manage",
					available: () => true,
					label: () => "管理对话标签",
					description: () => "配置本对话的标签条件、技能添加与禁用",
					ui: {
						kind: "action",
						run: (session) => {
							const sessionId = session?.sessionId;
							if (!sessionId) return;
							manageSet({ open: true, workspaceId: "", workspaceTitle: "", conversationId: sessionId, sessionTitle: "" });
						},
					},
				}), "dsh-skill-tag: composer command entry");
			});
		}

		const overlayStyle = { position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" };
		const modalBox = { width: "900px", maxWidth: "94vw", maxHeight: "82vh", display: "flex", flexDirection: "column", background: "var(--theme-bg-secondary,#1a1f2e)", border: "1px solid var(--theme-border,#444)", borderRadius: "12px", padding: "14px 16px", boxShadow: "0 10px 40px rgba(0,0,0,0.55)", fontFamily: "ui-sans-serif,system-ui", fontSize: "13px" };
		const colStyle = { border: "1px solid var(--theme-border,#333)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", minHeight: 0 };
		const listRow = { display: "flex", alignItems: "center", gap: "8px", padding: "5px 2px", borderBottom: "1px solid var(--theme-border,#222)", fontSize: "12px" };
		const monoStyle = { fontFamily: "ui-monospace,monospace" };

		// ── 双列主界面（工作区版 / 对话版共用） ─────────────────────────
		//
		// 两个作用域的唯一差别是四组端点 + 一个「继承工作区配置」按钮：
		//   工作区：/workspaces/skills*      /workspaces/expression
		//   对话  ：/conversations/skills*   /conversations/expression   还有 /conversations/inherit
		// 其余（左列表达式 / 右列技能 / 添加 / 禁用 / 查看 tag）完全一致，
		// 所以只写一份组件，用 scope 决定路径。
		function manageScope(workspaceId, conversationId) {
			if (conversationId) {
				return {
					isConv: true,
					id: conversationId,
					key: "conversationId",
					title: "管理标签（对话）",
					loadPath: "/conversations/config",
					skillsPrefix: "/conversations/skills",
					exprPath: "/conversations/expression",
					emptyHint: "（无条件 — 该对话掌握全部技能）",
					scopeLabel: "当前对话",
				};
			}
			return {
				isConv: false,
				id: workspaceId,
				key: "workspaceId",
				title: "管理标签",
				loadPath: "/workspaces/skills",
				skillsPrefix: "/workspaces/skills",
				exprPath: "/workspaces/expression",
				emptyHint: "（无条件 — 该工作区掌握全部技能）",
				scopeLabel: "当前工作区",
			};
		}

		function ManageTagsDialog({ workspaceId, conversationId, onClose }) {
			const scope = manageScope(workspaceId, conversationId);
			const [loading, setLoading] = react.useState(true);
			const [err, setErr] = react.useState(null);
			const [ws, setWs] = react.useState(null);      // 作用域载荷（两版同形）
			const [base, setBase] = react.useState(null);  // /state 返回（tags/skillLinks/templates）
			const [notice, setNotice] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [settingsOpen, setSettingsOpen] = react.useState(false);
			const [pickOpen, setPickOpen] = react.useState(false);
			const [disabledOpen, setDisabledOpen] = react.useState(false);
			const [tagOfSkill, setTagOfSkill] = react.useState(null);
			/** 右列技能搜索词（对话版 / 工作区版共用；只影响列表显示，不影响下发结果） */
			const [skillSearch, setSkillSearch] = react.useState("");

			const load = react.useCallback(async () => {
				try {
					const [w, s] = await Promise.all([
						apiPost(scope.loadPath, { [scope.key]: scope.id }),
						apiGet("/state"),
					]);
					if (!w?.ok) throw new Error(w?.error ?? "加载失败");
					setWs(w);
					setBase(s?.ok ? s : null);
					setErr(null);
				} catch (e) {
					setErr(String(e?.message ?? e));
				} finally {
					setLoading(false);
				}
			}, [scope.loadPath, scope.key, scope.id]);
			react.useEffect(() => { void load(); }, [load]);

			const call = react.useCallback(async (path, body, note) => {
				setBusy(true);
				try {
					const d = await apiPost(path, { ...body, [scope.key]: scope.id });
					if (!d?.ok) throw new Error(d?.error ?? JSON.stringify(d));
					setNotice(note ?? "完成");
					await load();
					return d;
				} catch (e) {
					setNotice("失败: " + (e?.message ?? e));
					return null;
				} finally {
					setBusy(false);
				}
			}, [load, scope.key, scope.id]);

			/** 「继承工作区配置」：只要对话版有；整体覆盖条件+手动+禁用 */
			const inherit = react.useCallback(async () => {
				setBusy(true);
				try {
					const d = await apiPost("/conversations/inherit", { conversationId: scope.id });
					if (!d?.ok) throw new Error(d?.error ?? "继承失败");
					setNotice("已从工作区继承配置（标签条件 + 手动添加 + 禁用）");
					await load();
				} catch (e) {
					setNotice("失败: " + (e?.message ?? e));
				} finally {
					setBusy(false);
				}
			}, [load, scope.id]);

			const tags = base?.tags ?? [];
			const links = base?.skillLinks ?? [];
			const templates = base?.templates ?? [];
			const view = ws?.view ?? { hasFilter: false, visible: [], manual: [], disabled: [] };
			const expr = ws?.expression ?? "";
			// 空表达式 = 无条件（不能说成 ∅，否则与"掌握全部技能"矛盾）
			const parsed = !view.hasFilter ? "无条件（掌握全部技能）" : configDisplay({ tags }, ws?.config);
			const manualSet = new Set(ws?.manualSkills ?? []);
			const visibleSet = new Set(view.visible ?? []);
			const disabledSet = new Set(ws?.disabledSkills ?? []);

			/** 可添加的技能：排除已有（可见）与被禁用的 */
			const addable = (ws?.universe ?? []).filter((n) => !visibleSet.has(n) && !disabledSet.has(n));

			// 右列搜索：仅过滤显示，不影响「技能 (总)」这个语义数字
			const skillQuery = skillSearch.trim().toLowerCase();
			const shownSkills = (view.visible ?? []).filter((n) => !skillQuery || String(n).toLowerCase().includes(skillQuery));

			// 技能名 → SKILL.md 路径（服务端把扫描结果的 path 一并带回来了）
			const catalog = ws?.catalog ?? [];
			const pathOf = (name) => catalog.find((s) => s.name === name)?.path ?? null;

			const tagsOf = (skillName) => (links.find((l) => l.skillId === skillName)?.tagIds ?? [])
				.map((id) => tags.find((t) => t.tagId === id)?.name ?? id);

			const inheritedFrom = ws?.sourceWorkspaceId;
			const inheritedAt = ws?.inheritedAt;
			// configured：该对话是否有自己的配置快照（own）。false = 从未配置过。
			// expressionIssue：服务端只读体检结果，用于提示「引用了已删除的标签」。
			const configured = ws?.configured;
			const expressionIssue = ws?.expressionIssue ?? null;

			const body = () => {
				if (loading) return react.createElement("div", { style: { color: "#888", padding: "20px 0" } }, "加载中…");
				if (err) return react.createElement("div", { style: { color: "#e74c3c", padding: "20px 0" } }, "加载失败: " + err);
				return react.createElement("div", { key: "cols", style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", flex: 1, minHeight: 0, overflow: "hidden" } }, [
					// ── 左列：标签配置 ──
					react.createElement("div", { key: "left", style: colStyle }, [
						react.createElement("div", { key: "h", style: { fontWeight: 600, marginBottom: "8px" } }, "标签配置"),
						react.createElement("div", { key: "lbl", style: { color: "#888", fontSize: "11px", marginBottom: "4px" } }, scope.scopeLabel + "的标签条件"),
						react.createElement("div", { key: "expr", style: { ...monoStyle, fontSize: "12px", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--theme-border,#333)", minHeight: "44px", whiteSpace: "pre-wrap", wordBreak: "break-all" } },
							expr.trim() === "" ? scope.emptyHint : expr),
						react.createElement("div", { key: "pv", style: { color: "#888", fontSize: "11px", marginTop: "6px" } },
							"解析结果: " + parsed),
						react.createElement("div", { key: "st", style: { color: "#888", fontSize: "11px", marginTop: "2px" } },
							`状态: ${view.hasFilter ? "有条件筛选（严格子集）" : "无筛选（全部技能）"}`),
						// 继承状态：让用户知道「这份条件是从哪来的、什么时候来的」
						// configured=false（own 为 null）= 从未配置过 = 空条件 = 掌握全部技能。
						// 这不是「继承来源 null」，而是「你还没配过」，所以单独一条文案。
						scope.isConv && react.createElement("div", { key: "inh", style: { color: "#888", fontSize: "11px", marginTop: "2px" } },
							configured === false
								? "尚未配置过（未继承工作区；当前为空条件 = 掌握全部技能）"
								: (inheritedFrom
									? `继承来源: ${inheritedFrom}${inheritedAt ? " · " + fmtLocalTime(inheritedAt) : ""}（改动不影响工作区）`
									: "该对话有独立配置（未继承工作区）")),
						// 只读提示：已冻结的表达式引用了不存在的标签（旧版 bug 遗留）。
						// 不自动修复 —— 数据是用户意志，告诉他原因即可。
						scope.isConv && expressionIssue && !expressionIssue.ok && react.createElement("div", { key: "isq", style: { color: "#e67e22", fontSize: "11px", marginTop: "2px" } },
							`⚠ 表达式引用了已不存在的标签（${expressionIssue.message}）。点「tag 设置」可重新选择；保存前需修正。`),
						react.createElement("div", { key: "sp", style: { flex: 1 } }),
						react.createElement("div", { key: "f", style: { display: "flex", gap: "8px", flexWrap: "wrap", paddingTop: "8px", borderTop: "1px solid var(--theme-border,#222)" } }, [
							react.createElement("button", {
								key: "set", style: btn, disabled: busy,
								onClick: () => setSettingsOpen(true),
							}, "tag 设置"),
							// 「继承工作区配置」只在对话版出现：把当前工作区的三件套整体搬过来
							scope.isConv && react.createElement("button", {
								key: "inh", style: { ...btn, color: "#3498db" }, disabled: busy,
								title: "用当前工作区的标签条件 / 手动添加 / 禁用整体覆盖本对话的配置",
								onClick: () => void inherit(),
							}, "继承工作区配置"),
						]),
					]),

					// ── 右列：技能 ──
					react.createElement("div", { key: "right", style: colStyle }, [
						react.createElement("div", { key: "h", style: { fontWeight: 600, marginBottom: "8px" } },
							skillQuery
								? `技能 (${shownSkills.length}/${(view.visible ?? []).length})`
								: `技能 (${(view.visible ?? []).length})`),
						// 搜索框：放列表顶部，只过滤显示（不改变实际下发的技能集合）
						react.createElement("div", { key: "search", style: { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" } }, [
							react.createElement("input", {
								key: "i", style: { ...input, flex: 1, minWidth: 0 }, type: "search", placeholder: "搜索技能…",
								value: skillSearch, onChange: (e) => setSkillSearch(e.target.value),
							}),
							skillSearch.trim() !== "" && react.createElement("button", {
								key: "c", style: { ...btn, padding: "1px 7px", fontSize: "11px" },
								onClick: () => setSkillSearch(""),
							}, "清除"),
						]),
						react.createElement("div", { key: "list", style: { flex: 1, overflowY: "auto", minHeight: "80px" } }, [
							(view.visible ?? []).length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px" } },
								"没有技能。可在下方「+ 精细化添加技能」手动加入，或清空标签条件回到全部技能。"),
							(view.visible ?? []).length > 0 && shownSkills.length === 0 && react.createElement("div", { key: "nf", style: { color: "#888", fontSize: "12px" } },
								`没有匹配「${skillSearch.trim()}」的技能。`),
							...shownSkills.map((name) => react.createElement("div", { key: name, style: { ...listRow, flexWrap: "wrap" } }, [
								react.createElement("span", { key: "n", style: { flex: 1 } }, name),
								manualSet.has(name) && react.createElement("span", { key: "m", style: { color: "#3498db", fontSize: "11px" } }, "手动"),
								react.createElement(RevealButton, { key: "rev", skillName: name, path: pathOf(name), label: "📁" }),
								react.createElement("button", {
									key: "t", style: { ...btn, padding: "1px 7px", fontSize: "11px" },
									onClick: () => setTagOfSkill((v) => (v === name ? null : name)),
								}, "查看 tag"),
								react.createElement("button", {
									key: "d", style: { ...btn, padding: "1px 7px", fontSize: "11px", color: "#e74c3c" }, disabled: busy,
									onClick: () => void call(scope.skillsPrefix + "/disable", { skillName: name }, `已禁用 ${name}`),
								}, "禁用"),
								tagOfSkill === name && react.createElement("div", { key: "tags", style: { flexBasis: "100%", color: "#888", fontSize: "11px", padding: "2px 0 2px 8px" } },
									(tagsOf(name).length ? "tag: " + tagsOf(name).join(", ") : "该技能没有任何 tag")),
							])),
						]),
						react.createElement("div", { key: "f", style: { display: "flex", gap: "8px", flexWrap: "wrap", paddingTop: "8px", borderTop: "1px solid var(--theme-border,#222)" } }, [
							react.createElement("button", { key: "add", style: btn, disabled: busy, onClick: () => setPickOpen(true) }, "+ 精细化添加技能"),
							react.createElement("button", { key: "dis", style: btn, disabled: busy, onClick: () => setDisabledOpen(true) },
								`查看被禁用的技能 (${(ws?.disabledSkills ?? []).length})`),
						]),
					]),
				]);
			};

			return react.createElement("div", { style: overlayStyle, onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
				// 固定高度：搜索让右列行数变少时窗口不能跟着缩（否则每敲一个字母窗口就抖一下）
				react.createElement("div", { style: { ...modalBox, height: "82vh" }, onClick: (e) => e.stopPropagation() }, [
					react.createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" } }, [
						react.createElement("strong", { key: "t", style: { fontSize: "14px" } }, scope.title),
						react.createElement("span", { key: "w", style: { color: "#888", fontSize: "11px", ...monoStyle } }, scope.id),
						react.createElement("button", { key: "x", style: { ...btn, marginLeft: "auto" }, onClick: onClose }, "✕"),
					]),
					notice && react.createElement("div", { key: "n", style: noteStyle }, notice),
					body(),

					// ── 弹窗：tag 设置（标签运算 + 添加标签组）──
					settingsOpen && react.createElement(TagSettingsDialog, {
						key: "settings",
						initialExpression: expr,
						tags,
						templates,
						busy,
						onClose: () => setSettingsOpen(false),
						onSaved: async () => { setSettingsOpen(false); await load(); },
						subtitle: scope.isConv ? "保存到当前对话" : "保存到当前工作区",
						saveLabel: scope.isConv ? "保存到对话" : "保存到工作区",
						save: async (value) => {
							const d = await apiPost(scope.exprPath, { [scope.key]: scope.id, expression: value });
							if (!d?.ok) throw new Error(d?.error ?? "保存失败");
						},
					}),

					// ── 弹窗：精细化添加技能 ──
					pickOpen && react.createElement(SkillAddDialog, {
						key: "pick",
						addable,
						catalog,
						busy,
						onClose: () => setPickOpen(false),
						onPick: async (names) => {
							for (const n of names) {
								const ok = await call(scope.skillsPrefix + "/add", { skillName: n }, null);
								if (!ok) break;
							}
							setNotice(`已添加 ${names.length} 个技能`);
							setPickOpen(false);
						},
					}),

					// ── 弹窗：被禁用的技能 ──
					disabledOpen && react.createElement(DisabledSkillsDialog, {
						key: "dis",
						disabled: ws?.disabledSkills ?? [],
						catalog,
						busy,
						onClose: () => setDisabledOpen(false),
						onRestore: async (name) => {
							await call(scope.skillsPrefix + "/enable", { skillName: name }, `已恢复 ${name}`);
						},
					}),
				]));
		}



		// ── 「tag 设置」弹窗：标签运算 + 载入标签组 ────────────────────
		//
		// 与「编辑标签组」页共用同一套表达式引擎（服务端 src/domain/expr.js）。
		// 保存目标由调用方注入（save/saveLabel）：工作区版存到工作区，对话版存到对话。
		// 「添加标签组」只是把已存标签组的表达式载入运算区当起点，不改原标签组。
		function TagSettingsDialog({ initialExpression, tags, templates, busy, onClose, onSaved, subtitle, saveLabel, save }) {
			const [expr, setExpr] = react.useState(initialExpression ?? "");
			const [validation, setValidation] = react.useState(null);
			const [checking, setChecking] = react.useState(false);
			const [localNotice, setLocalNotice] = react.useState(null);
			const [tagQuery, setTagQuery] = react.useState("");
			const textareaRef = react.useRef(null);

			// 实时校验（250ms 防抖）：与服务端保存共用同一实现。
			// allowEmpty=true —— 工作区条件允许空表达式（空 = 无条件 = 掌握全部技能）。
			//
			// 空表达式在客户端直接短路，不依赖服务端是否已支持 allowEmpty：
			// 旧版服务端会一律回 EMPTY，那正是"一边说不能为空、一边说掌握全部技能"的
			// 自相矛盾来源。这里以客户端语义为准，保存时服务端也会用 allowEmpty 复核。
			react.useEffect(() => {
				let live = true;
				const timer = setTimeout(async () => {
					if (String(expr).trim() === "") {
						if (live) {
							setValidation({ ok: true, errors: [], warnings: [], normalized: "", config: { orTags: [], andGroups: [] } });
							setChecking(false);
						}
						return;
					}
					setChecking(true);
					try {
						const d = await apiPost("/templates/validate", { expression: expr, allowEmpty: true });
						if (!live) return;
						setValidation(d?.ok ? d.validation : { ok: false, errors: [{ message: d?.error ?? "校验失败", position: 0 }], warnings: [] });
					} catch (e) {
						if (live) setValidation({ ok: false, errors: [{ message: String(e?.message ?? e), position: 0 }], warnings: [] });
					} finally {
						if (live) setChecking(false);
					}
				}, 250);
				return () => { live = false; clearTimeout(timer); };
			}, [expr, tags.length]);

			const insertAtCursor = (text, opts = {}) => {
				const el = textareaRef.current;
				const cur = expr;
				const start = el && typeof el.selectionStart === "number" ? el.selectionStart : cur.length;
				const end = el && typeof el.selectionEnd === "number" ? el.selectionEnd : start;
				let insert = text;
				if (opts.operand) {
					const before = cur.slice(0, start).replace(/\s+$/, "");
					const prev = before.slice(-1);
					if (prev !== "" && prev !== "+" && prev !== "*" && prev !== "(") insert = " + " + insert;
					const after = cur.slice(end).replace(/^\s+/, "");
					const next = after.slice(0, 1);
					if (next !== "" && next !== "+" && next !== "*" && next !== ")") insert = insert + " + ";
				}
				setExpr(cur.slice(0, start) + insert + cur.slice(end));
				const caret = start + insert.length;
				setTimeout(() => {
					const e2 = textareaRef.current;
					if (!e2) return;
					e2.focus();
					try { e2.setSelectionRange(caret, caret); } catch { /* 放弃定位 */ }
				}, 0);
			};

			const doSave = async () => {
				if (!validation?.ok) {
					setLocalNotice("失败: " + (validation?.errors?.[0]?.message ?? "表达式未通过校验"));
					return;
				}
				setLocalNotice(null);
				try {
					await save(expr);
					await onSaved?.();
				} catch (e) {
					setLocalNotice("失败: " + (e?.message ?? e));
				}
			};

			const errors = validation?.errors ?? [];
			const warnings = validation?.warnings ?? [];
			// 空表达式 = 无条件：显示"无条件"而不是"∅"，避免与错误态混淆
			const preview = validation?.ok && validation.config
				? (expr.trim() === "" ? "无条件（掌握全部技能）" : configDisplay({ tags }, validation.config))
				: null;
			const visibleTags = tags.filter((t) => !tagQuery.trim() || t.name.toLowerCase().includes(tagQuery.trim().toLowerCase()));
			const panel = { border: "1px solid var(--theme-border,#333)", borderRadius: "10px", padding: "10px 12px", marginBottom: "10px" };
			const panelTitle = { fontWeight: 600, marginBottom: "6px", fontSize: "12px" };
			const chip = { display: "inline-flex", alignItems: "center", gap: "4px", border: "1px solid var(--theme-border,#444)", borderRadius: "8px", padding: "2px 8px", margin: "0 6px 6px 0", fontSize: "12px" };

			return react.createElement("div", { style: { ...overlayStyle, zIndex: 1200 }, onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
				react.createElement("div", { style: { ...modalBox, width: "760px" }, onClick: (e) => e.stopPropagation() }, [
					react.createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" } }, [
						react.createElement("strong", { key: "t", style: { fontSize: "14px" } }, "tag 设置"),
						react.createElement("span", { key: "w", style: { color: "#888", fontSize: "11px" } }, subtitle ?? "保存到当前工作区"),
						react.createElement("button", { key: "x", style: { ...btn, marginLeft: "auto" }, onClick: onClose }, "✕"),
					]),
					localNotice && react.createElement("div", { key: "n", style: { ...noteStyle, color: "#e74c3c" } }, localNotice),

					// ── 添加标签组：把已存表达式载入运算区 ──
					react.createElement("div", { key: "tpl", style: panel }, [
						react.createElement("div", { key: "tt", style: panelTitle }, "添加标签组"),
						templates.length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px" } }, "还没有标签组 — 可在设置页「编辑标签组」创建"),
						templates.length > 0 && react.createElement("div", { key: "row", style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } }, [
							react.createElement("select", {
								key: "sel", style: input, value: "",
								onChange: (e) => {
									const tpl = templates.find((t) => t.templateId === e.target.value);
									if (!tpl) return;
									// 载入 = 用它的表达式覆盖运算区（可继续编辑，不影响原标签组）
									setExpr(tpl.expression ?? "");
									setLocalNotice(`已载入标签组「${tpl.name}」的运算，可继续编辑`);
								},
							}, [
								react.createElement("option", { key: "h", value: "" }, "选择标签组载入…"),
								...templates.map((t) => react.createElement("option", { key: t.templateId, value: t.templateId },
									`${t.name} — ${t.expression || "(空)"}`)),
							]),
							react.createElement("span", { key: "hint", style: { color: "#888", fontSize: "11px" } },
								"载入后可在下方继续编辑；原标签组不受影响"),
						]),
					]),

					// ── 上方：已有标签 ──
					react.createElement("div", { key: "tags", style: panel }, [
						react.createElement("div", { key: "tt", style: { ...panelTitle, display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
							react.createElement("span", { key: "l" }, `已有标签 (${tags.length})`),
							react.createElement("input", {
								key: "q", style: { ...input, width: "160px" }, placeholder: "搜索标签…",
								value: tagQuery, onChange: (e) => setTagQuery(e.target.value),
							}),
						]),
						tags.length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px" } }, "还没有标签"),
						react.createElement("div", { key: "chips" }, visibleTags.map((t) => react.createElement("button", {
							key: t.tagId,
							style: { ...chip, cursor: "pointer", background: "transparent", color: "inherit" },
							disabled: busy,
							title: "插入表达式",
							onClick: () => insertAtCursor(quoteTagName(t.name), { operand: true }),
						}, t.name))),
					]),

					// ── 下方：运算区 ──
					react.createElement("div", { key: "expr", style: panel }, [
						react.createElement("div", { key: "et", style: panelTitle }, "表达式"),
						react.createElement("textarea", {
							key: "ta", ref: textareaRef,
							style: { ...input, width: "100%", minHeight: "80px", ...monoStyle, lineHeight: "1.5", resize: "vertical", boxSizing: "border-box" },
							placeholder: "例如: A+B*C  或  (A+B)*C；留空 = 清空条件（掌握全部技能）",
							value: expr,
							disabled: busy,
							onChange: (e) => setExpr(e.target.value),
						}),
						react.createElement("div", { key: "ops", style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "6px" } }, [
							react.createElement("span", { key: "l", style: { color: "#888", fontSize: "11px" } }, "插入:"),
							...[["+", "OR"], ["*", "AND"], ["(", ""], [")", ""]].map(([sym, label]) => react.createElement("button", {
								key: sym, style: { ...btn, ...monoStyle, padding: "1px 9px" }, disabled: busy,
								title: label ? `${sym} = ${label}` : `插入 ${sym}`,
								onClick: () => insertAtCursor(sym),
							}, sym + (label ? ` ${label}` : ""))),
							react.createElement("button", {
								key: "clr", style: { ...btn, color: "#e67e22", marginLeft: "auto" }, disabled: busy || !expr,
								onClick: () => { setExpr(""); setLocalNotice(null); },
							}, "清空"),
						]),
						react.createElement("div", { key: "val", style: { marginTop: "8px" } }, [
							checking && react.createElement("div", { key: "c", style: { color: "#888", fontSize: "12px" } }, "校验中…"),
							!checking && validation && validation.ok && react.createElement("div", { key: "ok", style: { color: "#2ecc71", fontSize: "12px" } },
								expr.trim() === "" ? "✓ 空条件 — 该工作区掌握全部技能" : "✓ 表达式合法"),
							!checking && validation && !validation.ok && errors.map((er, i) => react.createElement("div", { key: i, style: { color: "#e74c3c", fontSize: "12px", marginTop: "4px" } }, [
								react.createElement("span", { key: "m" }, "✗ " + er.message),
								typeof er.position === "number" && er.position >= 0 && react.createElement("button", {
									key: "loc", style: { ...btn, marginLeft: "8px", padding: "0 6px", fontSize: "11px" },
									onClick: () => {
										const el = textareaRef.current;
										if (!el) return;
										el.focus();
										const p = Math.min(er.position, el.value.length);
										try { el.setSelectionRange(p, Math.min(p + (er.length ?? 0), el.value.length)); } catch { /* 忽略 */ }
									},
								}, `定位 第${er.position + 1}字符`),
							])),
							!checking && warnings.map((w, i) => react.createElement("div", { key: "w" + i, style: { color: "#e6a23c", fontSize: "12px", marginTop: "4px" } }, "⚠ " + w.message)),
							!checking && preview && react.createElement("div", { key: "pv", style: { color: "#888", fontSize: "11px", marginTop: "2px" } }, "解析结果: " + preview),
						]),
						react.createElement("div", { key: "acts", style: { display: "flex", gap: "8px", marginTop: "10px", paddingTop: "8px", borderTop: "1px solid var(--theme-border,#222)" } }, [
							react.createElement("button", {
								key: "save", style: { ...btn, color: "#2ecc71" },
								disabled: busy || checking || !validation?.ok,
								onClick: () => void doSave(),
							}, saveLabel ?? "保存到工作区"),
							react.createElement("button", { key: "cancel", style: btn, disabled: busy, onClick: onClose }, "取消"),
						]),
						react.createElement("div", { key: "use", style: { color: "#888", fontSize: "11px", marginTop: "8px" } },
							"语法: + 表示 OR，* 表示 AND，优先级 * 高于 +，可用括号。空表达式 = 无条件。"),
					]),
				]));
		}

		// ── 弹窗：精细化添加技能（排除已有 + 被禁用的） ────────────────
		function SkillAddDialog({ addable, catalog, busy, onClose, onPick }) {
			const [picked, setPicked] = react.useState(() => new Set());
			const [q, setQ] = react.useState("");
			const pathOf = (name) => (catalog ?? []).find((s) => s.name === name)?.path ?? null;
			const toggle = (id) => setPicked((p) => {
				const n = new Set(p);
				if (n.has(id)) n.delete(id); else n.add(id);
				return n;
			});
			const list = (addable ?? []).filter((n) => !q.trim() || n.toLowerCase().includes(q.trim().toLowerCase()));
			return react.createElement("div", { style: { ...overlayStyle, zIndex: 1200 }, onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
				react.createElement("div", { style: { ...modalBox, width: "520px", maxHeight: "70vh" }, onClick: (e) => e.stopPropagation() }, [
					react.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", marginBottom: "10px" } }, [
						react.createElement("strong", { key: "t" }, "精细化添加技能"),
						react.createElement("button", { key: "x", style: { ...btn, marginLeft: "auto" }, onClick: onClose }, "✕"),
					]),
					react.createElement("div", { key: "hint", style: { color: "#888", fontSize: "11px", marginBottom: "8px" } },
						"已排除工作区已有的技能与被禁用的技能"),
					react.createElement("input", {
						key: "q", style: { ...input, width: "100%", marginBottom: "8px" }, placeholder: "搜索技能…", autoFocus: true,
						value: q, onChange: (e) => setQ(e.target.value),
					}),
					react.createElement("div", { key: "list", style: { flex: 1, overflowY: "auto", minHeight: "100px" } }, [
						list.length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px", padding: "10px 2px" } },
							"没有可添加的技能（全部已存在，或被禁用）"),
						...list.map((n) => react.createElement("div", { key: n, style: listRow }, [
							react.createElement("label", { key: "l", style: { display: "flex", alignItems: "center", gap: "8px", flex: 1, cursor: "pointer" } }, [
								react.createElement("input", { key: "c", type: "checkbox", checked: picked.has(n), onChange: () => toggle(n) }),
								react.createElement("span", { key: "n", style: { flex: 1 } }, n),
							]),
							react.createElement(RevealButton, { key: "rev", skillName: n, path: pathOf(n), label: "📁" }),
						])),
					]),
					react.createElement("div", { key: "f", style: { display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "10px" } }, [
						react.createElement("button", {
							key: "ok", style: { ...btn, color: "#2ecc71" }, disabled: busy || picked.size === 0,
							onClick: () => void onPick([...picked]),
						}, `添加 (${picked.size})`),
						react.createElement("button", { key: "c", style: btn, onClick: onClose }, "取消"),
					]),
				]));
		}

		// ── 弹窗：被禁用的技能（可恢复） ──────────────────────────────
		function DisabledSkillsDialog({ disabled, catalog, busy, onClose, onRestore }) {
			const pathOf = (name) => (catalog ?? []).find((s) => s.name === name)?.path ?? null;
			return react.createElement("div", { style: { ...overlayStyle, zIndex: 1200 }, onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
				react.createElement("div", { style: { ...modalBox, width: "520px", maxHeight: "70vh" }, onClick: (e) => e.stopPropagation() }, [
					react.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", marginBottom: "10px" } }, [
						react.createElement("strong", { key: "t" }, `被禁用的技能 (${(disabled ?? []).length})`),
						react.createElement("button", { key: "x", style: { ...btn, marginLeft: "auto" }, onClick: onClose }, "✕"),
					]),
					react.createElement("div", { key: "list", style: { flex: 1, overflowY: "auto", minHeight: "100px" } }, [
						(disabled ?? []).length === 0 && react.createElement("div", { key: "e", style: { color: "#888", fontSize: "12px" } }, "没有被禁用的技能"),
						...(disabled ?? []).map((n) => react.createElement("div", { key: n, style: listRow }, [
							react.createElement("span", { key: "n", style: { flex: 1, color: "#e74c3c" } }, n),
							react.createElement(RevealButton, { key: "rev", skillName: n, path: pathOf(n), label: "📁" }),
							react.createElement("button", {
								key: "r", style: { ...btn, color: "#2ecc71" }, disabled: busy,
								onClick: () => void onRestore(n),
							}, "恢复"),
						])),
					]),
					react.createElement("div", { key: "f", style: { display: "flex", justifyContent: "flex-end", marginTop: "10px" } },
						react.createElement("button", { key: "c", style: btn, onClick: onClose }, "关闭")),
				]));
		}

		function apply(ctx) {
			ctx.effect(
				() => ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "dsh-skill-tag",
					order: 70,
					label: () => "Skill 标签",
				}, Section)),
				"dsh-skill-tag: settings page",
			);
			// 「管理标签」浮层：走官方 shell.overlay 槽位（root scope, kind:list）
			ctx.effect(
				() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "dsh-skill-tag.manage-tags",
				}, OverlayHost)),
				"dsh-skill-tag: manage tags overlay",
			);
			// 「管理标签」入口（工作区）：宿主工作区行菜单无插件槽位，只能 DOM 注入
			ctx.effect(() => installWorkspaceMenuInjector(), "dsh-skill-tag: workspace menu entry");
			// 「管理标签」入口（对话）：会话行菜单**有官方槽位**
			//   sidebar.workspaces.session.menu.item  kind:list scope:root
			//   宿主已占 pin(100) rename(200) fork(300) archive(400) session-id(450)
			//   → 我们放在 500，排在「复制 Session ID」之后。
			ctx.effect(
				() => ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "dsh-skill-tag.manage-tags-session",
					order: 500,
				}, SessionManageMenuItem)),
				"dsh-skill-tag: session menu entry",
			);
			// 「管理对话标签」入口（聊天框左下角「+」→ / 命令菜单）
			//   走 commandUi 的客户端贡献位，kind:"action"，选中即执行、不发消息
			registerComposerEntry(ctx);
		}

		exports.apply = apply;
		exports.inject = inject;
		// test hooks (pure helpers, no DOM)
		exports.__test = {
			zoneOf, conversationRows, configSummary, configDisplay, tagNameOf, quoteTagName,
			skillsLinkedTo, skillsNotLinkedTo, ZONE_LABEL,
			workspaceIdOfRowKey, isWorkspaceMenu, manage, manageSet,
			manageScope, registerComposerEntry,
			skillPathOf, RevealButton, ownedTagsFirst,
			// 失效技能判定（三处界面共用同一套口径，单独测）
			staleSetOf, tagHasStale, partitionStaleSkills, STALE_COLOR,
		};
		return module.exports;
	},
});
