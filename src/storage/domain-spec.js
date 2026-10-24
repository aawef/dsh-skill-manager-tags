// skill-tag-plugin — 本地 domain spec 构造器
//
// 为什么不用 @deepseek-ai/dsh-storage-domain：
//
// 宿主已经通过 ctx.storageDomain.open(spec) 把 domain 能力注入进来了，插件真正
// 需要的只是把 spec 构造宿主认识的形状：
//
//   { name, version, tables: { <tableName>: { valueSchema } }, global?, layout?, ... }
//
// 而宿主的 defineDomain 只做「校验 + 原样返回」，domainTable 只做
// `{ valueSchema: schema }`。为了这两个纯函数去 import 内核包，会让 pnpm 必须
// 在 profile 里再装一份 @deepseek-ai/dsh-storage-domain 实体，与宿主内置的同名
// 模块形成「同一模块两份不同版本」——宿主每次升级（rc.2 → rc.3）都会因为旧副本
// 被运行时判定不兼容而拒绝加载该插件，导致存储域整体不启动、会话与工作区列表
// 全空。该故障在 0.2.0-rc.2 时代已经发生过一次（见 profiles/desktop/
// pnpm-workspace.yaml 的 historical 注释），当时的做法是挪版本号 + 人工提醒，
// 属于在地基上缝补。
//
// 现在改为本地等价实现，插件对宿主内核包零 import 依赖：升级宿主不再需要同步
// 任何版本号，也不再有双份模块。
//
// 校验规则与宿主保持一致（宿主 @deepseek-ai/dsh-storage 的 UNIT_NAME_RE 为
// /^[a-z][a-z0-9_]*$/；domain 名与表名都必须匹配）。宿主在 open() 时仍会二次
// 校验，这里的校验只是让配置错误在模块加载时就暴露。

const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * 声明一张表：宿主只要求 { valueSchema } 这一层包装。
 * @param {import("zod").ZodTypeAny} schema - 行记录的 zod schema
 */
export function domainTable(schema) {
	return { valueSchema: schema };
}

/**
 * 声明一个 domain：校验后原样返回 spec（与宿主 defineDomain 行为一致）。
 * @param {object} spec - { name, version, tables, global?, layout?, compatibleVersions?, invalidRecords? }
 */
export function defineDomain(spec) {
	if (!UNIT_NAME_RE.test(spec.name)) {
		throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
	}
	if (!Number.isInteger(spec.version) || spec.version < 0) {
		throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
	}
	for (const compat of spec.compatibleVersions ?? []) {
		if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) {
			throw new Error(
				`domain '${spec.name}' compatibleVersions entries must be non-negative integers below version ${spec.version}, got ${compat}`,
			);
		}
	}
	if (spec.layout !== void 0 && spec.layout !== "single" && spec.layout !== "per-record") {
		throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${spec.layout}`);
	}
	if (spec.invalidRecords !== void 0 && spec.invalidRecords !== "backup-and-skip") {
		throw new Error(`domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present, got ${spec.invalidRecords}`);
	}
	for (const table of Object.keys(spec.tables)) {
		if (!UNIT_NAME_RE.test(table)) {
			throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`);
		}
	}
	// 宿主的 global schema 不接受 null：null 是介质的「从未写入」哨兵，
	// 存进去的 null 无法与「不存在」区分，重新打开会静默回落到 initial。
	if (spec.global !== void 0 && spec.global.schema.safeParse(null).success) {
		throw new Error(
			`domain '${spec.name}' global schema must not accept null: null is the medium's "never written" sentinel`,
		);
	}
	return spec;
}
