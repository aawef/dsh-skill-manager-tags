// domain-hints.mjs — 领域轴的**启发式起点**（不是结论）。
//
// 为什么只是起点：领域轴要读 description 才能判对，`auto-tag.mjs --domain hints`
// 只会给出建议，人工复核（或改写成自己的映射文件）后才应 --apply。
//
// 匹配方式：关键词是**正则**（大小写不敏感），对 `name + description` 匹配。
// 用正则而不是子串，是为了避免 `test` 命中 `pressure-test` 这种误判 —— 关键词
// 请一律带 `\b` 或足够的上下文。一个技能可以被建议多个领域标签。

/**
 * @type {Record<string, string[]>}
 * 键 = 建议的领域标签名，值 = 正则关键词。
 */
export const DOMAIN_KEYWORDS = {
	"code-review": ["\\breview(ing)?\\b", "\\bcode review\\b", "评审"],
	pdf: ["\\bpdf\\b"],
	docx: ["\\bdocx\\b", "\\bword document\\b", "word 文档"],
	xlsx: ["\\bxlsx\\b", "\\bspreadsheet\\b", "\\bexcel\\b", "表格"],
	pptx: ["\\bpptx\\b", "\\bslides?\\b", "\\bdecks?\\b", "演示", "幻灯片"],
	diagram: ["\\bdiagram\\b", "\\bmermaid\\b", "\\bdrawio\\b", "\\binkscape\\b", "架构图"],
	"cli-anything": ["cli-anything", "command-line interface"],
	planning: ["\\bplans?\\b", "\\bplanning\\b", "\\bspec\\b", "\\btickets?\\b", "\\broadmap\\b", "计划"],
	testing: ["\\btdd\\b", "\\btesting\\b", "test-driven", "\\bevals?\\b", "\\bbenchmark\\b"],
	debugging: ["\\bdebug(ging)?\\b", "\\bdiagnos", "\\bbugs?\\b", "调试", "排查"],
	git: ["\\bgit\\b", "merge conflict", "\\bworktrees?\\b", "\\brebase\\b"],
	memory: ["\\bmemory\\b", "\\bhindsight\\b", "\\bremember\\b", "记忆"],
	"doc-writing": ["\\bdocumentation\\b", "\\bwriting docs\\b", "\\btechnical specs?\\b", "写文档"],
	web: ["\\bweb\\b", "\\bbrowser\\b", "\\bhtml\\b", "网页"],
	"dsh-ops": ["\\bdsh\\b", "\\bprofiles?\\b", "\\bsandbox\\b", "\\bacl\\b", "\\bpwsh\\b"],
	mcp: ["\\bmcp\\b", "model context protocol"],
	"visual-design": ["\\bvisual design\\b", "\\btypography\\b", "\\bbrand\\b", "\\btheme\\b", "\\bfront-?end design\\b"],
	interview: ["\\bgrill", "\\binterview\\b", "\\bquestionnaire\\b", "pressure-?test"],
	architecture: ["\\barchitecture\\b", "\\bdomain model(ing)?\\b", "\\bcodebase\\b", "架构", "领域模型"],
	"agent-workflow": ["\\bsubagents?\\b", "parallel agents", "\\bagent session\\b", "long-?task", "\\bcontinuation\\b"],
	teaching: ["\\bteach(ing)?\\b", "\\btutorial\\b", "教学"],
};

const COMPILED = Object.fromEntries(
	Object.entries(DOMAIN_KEYWORDS).map(([tag, pats]) => [tag, pats.map((p) => new RegExp(p, "i"))]),
);

/**
 * 建议一个技能的领域标签。
 * @param {{name:string, description?:string}} skill
 * @returns {string[]}
 */
export function suggestDomains(skill) {
	const hay = `${skill?.name ?? ""} ${skill?.description ?? ""}`;
	const out = [];
	for (const [tag, regexes] of Object.entries(COMPILED)) {
		if (regexes.some((re) => re.test(hay))) out.push(tag);
	}
	return out;
}
