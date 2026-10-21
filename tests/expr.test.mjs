import { test } from "node:test";
import assert from "node:assert/strict";

import {
	parse, tokenize, validateExpression, toDnf, dnfToConfig, evaluateDnf,
	quoteName, needsQuote, formatExpression, configToExpression,
	renameTagInExpression, removeTagFromExpression, ExprError,
} from "../src/domain/expr.js";

const TAGS = [
	{ tagId: "t-a", name: "A" },
	{ tagId: "t-b", name: "B" },
	{ tagId: "t-c", name: "C" },
];
const v = (src, tags = TAGS) => validateExpression(src, { tags });

// ── 语法与优先级 ────────────────────────────────────────────────────────────

test("A+B*C 解析为 A OR (B AND C)", () => {
	const r = v("A+B*C");
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	const c = r.config;
	assert.deepEqual(c.orTags, ["t-a"]);
	assert.deepEqual(c.andGroups, [{ groupId: "t-b|t-c", tagIds: ["t-b", "t-c"] }]);
});

test("(A+B)*C 解析为 (A OR B) AND C", () => {
	const r = v("(A+B)*C");
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	assert.deepEqual(r.config.orTags, []);
	const ids = r.config.andGroups.map((g) => [...g.tagIds].sort().join(",")).sort();
	assert.deepEqual(ids, ["t-a,t-c", "t-b,t-c"]);
});

test("括号不影响语义但改变分组: A+B+C 全部进 orTags", () => {
	const r = v("A+B+C");
	assert.equal(r.ok, true);
	assert.deepEqual(r.config.orTags.sort(), ["t-a", "t-b", "t-c"]);
	assert.deepEqual(r.config.andGroups, []);
});

test("* 与 + 混合的右结合/左结合都正确求值", () => {
	const dnf = v("A*B+C").dnf;
	assert.equal(evaluateDnf(dnf, ["t-a", "t-b"]), true);
	assert.equal(evaluateDnf(dnf, ["t-c"]), true);
	assert.equal(evaluateDnf(dnf, ["t-a"]), false);
});

test("全角符号归一：（）＋＊ 等价于半角", () => {
	const r = v("（A＋B）＊C");
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	assert.equal(r.dnf.length, 2);
});

// ── 错误与边界 ──────────────────────────────────────────────────────────────

test("空表达式报 EMPTY", () => {
	const r = v("   ");
	assert.equal(r.ok, false);
	assert.equal(r.errors[0].code, "EMPTY");
});

test("括号不匹配：缺 ')' / 多余 ')'", () => {
	assert.equal(v("(A+B").errors[0].code, "UNBALANCED_PAREN");
	assert.equal(v("A+B)").errors[0].code, "UNBALANCED_PAREN");
	assert.equal(v("()").errors[0].code, "EXPECTED_OPERAND");
});

test("运算符误用：开头运算符 / 结尾运算符 / 连续运算符 / 相邻操作数", () => {
	assert.equal(v("*A").errors[0].code, "EXPECTED_OPERAND");
	assert.equal(v("A+").errors[0].code, "TRAILING_OPERATOR");
	assert.equal(v("A+*B").errors[0].code, "EXPECTED_OPERAND");
	assert.equal(v("AB").errors[0].code === "UNKNOWN_TAG" || v("AB").errors[0].code === "EXPECTED_OPERATOR", true);
	assert.equal(v("A B").errors[0].code, "EXPECTED_OPERATOR");
});

test("标签不存在报 UNKNOWN_TAG 且带位置", () => {
	const r = v("A+ZZZ");
	assert.equal(r.ok, false);
	assert.equal(r.errors[0].code, "UNKNOWN_TAG");
	assert.equal(r.errors[0].position, 2);
	assert.match(r.errors[0].message, /标签不存在/);
});

test("非法字符报 ILLEGAL_CHAR", () => {
	const r = v("A#B");
	assert.equal(r.ok, false);
	assert.ok(["ILLEGAL_CHAR", "UNKNOWN_TAG"].includes(r.errors[0].code));
});

test("引号未闭合报 UNTERMINATED_STRING", () => {
	const r = v('"abc');
	assert.equal(r.errors[0].code, "UNTERMINATED_STRING");
});

test("重复标签只告警、结果去重", () => {
	const r = v("A+A");
	assert.equal(r.ok, true);
	assert.equal(r.warnings[0].code, "DUPLICATE_TAG");
	assert.deepEqual(r.config.orTags, ["t-a"]);

	const r2 = v("A*A");
	assert.equal(r2.ok, true);
	// A*A 语义是单个标签，等价 A；展开后单元素子句进 orTags
	assert.deepEqual(r2.config.orTags, ["t-a"]);
	assert.deepEqual(r2.config.andGroups, []);
});

test("表达式过长报 TOO_LONG", () => {
	const long = Array.from({ length: 1200 }, () => "A").join("+");
	const r = validateExpression(long, { tags: TAGS, maxLength: 100 });
	assert.equal(r.errors[0].code, "TOO_LONG");
});

test("DNF 爆炸保护：括号内多个 OR 交叉", () => {
	const tags = Array.from({ length: 12 }, (_, i) => ({ tagId: "t" + i, name: "T" + i }));
	const expr = "(" + tags.slice(0, 6).map((t) => t.name).join("+") + ")*(" +
		tags.slice(6).map((t) => t.name).join("+") + ")";
	const r = validateExpression(expr, { tags, maxDnfTerms: 8 });
	assert.equal(r.ok, false);
	assert.equal(r.errors[0].code, "DNF_TOO_LARGE");
});

// ── 求值（下游打标签使用） ──────────────────────────────────────────────────

test("evaluateDnf: A+B*C 的命中判定", () => {
	const { dnf } = v("A+B*C");
	assert.equal(evaluateDnf(dnf, ["t-a"]), true);
	assert.equal(evaluateDnf(dnf, ["t-b", "t-c"]), true);
	assert.equal(evaluateDnf(dnf, ["t-b"]), false);
	assert.equal(evaluateDnf(dnf, []), false);
});

test("evaluateDnf: (A+B)*C 必须同时具备 C", () => {
	const { dnf } = v("(A+B)*C");
	assert.equal(evaluateDnf(dnf, ["t-a", "t-c"]), true);
	assert.equal(evaluateDnf(dnf, ["t-b", "t-c"]), true);
	assert.equal(evaluateDnf(dnf, ["t-a"]), false);
	assert.equal(evaluateDnf(dnf, ["t-a", "t-b"]), false);
});

// ── 引用与字面量 ────────────────────────────────────────────────────────────

test("含空格/运算符的标签名必须加引号", () => {
	assert.equal(needsQuote("A"), false);
	assert.equal(needsQuote("my tag"), true);
	assert.equal(needsQuote("a+b"), true);
	assert.equal(quoteName("my tag"), '"my tag"');
	assert.equal(quoteName("A"), "A");
	const r = validateExpression('"my tag"+A', { tags: [...TAGS, { tagId: "t-mt", name: "my tag" }] });
	assert.equal(r.ok, true, JSON.stringify(r.errors));
	assert.deepEqual(r.config.orTags.sort(), ["t-a", "t-mt"]);
});

test("formatExpression 输出最少括号的规范式", () => {
	assert.equal(formatExpression(parse("(A+B)*C")), "(A + B) * C");
	assert.equal(formatExpression(parse("A+(B*C)")), "A + B * C");
	assert.equal(formatExpression(parse("((A))")), "A");
});

test("configToExpression 由结构化配置反推表达式（旧数据迁移）", () => {
	const idToName = new Map([["t-a", "A"], ["t-b", "B"], ["t-c", "C"]]);
	const expr = configToExpression({ orTags: ["t-a"], andGroups: [{ groupId: "t-b|t-c", tagIds: ["t-b", "t-c"] }] }, idToName);
	assert.equal(expr, "A + (B * C)");
	// 反推回来的表达式必须能解析回等价配置
	const r = validateExpression(expr, { tags: TAGS });
	assert.equal(r.ok, true);
	assert.deepEqual(r.config.orTags, ["t-a"]);
	assert.deepEqual(r.config.andGroups, [{ groupId: "t-b|t-c", tagIds: ["t-b", "t-c"] }]);
});

test("renameTagInExpression 原位替换并保留原有写法", () => {
	assert.equal(renameTagInExpression("A + (B*C)", "B", "Beta"), "A + (Beta*C)");
	assert.equal(renameTagInExpression("A+B", "C", "X"), "A+B");
	// 旧名是另一个名称的子串时不能被误替换（按 token 而非字符串）
	assert.equal(renameTagInExpression("AB + A", "A", "Z"), "AB + Z");
});

test("removeTagFromExpression 保持 AND/OR 语义", () => {
	assert.equal(removeTagFromExpression("A*B", "A"), "B");
	assert.equal(removeTagFromExpression("A+B", "A"), "B");
	assert.equal(removeTagFromExpression("A*B+C", "B"), "A + C");
	assert.equal(removeTagFromExpression("A", "A"), "");
});

test("tokenize 保留位置信息", () => {
	const t = tokenize("A+B");
	assert.equal(t[0].start, 0);
	assert.equal(t[1].start, 1);
	assert.equal(t[2].start, 2);
});

test("ExprError 携带 code/position", () => {
	try {
		parse("(A");
		assert.fail("should throw");
	} catch (e) {
		assert.ok(e instanceof ExprError);
		assert.equal(e.code, "UNBALANCED_PAREN");
	}
});

test("dnfToConfig 与 toDnf 互逆（配置可回放）", () => {
	const r = v("(A+B)*C");
	// 等价写法 A*C + B*C 展开后应得到同一套子句
	const r2 = v("A*C + B*C");
	assert.deepEqual(dnfToConfig(r.dnf).andGroups.map((g) => g.groupId).sort(), dnfToConfig(r2.dnf).andGroups.map((g) => g.groupId).sort());
	assert.deepEqual(dnfToConfig(r.dnf).andGroups.map((g) => g.groupId).sort(), ["t-a|t-c", "t-b|t-c"]);
});
