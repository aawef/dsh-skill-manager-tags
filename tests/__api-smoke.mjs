// 临时验收脚本：用内存仓库 + 真实 createApiHandler 起一个本地 HTTP 服务，
// 通过真实 HTTP 走一遍"新建/回显/校验/求值/删除"全链路。
import http from "node:http";
import { createServices } from "../src/service.js";
import { createMemoryRepository } from "../src/storage/repository.js";
import { createApiHandler } from "../src/api.js";

const repo = createMemoryRepository();
const services = createServices(repo);
await services.ready();
await services.tags.create("t-a", "A");
await services.tags.create("t-b", "B");
await services.tags.create("t-c", "C");
await services.tags.create("t-mt", "my tag");

const server = http.createServer(createApiHandler(services, console, () => []));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/skill-tag/api`;

const post = async (path, body) => {
	const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
	return { status: r.status, json: await r.json() };
};

let failures = 0;
const check = (label, cond, extra) => {
	if (cond) console.log(`  ok   ${label}`);
	else { failures += 1; console.log(`  FAIL ${label} ${extra ? JSON.stringify(extra) : ""}`); }
};

console.log("[1] 校验接口");
let r = await post("/templates/validate", { expression: "A+B*C" });
check("A+B*C 合法", r.json.validation?.ok === true, r.json);
check("规范化表达式", r.json.validation?.normalized === "A + B * C", r.json.validation);
check("config.orTags=[t-a]", JSON.stringify(r.json.validation?.config?.orTags) === '["t-a"]', r.json.validation?.config);

r = await post("/templates/validate", { expression: "(A+B)*C" });
check("(A+B)*C 合法且产生两个 AND 子句", r.json.validation?.ok === true && r.json.validation?.config?.andGroups?.length === 2, r.json.validation);

r = await post("/templates/validate", { expression: "(A+B" });
check("括号不匹配 → 400 + UNBALANCED_PAREN", r.status === 200 && r.json.validation?.errors?.[0]?.code === "UNBALANCED_PAREN", r.json);

r = await post("/templates/validate", { expression: "   " });
check("空表达式 → EMPTY", r.json.validation?.errors?.[0]?.code === "EMPTY", r.json);

r = await post("/templates/validate", { expression: "A+ZZZ" });
check("不存在标签 → UNKNOWN_TAG", r.json.validation?.errors?.[0]?.code === "UNKNOWN_TAG", r.json);

r = await post("/templates/validate", { expression: '"my tag"+A' });
check("引号标签可用", r.json.validation?.ok === true, r.json.validation);

console.log("[2] 新建 + 回显");
r = await post("/templates", { templateId: "tpl-1", name: "前端组", expression: "A+B*C" });
check("新建成功", r.json.ok === true && r.json.template?.expression === "A+B*C", r.json);
const created = r.json.template;

r = await post("/state", {});
const listed = r.json.templates?.find((t) => t.templateId === "tpl-1");
check("列表回显表达式", listed?.expression === "A+B*C", listed);
check("列表回显 config", JSON.stringify(listed?.config) === JSON.stringify(created.config), listed?.config);
check("有 createdAt/updatedAt", Boolean(listed?.createdAt && listed?.updatedAt), listed);

console.log("[3] 编辑 + 再次回显");
r = await post("/templates/update", { templateId: "tpl-1", name: "前端组v2", expression: "(A+B)*C" });
check("更新成功", r.json.ok === true, r.json);
r = await post("/state", {});
const reloaded = r.json.templates?.find((t) => t.templateId === "tpl-1");
check("再次读取仍是新表达式（不回退为空）", reloaded?.expression === "(A+B)*C", reloaded);
check("名称已更新", reloaded?.name === "前端组v2", reloaded?.name);

console.log("[4] 非法保存被拒");
r = await post("/templates/update", { templateId: "tpl-1", expression: "A+" });
check("末尾运算符 → 400", r.status === 400 && r.json.ok === false, { status: r.status, json: r.json });
r = await post("/state", {});
check("失败后磁盘数据未变", r.json.templates.find((t) => t.templateId === "tpl-1").expression === "(A+B)*C", null);

console.log("[5] 求值（下游打标签）");
r = await post("/templates/evaluate", { templateId: "tpl-1", activeTagIds: ["t-a", "t-c"] });
check("A+C 满足 (A+B)*C", r.json.matched === true, r.json);
r = await post("/templates/evaluate", { templateId: "tpl-1", activeTagIds: ["t-a"] });
check("仅 A 不满足", r.json.matched === false, r.json);

console.log("[6] 删除");
r = await post("/templates/delete", { templateId: "tpl-1" });
check("删除成功", r.json.ok === true, r.json);
r = await post("/state", {});
check("列表已空", (r.json.templates ?? []).length === 0, r.json.templates);

console.log("[7] 重名拒绝");
await post("/templates", { templateId: "tpl-a", name: "同名", expression: "A" });
r = await post("/templates", { templateId: "tpl-b", name: "同名", expression: "B" });
check("重名 → 失败", r.json.ok === false && /already exists/.test(r.json.error), r.json);

await new Promise((r) => server.close(r));
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
