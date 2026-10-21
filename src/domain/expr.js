// skill-tag-plugin — 标签组布尔表达式引擎（纯函数，无 I/O、无 DSH 依赖）
//
// 表达式文法（EBNF）:
//   Expr    := Or
//   Or      := And ( '+' And )*
//   And     := Atom ( '*' Atom )*
//   Atom    := '(' Expr ')' | TagName
//   TagName := IDENT | STRING
//
// 语义: '+' = OR, '*' = AND, 优先级 '*' > '+', 支持括号。
//   A+B*C   ≡ A OR (B AND C)
//   (A+B)*C ≡ (A OR B) AND C
//
// 设计要点：
// 1. 表达式是标签组的唯一事实来源；下游（打标签/筛选）使用由它推导出的
//    DNF（析取范式 = 若干 AND 子句的 OR），与既有 TagConfig
//    {orTags, andGroups} 完全同构，因此历史匹配引擎无需改动。
// 2. 标签以「名称」引用（名称全局唯一，见 service.js tagStore.create）；
//    名称含操作符/空格/括号时必须用引号包裹："my tag"、"a+b"。
// 3. 所有错误带 code + position，供 UI 就地提示。

/** @typedef {'EMPTY'|'ILLEGAL_CHAR'|'UNTERMINATED_STRING'|'UNBALANCED_PAREN'|'EXPECTED_OPERAND'|'EXPECTED_OPERATOR'|'TRAILING_OPERATOR'|'UNKNOWN_TAG'|'TOO_LONG'|'DNF_TOO_LARGE'} ExprErrorCode */
/** @typedef {{code:string, message:string, position:number, length:number}} ExprIssue */

export class ExprError extends Error {
	constructor(code, message, position = 0, length = 0) {
		super(message);
		this.name = "ExprError";
		this.code = code;
		this.position = position;
		this.length = length;
	}
}

// 全角字符归一：中文输入法下用户常打出 （）＋＊，应视为同一个记号，
// 而不是"非法字符"。位置按原字符计，提示仍指向用户所见文本。
const FULLWIDTH = new Map([
	["（", "("],
	["）", ")"],
	["＋", "+"],
	["＊", "*"],
	["　", " "],
]);

const IDENT_STOP = new Set(["(", ")", "+", "*", '"', "'"]);

/** 名称是否必须加引号才能作为裸标识符出现 */
export function needsQuote(name) {
	const s = String(name ?? "");
	if (s === "") return true;
	for (const ch of s) {
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return true;
		if (IDENT_STOP.has(ch)) return true;
		if (FULLWIDTH.has(ch) && FULLWIDTH.get(ch) !== " ") return true;
	}
	return false;
}

/** 把标签名渲染成表达式里的字面量（必要时加引号并转义） */
export function quoteName(name) {
	const s = String(name ?? "");
	if (!needsQuote(s)) return s;
	return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * 词法分析。返回 token 序列：
 *   {type:'('|')'|'+'|'*', value, start, end}
 *   {type:'tag', value:<名称>, start, end, quoted}
 * @param {string} src
 * @throws {ExprError}
 */
export function tokenize(src) {
	const text = String(src ?? "");
	/** @type {any[]} */
	const tokens = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const mapped = FULLWIDTH.get(ch);
		if (mapped !== undefined) {
			if (mapped !== " ") tokens.push({ type: mapped, value: mapped, start: i, end: i + 1 });
			i += 1;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i += 1; continue; }
		if (ch === "(" || ch === ")" || ch === "+" || ch === "*") {
			tokens.push({ type: ch, value: ch, start: i, end: i + 1 });
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let j = i + 1;
			let out = "";
			while (j < text.length && text[j] !== quote) {
				if (text[j] === "\\" && j + 1 < text.length) { out += text[j + 1]; j += 2; continue; }
				out += text[j];
				j += 1;
			}
			if (j >= text.length) {
				throw new ExprError("UNTERMINATED_STRING", `引号未闭合：缺少结尾的 ${quote}（位置 ${i + 1}）`, i, text.length - i);
			}
			tokens.push({ type: "tag", value: out, start: i, end: j + 1, quoted: true });
			i = j + 1;
			continue;
		}
		let j = i;
		while (j < text.length) {
			const c = text[j];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") break;
			if (IDENT_STOP.has(c)) break;
			if (FULLWIDTH.has(c)) break;
			j += 1;
		}
		if (j === i) {
			throw new ExprError("ILLEGAL_CHAR", `非法字符 '${ch}'（位置 ${i + 1}）`, i, 1);
		}
		tokens.push({ type: "tag", value: text.slice(i, j), start: i, end: j, quoted: false });
		i = j;
	}
	return tokens;
}

/**
 * 语法分析 → AST。
 * 节点：{type:'tag', name, start, end} | {type:'group', inner, start, end}
 *      | {type:'and'|'or', left, right, start, end}
 * @param {string} src
 * @throws {ExprError}
 */
export function parse(src) {
	const text = String(src ?? "");
	const tokens = tokenize(text);
	if (tokens.length === 0) throw new ExprError("EMPTY", "表达式为空：请点击上方标签写入，或用 A+B*C 的形式输入", 0, 0);
	let p = 0;

	const parseOr = () => {
		let node = parseAnd();
		while (tokens[p] && tokens[p].type === "+") {
			const op = tokens[p];
			p += 1;
			if (p >= tokens.length) {
				throw new ExprError("TRAILING_OPERATOR", "'+' 之后缺少标签或 '('", op.start, 1);
			}
			const right = parseAnd();
			node = { type: "or", left: node, right, start: node.start, end: right.end };
		}
		return node;
	};

	const parseAnd = () => {
		let node = parseAtom();
		while (tokens[p] && tokens[p].type === "*") {
			const op = tokens[p];
			p += 1;
			if (p >= tokens.length) {
				throw new ExprError("TRAILING_OPERATOR", "'*' 之后缺少标签或 '('", op.start, 1);
			}
			const right = parseAtom();
			node = { type: "and", left: node, right, start: node.start, end: right.end };
		}
		return node;
	};

	const parseAtom = () => {
		const tok = tokens[p];
		if (!tok) {
			throw new ExprError("EXPECTED_OPERAND", "表达式不完整：此处需要标签或 '('", text.length, 0);
		}
		if (tok.type === "tag") {
			p += 1;
			return { type: "tag", name: tok.value, start: tok.start, end: tok.end, quoted: !!tok.quoted };
		}
		if (tok.type === "(") {
			p += 1;
			if (tokens[p] && tokens[p].type === ")") {
				throw new ExprError("EXPECTED_OPERAND", "空括号 '()' 不合法：括号内必须有标签", tok.start, 2);
			}
			const inner = parseOr();
			const close = tokens[p];
			if (!close) {
				throw new ExprError("UNBALANCED_PAREN", "括号不匹配：缺少 ')'", tok.start, 1);
			}
			if (close.type !== ")") {
				if (close.type === "tag") {
					throw new ExprError("EXPECTED_OPERATOR", `缺少运算符：'${close.value}' 之前需有 '+' 或 '*'`, close.start, close.end - close.start);
				}
				throw new ExprError("UNBALANCED_PAREN", "括号不匹配：缺少 ')'", tok.start, 1);
			}
			p += 1;
			return { type: "group", inner, start: tok.start, end: close.end };
		}
		if (tok.type === ")") {
			throw new ExprError("UNBALANCED_PAREN", "括号不匹配：多余的 ')'", tok.start, 1);
		}
		throw new ExprError("EXPECTED_OPERAND", `运算符 '${tok.value}' 之前缺少标签或 '('`, tok.start, 1);
	};

	const ast = parseOr();
	if (p < tokens.length) {
		const tok = tokens[p];
		if (tok.type === ")") throw new ExprError("UNBALANCED_PAREN", "括号不匹配：多余的 ')'", tok.start, 1);
		if (tok.type === "tag") {
			throw new ExprError("EXPECTED_OPERATOR", `缺少运算符：'${tok.value}' 之前需有 '+' 或 '*'`, tok.start, tok.end - tok.start);
		}
		throw new ExprError("TRAILING_OPERATOR", `表达式末尾有多余内容 '${tok.value}'`, tok.start, tok.end - tok.start);
	}
	return ast;
}

// ── AST 工具 ────────────────────────────────────────────────────────────────

const stripGroup = (node) => (node.type === "group" ? stripGroup(node.inner) : node);

/** 深度优先收集标签节点（按出现顺序） */
export function collectTagNodes(ast) {
	/** @type {any[]} */
	const out = [];
	const walk = (node) => {
		if (!node) return;
		if (node.type === "tag") { out.push(node); return; }
		if (node.type === "group") { walk(node.inner); return; }
		walk(node.left);
		walk(node.right);
	};
	walk(ast);
	return out;
}

/**
 * 按名称解析出带 tagId 的新 AST；未命中的名称进入 unknown。
 * @param {any} ast
 * @param {Map<string, {tagId:string, name:string}>} byName
 */
export function resolveAst(ast, byName) {
	/** @type {{name:string, start:number, end:number}[]} */
	const unknown = [];
	const walk = (node) => {
		const n = stripGroup(node);
		if (n.type === "tag") {
			const hit = byName.get(n.name);
			if (!hit) { unknown.push({ name: n.name, start: n.start, end: n.end }); return { type: "tag", name: n.name, tagId: null, start: n.start, end: n.end }; }
			return { type: "tag", name: n.name, tagId: hit.tagId, start: n.start, end: n.end };
		}
		const left = walk(n.left);
		const right = walk(n.right);
		return { type: n.type, left, right, start: n.start, end: n.end };
	};
	return { ast: walk(ast), unknown };
}

/** 规范化渲染：最小化括号，必要时给名称加引号 */
export function formatExpression(ast) {
	if (!ast) return "";
	const render = (node, parentType) => {
		const n = stripGroup(node);
		if (n.type === "tag") return quoteName(n.name);
		const isOr = n.type === "or";
		const inner = isOr
			? `${render(n.left, "or")} + ${render(n.right, "or")}`
			: `${render(n.left, "and")} * ${render(n.right, "and")}`;
		// '*' 优先级高于 '+'：AND 的子节点若是 OR 必须加括号。
		const needParen = parentType === "and" && isOr;
		return needParen ? `(${inner})` : inner;
	};
	// 顶层 OR 的子节点若是 AND 无需括号（* 已高于 +）；顶层 AND 的子节点若是 OR 必须括号。
	return render(ast, null);
}

/**
 * 解析 → AST → DNF（析取范式）。
 * DNF = 若干 AND 子句的 OR，每个子句是 tagId 数组；与既有 TagConfig 同构。
 * @param {any} ast 已解析 tagId 的 AST（可含 group 节点）
 * @param {{maxTerms?:number}} [opts]
 * @returns {string[][]}
 * @throws {ExprError} DNF_TOO_LARGE
 */
export function toDnf(ast, opts = {}) {
	const maxTerms = opts.maxTerms ?? 512;
	const dedupe = (clauses) => {
		const seen = new Set();
		const out = [];
		for (const c of clauses) {
			const key = [...c].sort().join("\u0001");
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(c);
		}
		return out;
	};
	// 吸收律：若已有子句是当前子句的真子集，则当前子句冗余（A OR A*B = A）。
	const absorb = (clauses) => {
		const sorted = [...clauses].sort((a, b) => a.length - b.length);
		const kept = [];
		for (const c of sorted) {
			const set = new Set(c);
			const redundant = kept.some((k) => k.every((t) => set.has(t)));
			if (!redundant) kept.push(c);
		}
		return kept;
	};
	const combineAnd = (l, r) => {
		if (l.length * r.length > maxTerms) {
			throw new ExprError("DNF_TOO_LARGE", `表达式展开后条件过多（上限 ${maxTerms} 项）：请减少括号内的 OR 交叉组合`, 0, 0);
		}
		/** @type {string[][]} */
		const out = [];
		for (const a of l) {
			for (const b of r) out.push([...new Set([...a, ...b])]);
		}
		return absorb(dedupe(out));
	};
	const walk = (node) => {
		const n = stripGroup(node);
		if (n.type === "tag") {
			if (!n.tagId) throw new ExprError("UNKNOWN_TAG", `未定义标签 '${n.name}'`, n.start, n.end - n.start);
			return [[n.tagId]];
		}
		const l = walk(n.left);
		const r = walk(n.right);
		if (n.type === "or") return absorb(dedupe([...l, ...r]));
		return combineAnd(l, r);
	};
	return walk(ast);
}

/** DNF → 既有 TagConfig（单标签子句进 orTags，多标签子句进 andGroups） */
export function dnfToConfig(dnf) {
	const orTags = [];
	const andGroups = [];
	for (const clause of dnf ?? []) {
		const ids = [...new Set(clause)];
		if (ids.length === 1) {
			if (!orTags.includes(ids[0])) orTags.push(ids[0]);
		} else if (ids.length > 1) {
			const groupId = [...ids].sort().join("|");
			if (!andGroups.some((g) => g.groupId === groupId)) {
				andGroups.push({ groupId, tagIds: ids });
			}
		}
	}
	return { orTags, andGroups };
}

/**
 * 判断标签集合是否满足 DNF（= 该标签组是否命中）。
 * @param {string[][]} dnf
 * @param {Iterable<string>} activeTagIds
 * @returns {boolean}
 */
export function evaluateDnf(dnf, activeTagIds) {
	const active = activeTagIds instanceof Set ? activeTagIds : new Set(activeTagIds ?? []);
	for (const clause of dnf ?? []) {
		if (clause.length === 0) return true;
		if (clause.every((t) => active.has(t))) return true;
	}
	return false;
}

/**
 * 旧数据迁移：把结构化 TagConfig 渲染成表达式。
 * @param {{orTags:string[], andGroups:{tagIds:string[]}[]}|undefined} config
 * @param {Map<string, string>} idToName
 */
export function configToExpression(config, idToName) {
	const parts = [];
	for (const id of config?.orTags ?? []) {
		const name = idToName.get(id);
		if (name !== undefined) parts.push(quoteName(name));
	}
	for (const g of config?.andGroups ?? []) {
		const names = (g.tagIds ?? []).map((id) => idToName.get(id)).filter((n) => n !== undefined);
		if (names.length >= 2) parts.push("(" + names.map(quoteName).join(" * ") + ")");
	}
	return parts.join(" + ");
}

/**
 * 标签改名后同步改写表达式文本：按 token 原位替换，保留用户原有的空格/大小写/
 * 括号写法（不重新格式化）。解析失败时原样返回（宁可留旧文本也不要破坏数据）。
 * @param {string} src
 * @param {string} oldName
 * @param {string} newName
 */
export function renameTagInExpression(src, oldName, newName) {
	const text = String(src ?? "");
	if (!text.trim()) return text;
	let tokens;
	try { tokens = tokenize(text); } catch { return text; }
	const hits = tokens.filter((t) => t.type === "tag" && t.value === oldName);
	if (hits.length === 0) return text;
	let out = text;
	for (let i = hits.length - 1; i >= 0; i -= 1) {
		const t = hits[i];
		const replacement = t.quoted ? '"' + String(newName).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"' : quoteName(newName);
		out = out.slice(0, t.start) + replacement + out.slice(t.end);
	}
	return out;
}

/**
 * 标签被全局删除后，从表达式里摘除该标签并保持语义：
 *   A*B 去 A → B ; A+B 去 A → B ; 全部删空 → ""
 * @param {string} src
 * @param {string} name
 * @returns {string}
 */
export function removeTagFromExpression(src, name) {
	const text = String(src ?? "");
	if (!text.trim()) return text;
	let ast;
	try { ast = parse(text); } catch { return text; }
	const prune = (node) => {
		const n = stripGroup(node);
		if (n.type === "tag") return n.name === name ? null : n;
		const left = prune(n.left);
		const right = prune(n.right);
		if (!left) return right;
		if (!right) return left;
		return { type: n.type, left, right };
	};
	const pruned = prune(ast);
	return pruned ? formatExpression(pruned) : "";
}

// ── 校验（唯一入口，UI 与写库共用） ─────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {ExprIssue[]} errors
 * @property {ExprIssue[]} warnings
 * @property {string|null} normalized   规范化后的表达式（可用于回填/比对）
 * @property {string[]} tagIds          引用到的标签 id（首次出现顺序）
 * @property {string[][]|null} dnf      可执行条件（下游打标签用）
 * @property {{orTags:string[],andGroups:{groupId:string,tagIds:string[]}[]}|null} config
 */

/**
 * 校验表达式合法性。
 *
 * 空表达式有两种合法语义，由 `allowEmpty` 显式区分，避免同一实现自相矛盾：
 * - `allowEmpty: false`（默认，标签组）：标签组必须有运算，空 = 非法。
 * - `allowEmpty: true`（工作区条件）：空 = 无条件 = 掌握全部技能，合法。
 *
 * @param {string} src
 * @param {{tags?:{tagId:string,name:string}[], maxDnfTerms?:number, maxLength?:number, allowEmpty?:boolean}} [opts]
 * @returns {ValidationResult}
 */
export function validateExpression(src, opts = {}) {
	const tags = opts.tags ?? [];
	const maxDnfTerms = opts.maxDnfTerms ?? 512;
	const maxLength = opts.maxLength ?? 2000;
	const allowEmpty = opts.allowEmpty === true;
	const text = String(src ?? "");
	/** @type {ExprIssue[]} */
	const errors = [];
	/** @type {ExprIssue[]} */
	const warnings = [];
	const fail = (result) => ({ ok: false, errors, warnings, normalized: null, tagIds: [], dnf: null, config: null, ...result });

	if (text.trim() === "") {
		if (allowEmpty) {
			// 无条件的"空真"表达式：命中一切（DNF 用单个空子句表示，evaluateDnf 对空子句恒真）
			return { ok: true, errors, warnings, normalized: "", tagIds: [], dnf: [[]], config: { orTags: [], andGroups: [] } };
		}
		errors.push({ code: "EMPTY", message: "表达式不能为空：请点击上方标签写入，或用 A+B*C 的形式输入", position: 0, length: 0 });
		return fail({});
	}
	if (text.length > maxLength) {
		errors.push({ code: "TOO_LONG", message: `表达式过长（${text.length} 字符，上限 ${maxLength}）`, position: 0, length: 0 });
		return fail({});
	}

	let ast;
	try {
		ast = parse(text);
	} catch (e) {
		if (!(e instanceof ExprError)) throw e;
		errors.push({ code: e.code, message: e.message, position: e.position, length: e.length });
		return fail({});
	}

	const byName = new Map(tags.map((t) => [t.name, t]));
	const { ast: resolved, unknown } = resolveAst(ast, byName);
	for (const u of unknown) {
		errors.push({
			code: "UNKNOWN_TAG",
			message: `标签不存在: '${u.name}'${suggestName(u.name, tags)}`,
			position: u.start,
			length: u.end - u.start,
		});
	}

	const nodes = collectTagNodes(resolved);
	const counts = new Map();
	for (const n of nodes) counts.set(n.name, (counts.get(n.name) ?? 0) + 1);
	for (const [name, n] of counts) {
		if (n > 1) {
			warnings.push({
				code: "DUPLICATE_TAG",
				message: `标签 '${name}' 重复出现 ${n} 次，已自动去重（A+A 等价于 A，A*A 等价于 A）`,
				position: 0,
				length: 0,
			});
		}
	}

	const tagIds = [];
	for (const n of nodes) {
		if (n.tagId && !tagIds.includes(n.tagId)) tagIds.push(n.tagId);
	}

	if (errors.length > 0) return fail({ tagIds });

	let dnf;
	try {
		dnf = toDnf(resolved, { maxTerms: maxDnfTerms });
	} catch (e) {
		if (!(e instanceof ExprError)) throw e;
		errors.push({ code: e.code, message: e.message, position: e.position, length: e.length });
		return fail({ tagIds });
	}

	return {
		ok: errors.length === 0,
		errors,
		warnings,
		normalized: formatExpression(resolved),
		tagIds,
		dnf,
		config: dnfToConfig(dnf),
	};
}

/** 未命中标签的近似建议（只做廉价的包含/编辑距离 1 判断） */
function suggestName(name, tags) {
	const lower = String(name).toLowerCase();
	const close = tags
		.filter((t) => {
			const n = String(t.name).toLowerCase();
			return n.includes(lower) || lower.includes(n) || editDistanceAtMost1(n, lower);
		})
		.slice(0, 3)
		.map((t) => `'${t.name}'`);
	return close.length ? `，是否想用 ${close.join(" / ")}?` : "";
}

function editDistanceAtMost1(a, b) {
	if (Math.abs(a.length - b.length) > 1) return false;
	let i = 0;
	let j = 0;
	let diff = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) { i += 1; j += 1; continue; }
		diff += 1;
		if (diff > 1) return false;
		if (a.length > b.length) i += 1;
		else if (a.length < b.length) j += 1;
		else { i += 1; j += 1; }
	}
	return diff + (a.length - i) + (b.length - j) <= 1;
}
