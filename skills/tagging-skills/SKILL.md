---
name: tagging-skills
description: 给本机技能（skill）批量打标签，让工作区/对话能用一条布尔表达式选出技能子集。Use when the user asks to tag, categorize, organize or label skills, or wonders how skill tags work in dsh-skill-tag.
---

# 给技能打标签

dsh-skill-tag 插件用**标签 + 布尔表达式**从几十上百个技能里选出一个子集下发给
模型。打标签的目的不是做分类学，而是让「用户想说的那句话」能写成一条表达式。

> 完整手册（含全部 API 路由、错误对照表、交付检查清单）在插件目录下的
> `docs/给技能打标签.md` —— 本文件的同安装目录内，需要细节时读它。

## 铁律

1. **不要照抄文档里的标签名**。`aegis`、`mattpocock-skills-dsh`、`office-skills`
   只是某一台机器上的实例。用下面的**推导法**在你自己机器的技能清单上生成标签。
2. **来源轴靠路径推导，不靠手写名单**。
3. **`/skills/tags` 的写是整体覆盖** —— 写之前必须先读回旧 `tagIds` 再合并，
   否则会清掉已有标签。这是最容易踩的坑。
4. **`candidates` 的数量是唯一验收标准**，不是「看起来差不多」。

## 步骤

### 1. 拿清单

端口每台机器不同，不要猜：用你运行时上下文里的 DSH Web GUI URL，或
`netstat -ano -p tcp | grep LISTENING` 找 dsh 进程的端口。

```bash
curl -s "http://127.0.0.1:<PORT>/skill-tag/api/skills"
# → { ok:true, skills:[{name, description, path, source}] }
```

少了很多 → 加 `cwd` 再试（项目级 `.dsh/skills` 要传 cwd 才扫得到）。

### 2. 来源轴（自动推导）

按 `path` 从上往下匹配：

| 条件 | 来源标签 |
|---|---|
| 含 `/node_modules/<pkg>/` | 包名（`@scope/name` 保留 scope） |
| 含 `/resources/runtime/<dir>/` | 那个目录名 |
| `path` 为 null 或含 `.asar` | `builtin` |
| 其余 | `<home>/.dsh/skills`→`dsh-home`；`<home>/.agents/skills`→`agents-home`；项目级同名根→`project-skills`/`project-agents`；自定义根→根目录最后一段 |

再给「非 `dsh-home`/`agents-home`/`project-skills`/`project-agents`」的额外共挂
`plugin`，于是 `<包名> * plugin` = 「只要这个包带来的技能」。

`builtin` 那堆若名字有公共前缀（如 `office*`），**手工补一个来源标签**。

### 3. 领域轴（读 description，无自动推导）

先聚类再命名；一个领域标签至少挂 2 个技能；**跨包归类才有价值**；总数 10~25 个。

### 4. 路由轴

description 里写着「Use when… / Router over the skills / Load to choose」的是
**路由器**：它本身挂 `router`，它 + 它路由到的整簇挂 `routes:<路由器名>`。
于是 `routes:office` = 整簇，`router * routes:office` = 只要路由器。

### 5. 落地

```bash
# 0) 现状（复用已有 tagId，同名创建会报错）
curl -s ".../state"

# 1) 建标签：tagId 形如 t-<Date.now().toString(36)>
curl -s -X POST ".../tags" -d '{"tagId":"t-lz3k1","name":"pdf"}'

# 2) 读回旧的 → 合并 → 覆盖写
curl -s ".../skills/tags?skillName=pdf"                      # → { tagIds:[...] }
curl -s -X POST ".../skills/tags" -d '{"skillName":"pdf","tagIds":["t-a","t-b"]}'

# 3) 校验表达式 → 存进工作区 → 看选中了谁
curl -s -X POST ".../templates/validate" -d '{"expression":"pdf+docx"}'
curl -s -X POST ".../workspaces/expression" -d '{"workspaceId":"…","expression":"pdf + docx"}'
curl -s -X POST ".../workspaces/skills"   -d '{"workspaceId":"…"}'   # → candidates
```

### 6. 一键脚本（插件自带）

```bash
node <插件目录>/tools/auto-tag.mjs http://127.0.0.1:<PORT>                 # dry-run
node <插件目录>/tools/auto-tag.mjs http://127.0.0.1:<PORT> --apply          # 只落地来源轴
node <插件目录>/tools/auto-tag.mjs ... --domain ./my-domain-map.json --apply
```

映射文件形如 `{"pdf":["pdf","translate-pdf"]}`。脚本幂等：重跑应输出
`tagsCreated: 0`、`unknownNames: []`。

## 表达式语法

`+`=OR、`*`=AND、`*` 优先、可加括号。标签名含空格或 `+ * ( )` 引号时必须加引号 ——
所以起名一律用 kebab-case 小写。

## 常见错误

| 现象 | 原因 |
|---|---|
| `tag name 'X' already exists` | 同名重复创建，先读 `/state` 复用 tagId |
| 打完标签旧标签没了 | `/skills/tags` 整体覆盖，没先读回旧 tagIds |
| `template 'null' not found` | `/templates/evaluate`、`/templates/expand` 要 `templateId` |
| 技能数偏少 | 没传 `cwd` |
| `candidates` 数量不对 | 标签打漏或表达式写错 —— 以此为准 |
