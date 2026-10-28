# CHANGELOG

## 0.1.8 — 2026-10-28 修复：README 预览图间歇性加载失败（改用 jsDelivr）

### 症状

GitHub 仓库页与 npm 包页的 README「界面预览」6 张图经常整块空白，刷新几次可能恢复，
也可能一直不显示。图片本身没坏：`images/` 下 6 个 PNG 的签名、尺寸、IEND 块全部正常，
直接 `curl` 也能拿到 200 与正确 Content-Type。

### 根因

README 里 6 个 `<img src>` 全部直连 `raw.githubusercontent.com`。该域名同时有 A 与 AAAA 记录，
而本机所在网络到它的 **IPv6 实际不通**：

- `curl -6` 拉图：5/5 全部 15s 超时，`%{remote_ip}` 为空或停在 `2606:50c0:8000::154`
- `curl -4` 拉图：5/5 全部 200，耗时 0.94–1.81s

浏览器在「IPv6 优先（RFC 8305 Happy Eyeballs）」下会先试 AAAA；回落到 IPv4 需要几百毫秒
到数秒，且在该域名上并不总能成功回落，于是表现为图片时好时坏。这也解释了为什么
「GitHub 页面能打开、图却出不来」——页面主体走的是 `github.com`（本机 hosts 里被钉到
20.205.243.166，纯 IPv4），图片走的是另一个域名。

### 改法

6 个 `<img src>` 统一换成 jsDelivr：

```
https://cdn.jsdelivr.net/gh/aawef/dsh-skill-manager-tags@main/images/<name>.png
```

实测（同一台机器、同一网络）：jsDelivr 30 次请求 0 失败、中位 150ms，IPv4/IPv6 均可达；
`raw.githubusercontent.com` 30 次请求 1 次硬失败、中位 732ms。README 第 33 行的说明也一并
改成「用 jsDelivr 绝对地址」，并写明不用 raw 的原因。

### 为什么锁分支而不是锁 tag

先试过 `@v0.1.7`（锁 tag 可彻底避开分支缓存），但那样**替换 `images/` 里的同名图片不会自动生效**，
每次换图都得发版本并手改 6 行 URL。改成 `@main` 后换图零成本，代价是 jsDelivr 的分支缓存
最长约 12 小时（`Cache-Control: max-age=604800, s-maxage=43200`）才刷新。

### 这次也顺带把 npm 上的 README 刷新了

npm 包页展示的是**发布时打包进 tarball 的 README 快照**，改了仓库不会回填。0.1.8 重新发布后，
npm 页的 6 张图同样走 jsDelivr。


## 0.1.7 — 2026-10-27 修复：手动添加的技能被旧口径兜底反向屏蔽

### 症状

`tagging-skills` 在「对话 → 管理标签」右列明明显示为「手动」，`view.visible` 里也有它，
但模型侧完全看不到：`skill` 工具报 `skill "tagging-skills" is not available for
model invocation`，`/skill-tag/api/skills` 返回的 description 是
`"[blocked by skill-tag] tagging-skills"`、`source: "skill-tag"`。

### 根因

`lib/index.js` 的 `recomputeDenials()` 把两段拒绝集**无条件并集**：

1. `workspaceDeniedSkills()` —— 新口径，懂 `manualSkills` / `disabledSkills`，
   对 `tagging-skills` 判定为「放行」；
2. `computeDeniedSkillIds()` —— 旧口径兜底，只算 `linkedSkillIds − candidates`，
   **完全不知道 manualSkills 的存在**。

`tagging-skills` 只挂了来源标签（`dsh平台配置` / `来自:dsh-skill-tag` / `来自:插件`），
不在任何标签规则的命中集合里，却“已打标签” → 被第 2 段判 deny → 覆盖第 1 段的放行。
于是 `createFilterProvider` 给它发了一条 `invocation: {modelInvocable:false,
userInvocable:false}` 的影子，宿主 `isModelInvocable` 把它过滤掉，模型就再也看不见它。

兜底段原本的注释前提是「universe 扫不到这个名字」，但代码里**没有这个前提判断**，
它是无条件全覆盖的 —— 于是任何「打过标签 + 只靠手动添加」的技能都会被误伤。
本机实测：全机 106 个技能里，受害者仅 `tagging-skills` 一个（它是唯一这种形态的技能），
所以症状看起来像单点失灵，实际是通用逻辑缺陷。

### 改动

`lib/index.js`：

- 新增导出 `computeRuntimeDeniedSkillIds(effective, { universe, candidates, linkedSkillIds })`，
  把「新口径 ∪ 旧口径兜底」的合并规则收进一个可测的纯函数，并把兜底原本的口头前提
  写成代码 —— 两道闸：
  1. 新口径**已放行**的名字（标签命中 ∪ 手动添加 − 禁用）绝不再 deny；
  2. `universe` 里存在的名字已由新口径给出判定，兜底不重复表态。
  剩下的才进 denied —— 那才是真正需要兜底的历史残留（已卸载但标签关联还在的名字）。
- `recomputeDenials()` 改为调用该函数，删掉原先内联的无条件并集。

`tests/runtime.test.mjs`：新增 4 条回归用例 ——

- 手动添加的技能不被旧口径兜底重新屏蔽（本次 bug 的正面用例）；
- 禁用优先级高于手动添加；
- 兜底仍覆盖 `universe` 扫不到的历史残留名字（`ghost`）；
- `universe` 命中的名字即使不在 `candidates` 也不受兜底影响。

### 验证

- `node --test tests/runtime.test.mjs`：**31 / 31 通过**（含新增 4 条）。
- `npm test`：203 项，198 通过，5 项失败 —— 全部是 `skilltags.test.mjs` 里
  `mkdtemp` / `spawn` 在沙箱下 `EPERM` 的旧问题（与本次改动无关，未触碰 `src/reveal.js`）。
- 用这台机器的真实 state 复算：修复前 denied=49（含 `tagging-skills`），
  修复后 denied=48（不含），`archify` 等真正的漏网技能仍被屏蔽。
- 源目录 `dsh-skill-tag/待提交/lib/index.js` 与 desktop 安装副本
  `~/.dsh/profiles/desktop/node_modules/dsh-skill-tag/lib/index.js` 已 `cmp` 一致。

### 生效方式

改的是宿主侧插件代码，需**重启桌面进程**让宿主重新加载插件并重算 denied 集合。

## 2026-10-24 — 0.1.6：管理标签界面三处改进（技能搜索框 / 窗口定高 / 已有标签优先）

本节是 0.1.6 的发布说明，细节见下面三节。

1. **「管理标签」右列新增技能搜索框**（工作区版 / 对话版共用）。只剩一个输入框和
   「清除」按钮，标题在有搜索词时变成 `技能 (匹配/总数)`，让人看得出是被过滤了。
   搜索**只过滤显示**：`view.visible`、手动添加、禁用、继承、实际下发给模型的集合全都不变。
   无匹配时给「没有匹配「xxx」的技能。」，与「本来就没有技能」区分开。
2. **浮层高度固定为 82vh**。第一版只写了 `maxHeight`，搜索越准、行数越少、窗口就越小，
   每敲一个字母窗口抖一下。定高之后只有中间列表滚动，边框与底部按钮位置不动。
3. **「skill 联系 tag」右列把该技能已有的标签排到最前面**，稳定分区、组内保持原序，
   和搜索可叠加；勾选态与写库内容都不受影响。

### 验证

三处各有渲染级测试：`tests/__manage-render.mjs`（13 项，含搜索过滤与高度不变）、
`tests/__page-render.mjs`（23 项，含排序与搜索叠加、`ownedTagsFirst` 纯函数）。
其余测试文件全绿；`skilltags.test.mjs` 中 5 条涉及 `mkdtemp`/`spawn` 的用例在本机
沙箱下以 EPERM 失败，与本次改动无关（未触碰 `src/`）。

## 2026-10-24 — 改进：`skill 联系 tag` 页把技能已有的标签排到前面

### 背景

右列原本按服务端返回顺序（基本是标签名字母序）平铺所有标签。技能已经拥有的那 5 个标签，
往往散落在几十行里，要确认"这个技能到底挂了什么"只能靠底部的「已拥有: …」文字，
在列表里反而看不出来。

### 改动

`lib/client.js`：

1. 新增纯函数 `ownedTagsFirst(tags, ownedIds)`（模块级，已挂到 `exports.__test`）：

   ```js
   function ownedTagsFirst(tags, ownedIds) {
       const owned = new Set(ownedIds ?? []);
       const yes = [];
       const no = [];
       for (const t of tags ?? []) (owned.has(t?.tagId) ? yes : no).push(t);
       return [...yes, ...no];
   }
   ```

   **稳定分区**：只把已拥有的提到前面，两个分区内部都保持原顺序，不打乱字母序里的相对位置；
   拥有的 id 在 `tags` 里不存在（幽灵/已删标签）时不会凭空插入一项。
2. `SkillTagPage` 用它算 `tagsOrdered`，再按搜索词过滤成 `tagsShown` 渲染。
   排序与搜索可叠加：过滤后仍然"已拥有的在前"。
3. **只是显示顺序**——`owned` 集合、勾选态、`/skills/tags` 写库内容都不变。

### 验证

`tests/__page-render.mjs` 新增 3 条：
① 拥有 `C` 与 `a+b` 时列表变成 `["C","a+b","A","B","my tag"]` 且勾选态 `[true,true,false,false,false]`；
② 搜索 `a` 时结果为 `["a+b","A","my tag"]`（已拥有的仍最先）；
③ `ownedTagsFirst` 本身的分区/空集/幽灵 id 行为。
`__page-render` 现 23 项全过，其余文件不受影响。

## 2026-10-24 — 新增：右列技能列表顶部搜索框（工作区版 / 对话版共用）

### 背景

「管理标签」浮层右列会把该作用域下发给模型的**全部**技能平铺出来，实际工作区有上百个技能，
找某一个只能靠滚动，「查看 tag」「禁用」这些行内操作也因此很难点到目标行。

### 改动

`lib/client.js` 的 `ManageTagsDialog`（两版共用同一个组件，只由 `manageScope()` 决定端点）：

1. 新增状态 `skillSearch`，右列标题下方插入一个 `type="search"` 输入框（placeholder「搜索技能…」），
   非空时右侧出现「清除」按钮；
2. 新增派生变量，只用于显示：

   ```js
   const skillQuery = skillSearch.trim().toLowerCase();
   const shownSkills = (view.visible ?? []).filter((n) => !skillQuery || String(n).toLowerCase().includes(skillQuery));
   ```

   - **只过滤显示**，`view.visible`、`addable`、禁用/添加/继承等动作都不受影响 ——
     搜索框不是筛选条件，改它不会改变实际下发给模型的技能集合；
   - 大小写不敏感；
3. 标题在有搜索词时显示 `技能 (匹配数/总数)`，让「被过滤了」这件事可见（不会误以为技能变少了）；
4. 空结果分两种文案：技能集合本身为空 → 原来的「没有技能…」；有技能但无匹配 → 「没有匹配「xxx」的技能。」。

### 验证

`tests/__manage-render.mjs` 新增一条渲染测试：搜索框存在且只有一个、输入 `alp` 后标题变
`技能 (1/3)` 且只剩 alpha、`GAMMA` 大写同样命中、无匹配时出提示而不是「没有技能」、
点「清除」后恢复 `技能 (3)` 且清除按钮消失。全套 14 个测试文件仍全绿
（`__conv-render` 14、`__manage-render` 13、`__page-render` 20、其余各文件通过，`__api-smoke` ALL CHECKS PASSED）。

### 后续（同日）：搜索时窗口不能跟着缩小

第一版只给浮层写了 `maxHeight: 82vh`，没有确定高度。结果搜索越准、右列行数越少，
浮层就被内容撑得越小，每敲一个字母窗口都抖一下。改为在双列浮层上写死
`height: "82vh"`（`{ ...modalBox, height: "82vh" }`）：左右两列本来就有 `flex: 1` 的滚动区与
底部按钉按钮，高度定住后只有中间列表滚动，窗口尺寸恒定。
`tests/__manage-render.mjs` 再加一条：取浮层主体断言 `style.height === "82vh"`，
并在搜到 1 条、0 条时断言高度不变（`__manage-render` 13 项全过）。

## 2026-10-24 — 0.1.5：解除对宿主内核包 `dsh-storage-domain` 的依赖

### 现象

DSH 升级到 `0.2.1-rc.3` 后，**侧栏所有工作区与对话消失**。数据本身没有丢
（`~/.dsh/storages/workspace.json` 与 `~/.dsh/sessions/**` 都完好），是界面读不到。

### 根因

本插件此前 `import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain"`。
为了让这个裸导入能解析，安装时 profile 的 `package.json` 里必须再装一份
`@deepseek-ai/dsh-storage-domain` 实体 —— 而宿主 `app.asar` 里本来就内置了同名模块。
于是同一个进程里出现**同一模块的两份不同版本**：

- profile 里那份被钉在 `0.2.1-rc.2`；
- 宿主升级成 `0.2.1-rc.3` 后，运行时按 `includePrerelease` 的 semver 校验判定旧副本不兼容，
  直接拒绝加载（见 `profiles/desktop/.plugin-manager/logs/*/pnpm.log`）；
- 存储域整体未启动 → `ctx.storageDomain` 缺失 → workspace/session 列表为空。

同一结构问题在 `0.2.0-rc.2` 时代已经发生过一次，当时的处置是「把依赖从插件挪到 profile +
留一句升级时记得同步改版本号的人工提醒」。升级 rc.3 时没人同步 → 原样复发。只要插件还持有
宿主内核包的副本，每次宿主升级都必然再炸一次。

### 做法

1. 新增 `src/storage/domain-spec.js`，本地实现 `defineDomain` / `domainTable`：
   - 宿主的 `defineDomain` 实际只做「校验 + 原样返回 spec」，`domainTable` 只是 `{ valueSchema }`
     包装，复刻成本极低；
   - 校验规则与宿主一致（`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`、version 非负整数、
     `compatibleVersions` 低于 version、`global.schema` 不接受 `null` 等）。
2. `src/storage/schema.js` 改为从本地模块引入；宿主能力仍走 `ctx.storageDomain.open(skillTagDomain)`，
   这部分本来就没变。
3. 删除 `peerDependencies["@deepseek-ai/dsh-storage-domain"]` —— 插件对宿主内核包零 import，
   不再需要任何声明。
4. `engines.dsh` 由版本白名单（`0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-rc.2 || >=0.2.1 <1.0.0`）
   改为半开区间 **`>=0.2.0-rc.1 <1.0.0`**。

### 为什么改成半开区间就不会再漏

宿主校验用的是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，
预发布版本参与比较；并且**插件只要写了 `engines.dsh`，`peerDependencies` 完全不参与判定**
（宿主源码 `unmetRequirements`）。所以一个半开区间即可覆盖 `0.2.1-rc.3`、未来的 `rc.4`、
`0.2.2-rc.1` 以及 `0.2.1` 正式版，不必每次宿主发版都回来改白名单。

用宿主自带 semver 实测：

```
✅ >=0.2.0-rc.1 <1.0.0  vs 0.2.1-rc.3   / 0.2.1-rc.4 / 0.2.2-rc.1 / 0.2.1
❌ 旧白名单              vs 0.2.1-rc.3   （这就是被拒的原因）
```

### 升级建议

**强烈建议从 0.1.4 升级到 0.1.5**：0.1.4 在 DSH ≥ `0.2.1-rc.3` 上会被判不兼容而跳过后台加载，
并可能连带让整个存储域无法上台。装完 0.1.5 后，profile 里不再需要
`@deepseek-ai/dsh-storage-domain` 这一行，可以删掉（若之前手动加过）。

### 验证

- 本仓库测试 194/194 通过；
- 宿主 profile 重装后 `@deepseek-ai/` 顶层只剩 `cosmokit` / `schemastery` 两个通用库，
  不再有任何内核包副本；
- 升级后工作区与历史对话正常显示。


## 2026-10-22（补）— 修复：`/被屏蔽的技能名` 会让界面卡死（provider.get 自递归）

### 现象

用户敲一轮 `/<某个被屏蔽的技能>`（例如 `/office-docx`），agent 的 pre-step 永不 resolve，
界面像卡住一样，没有任何报错。

### 根因

`userInvocable:false` 并不能挡住这条路径 —— `dsh-tool-skill` 的 `agent/pre-step` 对
`/name` 手势是**先 `ctx.skills.get(name)` 再判 `isUserInvocable`**（宿主源码 line 909）。
而宿主 `registry.get()` 的流程是：

```
collect() → 选中胜出候选（agent 层里就是我们的影子）→ 调影子自己的 provider.get()
```

我们的 `provider.get()` 原来会 `upstream.getDefinition()` → 又回到 `registry.get(name)`
→ 又选中影子 → 又是我们 …… 每轮都是 await，**栈不涨、Promise 永不 settle**，
所以表现为静默挂死而不是爆栈。实测探针里 `registry.get` 被反复调用到人为设的上限。

补一句：模型侧走 `skill` 工具**不会**撞上这个坑 —— 那边先 `list()` 找 summary，
影子 `modelInvocable:false` 会直接抛 `not available for model invocation`（line 874-875）。
只有 `/name` 手势（人打的）才先 get。

### 改动

`lib/index.js` `createFilterProvider.get()`：被 `denied` 命中的名字**就地返回** deny 定义
（`content: ""`），不再回问宿主。本来影子也没有正文可给，所以对外行为不变，只是断掉回环。

### 测试

- 新增两条：get 被屏蔽的名字时上游 `getDefinition`/`summaries` 调用次数必须为 0，
  且返回的定义能过宿主 `validateDefinition` 的形状校验；放行的名字照旧拿到真正文。
- 全量 194 通过 0 失败。
- 探针（`probe-get-loop.mjs`）：修前 `registry.get` 调用 6 次（人为截断），修后 **0** 次。


## 2026-10-22 — 修复：包/插件带来的技能永远屏蔽不掉（17 个静默漏网）

### 现象

模型侧技能目录 71 条，插件口径 `universe 105 / visible 54 / denied 51`。
按名字对账：71 − 17 = 54 = `visible`，**恰好 17 个该屏蔽的技能原样漏给模型**。

漏网名单干净得可疑 —— 全部是"不由文件系统技能根提供"的那些：

- aegis 4（using-aegis / update-aegis / writing-skills / communicating-concisely）
- mattpocock 4（ask-matt / research / teach / writing-for-agents）
- archify 1、本插件的 tagging-skills 1、office 7（`path` 为 null）

被成功屏蔽的 34 个则**全部**来自 `~/.dsh/skills` + `~/.agents/skills`。
日志、右列界面、`/skill-tag/api/skills` 都是对的（105），只有模型侧少影子 ——
所以这是**静默失效**，长期没被发现。

### 根因

`createFilterProvider.list()` 只遍历 `upstream.summaries()` 的结果发影子，
即**发射范围 = 本次能看到的 summary**。而 `createUpstreamAdapter.summaries()` 在
`nesting.depth > 0` 时会整段跳过宿主快照，只剩扫盘结果；守卫之所以被占住，是因为
`apply()` 里 `createUpstreamAdapter` 与 `createSkillDiscoverer` **共用同一份
`snapshotGuard`** —— 设置页 / UI 快照 / 另一个 agent 的收集 / 并发刷新任一在飞，
否认路径就被连坐降级。

于是"看得见"和"看不见"的分界线，恰好就是"文件系统根"和"别的 provider"的分界线。

### 改动

`lib/index.js`：

1. **影子按名字发**（根治）：`list()` 分两段 —— 看得见的照抄 summary（保留
   `path` / 描述）；看不见的直接构造最小合法候选。屏蔽按键名生效，不依赖可见性。
2. **两个出口各用一份重入计数器**：递归那圈只在 adapter 内部，
   `createSkillDiscoverer` 不在回路里，共用只会互相连坐；发现器另加同 key 并发合并。
3. **观测**（方案 C）：发生补发时 warn 一行 `shadow backfill ... backfilled=N`，
   降级时附 `hostSnapshot=skipped(nested)`；健康路径不刷日志。

顺带修正：

- 影子 `rank` 统一取 **0**。原来照抄上游 rank，office 是 `BUNDLED_SKILL_RANK=600`，
  同层里若有 rank 更小的同名候选就会被顶掉（层内按 rank 升序去重）。
- 上游 `summaries()` 抛错时不再 `return []`（那等于把全部技能放行），改为只用
  `denied` 补影子。
- `denied` 里的历史脏名字先过宿主的 kebab-case 校验：一个不合法候选会让
  **整个** `provider.list()` 抛错，宿主随即丢弃本插件的全部贡献。

### 测试

- 新增 `tests/shadow-coverage.test.mjs`（8 条）：守卫被占 / 宿主抛错时 `denied`
  全量收到影子、造出的候选逐个通过宿主 `validateCandidate` 等价校验、脏名字只跳过
  自己、健康路径不刷日志、同名不重复。
- `tests/runtime.test.mjs`：原"两个出口必须共用一份计数器"改为"各用一份：另一个
  出口在飞时否认路径仍必须问宿主"；上游抛错的用例改为"仍按 denied 补发影子"。
- 全量 `node --test tests/*.test.mjs`：146 通过 0 失败。
- 仓外复现脚本 `probe-nesting.mjs`：修前 `CASE B emitted=7 missed=16`，
  修后 `emitted=23 missed=0`。

### 文档

新增 `docs/deny-shadow-覆盖率.md`（现象 / 根因 / 宿主语义 / 修复 / 未决）；
`docs/技能发现与宿主对齐.md` 的 4.2.1 从"必须共用计数器"改写为"各用一份"，并补 4.4。


## 2026-10-21 — 修复：工作区的「管理标签」打开成了对话标签管理界面

### 现象

在左侧工作区行的「...」菜单里点「管理标签」，弹出的却是标题为「管理标签（对话）」的界面 ——
左列是对话维度条件，右列按钮也按 `/conversations/*` 走。想配工作区的技能筛选完全没入口。

### 根因

`lib/client.js` 里两个事实叠在一起：

1. `manageSet()` 用 `Object.assign(manage, patch)` 合并模块级 store，**不清旧字段**；
2. `manageScope(workspaceId, conversationId)` **只凭 `conversationId` 是否非空**来决定走对话版
   还是工作区版。

三个打开入口里，两个显式清了对面作用域：

| 入口 | 调用 |
| --- | --- |
| 会话行菜单（官方槽位） | `{ ... workspaceId: "", conversationId: sessionId }` ✅ |
| 聊天框「+」命令 | `{ ... workspaceId: "", conversationId: sessionId }` ✅ |
| **工作区行菜单（DOM 注入）** | `{ open: true, workspaceId, workspaceTitle }` ❌ 没清 `conversationId` |

于是只要本次会话里打开过一次对话标签管理，之后点工作区的「管理标签」就会带着残留的
`conversationId` 走对话版。与"重启客户端"无关，只看操作顺序 —— 所以它表现为
「有时对、有时错」，很容易被当成偶发。

### 改动

在 `manageSet()` 里做**作用域互斥**，不再依赖每个调用点自己记得清：

- 打开对话版 → 清 `workspaceId`
- 打开工作区版 → 清 `conversationId` / `sessionTitle`

这样以后新增入口即使忘了清，也不会串。

### 测试

`tests/__manage-render.mjs` 新增 1 项：先用会话入口打开对话版，再用工作区入口打开，
断言 `conversationId` 已清空且 `manageScope` 返回工作区版（`isConv === false`、`id === ws-1`）；
再反向开一次对话版，断言 `workspaceId` 不残留。**184/184 通过。**

## 2026-10-21 — 修复：`dsh-storage-domain` 写进 dependencies，会把宿主的 workspaceController 打死

### 现象

装上本插件后，DSH 桌面端新建 / 打开工作区报：

```
workspace create failed: gateway/service-unavailable:
typert gateway: workspace/create: active Service "workspaceController" is unavailable
```

同时左侧会话列表、工作区列表一片空白 —— 看上去像数据被清空，实际
`~/.dsh/storages/workspace.json` 完好（9 个工作区、82 条归档会话都在），是服务没上台、
前端拿不到数据。

### 根因

`src/storage/schema.js` 有一句：

```js
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
```

这是**宿主提供的运行时包**，注册存储域时必须与宿主使用**同一份模块实例**。但 `package.json`
把它写进了 `dependencies`（`>=0.2.0-rc.1 <0.3`），pnpm 于是真的装了一份：

- 本机解析到 **0.2.0-rc.2**，且 `nodeLinker: hoisted` 下被提到 profile 顶层；
- 宿主桌面端内置的是 **0.2.1-rc.2**；
- `@deepseek-ai/dsh-api-workspace-controller` 的 `peerDependencies` 精确锁定 `0.2.1-rc.2`，
  版本对不上 → 存储域挂不上 → 依赖它的 workspaceController 一直 pending → 报服务不可用。

触发点往往是一次无关的 `pnpm add`：hoisted 布局重排，把原本嵌套在插件自己 `node_modules`
里的这个包提到了顶层，冲突面一下子扩散到整个 profile。本次实际就是装另一个插件时踩的。

### 改动

`package.json`：`@deepseek-ai/dsh-storage-domain` 从 `dependencies` 移到 `peerDependencies`，
`dependencies` 只剩 `zod`。**范围必须枚举具体的 rc 版本**，不能写成 `>=0.2.0-rc.2 <0.3`。

> **为什么不能用范围**：npm semver 有一条冷门规则 —— 候选版本是 prerelease 时，只有当某个
> 比较器的 `major.minor.patch` 与它**完全相等**，才允许匹配。所以 `>=0.2.0-rc.2 <0.3` 对
> `0.2.1-rc.2` 判定为**不满足**（比较器 tuple 是 0.2.0 与 0.3.0，候选是 0.2.1）。实测：
>
> | peer 范围 | 对 `0.2.1-rc.2` |
> | --- | --- |
> | `>=0.2.0-rc.2 <0.3` | ✗ |
> | `>=0.2.0-rc.1 <0.3` | ✗ |
> | `>=0.1.5-rc.2 <0.3.0` | ✗ |
> | `^0.2.1-rc.1` | ✓（只能覆盖 0.2.1.x） |
> | `0.2.0-rc.1 \|\| 0.2.0-rc.2 \|\| 0.2.1-rc.1 \|\| 0.2.1-rc.2 \|\| >=0.3.0 <1.0.0` | ✓ |
>
> 生态里不少插件写的 `>=0.1.5-rc.2 <0.3.0` 之类其实一直是"不满足"状态，只是
> `autoInstallPeers: false` 下 pnpm 不阻塞安装，只在 `pnpm peers check` 里列成 warn。

这也与 DSH 生态的惯例一致 —— 对照 `dsh-auto-memory`、`dsh-rewind-plugin`、`dsh-ops`，
它们的 `@deepseek-ai/*` 全部是 peerDependency，只有需要独立演进的通用库（`schemastery`、
`cosmokit`）才放进 dependencies。

### 验证

- `require.resolve("@deepseek-ai/dsh-storage-domain", {paths:[<插件>/lib]})` → 宿主同版本 `0.2.1-rc.2`
- peer 范围用 `semver.satisfies("0.2.1-rc.2", <范围>)` 逐个比对，确认 0.2.0-rc.1 / 0.2.0-rc.2 /
  0.2.1-rc.1 / 0.2.1-rc.2 / 0.3.x 全部 PASS
- `pnpm-lock.yaml` 里该包只剩一个版本
- `npm test` 183/183
- 重启 DSH 后新建工作区恢复正常

### 注意

声明为 peer 后 pnpm **不会**安装它，插件能解析到它依赖的是「profile 顶层有一份与宿主同版本的副本」。
若宿主升级内置版本，profile 里那份要同步更新（本机做法：在 profile 的 `package.json` 显式声明
`"@deepseek-ai/dsh-storage-domain": "<宿主版本>"`，而不是靠 override 去纠正插件装错的版本）。

## 2026-10-21 — 精简设置页：移除工作区/对话编辑器，已有标签默认折叠

### 需求
用户原话：设置页里只保留「tag 联系 skill / skill 联系 tag / 编辑标签组」三个按钮
+ 新建标签 + 已有标签列表，**删掉工作区之类的**；同时已有标签不要把标签下的所有
skill 都列出来，**折叠起来**。

### 改动（`lib/client.js`）
1. **删掉 `WorkspaceEditor` 与 `ConversationEditor` 两个组件及其调用点**（原
   line 1566–1720）。这两个卡片在设置页里没有使用场景 —— 真正的配置入口**已经是**
   工作区行菜单 / 会话行菜单里的「管理标签」（那里才有 workspaceId / sessionId
   上下文），设置页这两块只能手工填 ID，是历史遗留。
   - `zoneOf` / `conversationRows` / `ZONE_LABEL` / `configSummary` 等纯函数**保留**：
     双列「管理标签」浮层仍在用 `conversationRows` + `ZONE_LABEL`。
   - 后端 `/workspaces/*`、`/conversations/*` 路由**一律未动**，浮层照常调用。

2. **`TagList` 每个标签默认折叠**：行内只显示「`N` 个 Skill」计数（无关联时仍显示
   「无 Skill 关联」且不渲染箭头），点左侧 ▸/▾ 才在下一行列出技能名。展开后的每行
   **仍带 📁**「打开文件夹」按钮。
   - 动机：本机 34 个标签 / 96 条链接，全展开是一堵几百行的墙，而设置页这个场景
     只需要「有多少」和「删标签」。
   - 展开态存在 Section state 的 `openTags`（`{tagId: boolean}`），默认 `{}`。

### 测试（`tests/__page-render.mjs`，179 → 183）
- 主页面不再渲染工作区布尔配置 / 对话编辑器（但仍渲染标题 + 三按钮 + 新建标签 + 标签列表）
- 已有标签默认折叠：显示计数、不出现技能名、行内有 `data-skill-tag-toggle`
- 点 ▸ 只改写被点击那个标签的 `openTags`（不整体翻转）；展开后列出技能名且保留 📁
- 无关联技能的标签不渲染展开箭头

### 同步
`docs/preview/render-preview.mjs` 的 BASE state 去掉了 `wsId/wsDraft/convId/convWsId`
（它们随组件一起没了），补上 `openTags` + `view`；重跑了
`docs/preview/标签组配置-preview.html`（2769 B，已无工作区卡片）。

两副本各跑一遍全绿（183/183）。`lib/client.js` 是 no-cache 加载，**刷新页面即生效**。

## 2026-10-21 — 修复：「打开技能所在文件夹」点了没反应（windowsHide 让窗口不可见）

### 现象
技能行旁边的 📁 按钮点击后屏幕毫无变化，但服务端返回 `{"ok":true, ...}`，
看不出任何错误。

### 根因
`src/reveal.js` 的 `revealInExplorer()` 给 `spawn` 传了 `windowsHide: true`。
在 win32 上这个选项会让 **explorer 主窗口以不可见方式创建**：窗口**确实建了**
（路径也正确），但 `IsWindowVisible` 为 `False`，用户永远看不到。

实测证据（临时探测脚本，同一路径重复 4 次，结论稳定）：

| spawn 变体 | 新窗口 |
|---|---|
| `{detached, stdio:"ignore", windowsHide:true}`（修复前） | `Visible=**False**` |
| `{detached, stdio:"ignore"}`（修复后） | `Visible=**True**` |
| `{}` | `Visible=True` |

副作用：bug 期间每次点击都留下一个幽灵窗口，后台累积到 **35 个**资源管理器窗口
（每个 URL 都精确指向正确的技能目录），用 `Shell.Application` COM 枚举窗口才发现
——这也是定位到「窗口建了但不可见」的关键。已清理（剩 3 个是用户自己开的）。

### 修复
`src/reveal.js:84` 去掉 `windowsHide: true`，保留 `detached: true` +
`stdio: "ignore"` + `unref()` —— 脱钩/不等退出是我们真正要的，可见性不该被
这个选项顺手关掉。注释里写清了原因，避免以后又被"加回去"。

新增回归测试 `tests/skilltags.test.mjs`「revealInExplorer：spawn 选项不得带
windowsHide」，钉住 `options.windowsHide === undefined`。

### 验证
两副本各跑一遍全绿（179 tests / 179 pass，较上轮 137 增加是因为本轮统计口径
含 harness 侧用例）。`src/reveal.js` 是 ESM，**需重启 DSH 桌面进程**才生效；
`lib/client.js` 未改动。

## 2026-10-21 — 新增：「给技能打标签」可移植手册 + 来源轴自动推导 + auto-tag 脚本

### 需求
「把如何给 skill 打标签写进一个文档，当别人安装这个插件的时候，他们的 agent
能根据这份文档给 skill 打上标签」。硬约束：**可移植**，不能硬编码本机的
aegis / mattpocock / office-skills 名单。

### 思路
本机此前落地的标签体系（34 标签 / 96 链接）里，领域轴和
路由轴必须人工判断，但**来源轴是可以从 `path`/`source` 纯推导的**。把这部分抽成
代码，剩下的写成「推导法 + 调用纪律」手册，就是别人机器上也成立的那份文档。

### 新增文件

| 文件 | 作用 |
|---|---|
| `docs/给技能打标签.md` | 完整手册：三轴设计、API 调用序列、错误对照、交付检查清单 |
| `skills/tagging-skills/SKILL.md` | 同一份内容的**精简版**，注册成真 skill（见下） |
| `src/domain/origin.js` | 来源轴推导：`originTagOf(skill, {home})` / `isPackageDelivered` / `safeTagName` / `defaultHome()` |
| `src/skill-doc.js` | 读插件内 `skills/<dir>/SKILL.md`：`splitFrontmatter` / `loadBundledSkill` |
| `tools/auto-tag.mjs` | 一键脚本（dry-run 默认；`--apply`；`--domain hints\|<file.json>`） |
| `tools/domain-hints.mjs` | 领域轴**启发式起点**（关键词正则，非结论） |
| `tests/{origin,auto-tag,skill-doc}.test.mjs` | 测试 127 → **137** |

### 来源轴推导规则（`src/domain/origin.js`）

按 `path` 从上往下匹配：

1. 含 `/node_modules/<pkg>/` → 包名（`@scope/name` 保留两段）
2. 含 `/resources/runtime/<dir>/` → 目录名
3. `path` 为 `null` 或含 `.asar` → `builtin`
4. 其余按 `source` 根：`<home>/.dsh/skills`→`dsh-home`；`<home>/.agents/skills`→
   `agents-home`；项目级同名根→`project-skills`/`project-agents`；自定义根→最后一段

非 `dsh-home`/`agents-home`/`project-skills`/`project-agents` 的额外共挂 `plugin`，
于是 `<包名> * plugin` = 「只要这个包带来的技能」。

`safeTagName()` 把空格与 `+ * ( )` 引号替换成 `-` —— 标签名含这些字符时表达式里
必须加引号（`src/domain/expr.js` 的 `IDENT_STOP`），索性起名就避开。

本机 96 条实测分布：`aegis` 23 / `mattpocock-skills-dsh` 25 / `@tt-a1i/archify-dsh` 1 /
`dsh-home` 38 / `agents-home` 1 / `builtin` 8（asar 内的 `diagnose-windows-sandbox-acl`
+ office 7 个，path 不可见 → 需手工补 `office-skills`）。

### 手册注册成真 skill（`lib/index.js` 第 4b 段）

`apply()` 里新增：`loadBundledSkill("tagging-skills")` → `ctx.skills.register(...)`，
包在 `ctx.effect()` 里随插件卸载注销。

**为什么用 register 而不是在 `cordis.patch.yml` 里 insert 一个
`@deepseek-ai/dsh-skill-filesystem` 行**（archify 就是那么做的）：那条路依赖宿主
**另一个包**存在，换台机器不一定装了，insert 失败会升级成 fatal 打死桌面进程。
`register()` 只依赖我们已经 `inject` 的 `skills` 服务（`lib/index.js` 的
`export const inject = ["skills","agents","storageDomain","webServer"]`）。

整段 self-contain：register 抛错只 warn，不冒回 cordis。已实测
（假 ctx 让 register 抛 `boom`）`apply()` 正常返回。

### auto-tag.mjs 的两个纪律

1. **`/skills/tags` 的写是整体覆盖** —— 每个技能写之前先 `GET` 读回旧 `tagIds`，
   合并后再 `POST`。直接传新标签会清掉旧标签。这也是脚本**幂等**的原因：
   第二次跑 `tagsCreated: 0`、`writes: 0`。
2. **同名标签创建会报错** `tag name 'X' already exists`（`src/service.js`）→
   先读 `/state` 复用已有 `tagId`。

领域轴不自动判定：`--domain hints` 只给建议（`tools/domain-hints.mjs` 的关键词
**正则**，避免 `test` 命中 `pressure-test` 这类误判），或用
`--domain ./map.json`（形如 `{"pdf":["pdf","translate-pdf"]}`）自带映射。
映射文件里写了不存在的技能名会进 `unknownNames` —— 否则会被静默跳过。

### 验证

- 测试 127 → **137**，web 源与 desktop 副本**各跑一遍全绿**。
- 对 11347 实跑 dry-run：96 技能，`byOrigin` 分布与上面一致，
  `tagsCreated: 2`（已存在的 34 个标签全部复用），`unknownNames: []`。
- 假 ctx 模拟 `apply()` → `registered skills: ['tagging-skills']`；
  register 抛错 → apply 不崩。

### 同步

10 个文件已 cp 到 `C:\Users\ThinkPad\.dsh\profiles\desktop\node_modules\dsh-skill-tag`
（**非同一物理文件，必须手动复制**），sha256 前 16 位全部 SAME。
`lib/index.js` 是 ESM，**需重启桌面进程才生效**。

## 2026-10-21 — 修复：本插件探测到的 skill 数远少于宿主（39 vs 78）

### 现象
空标签对话里模型能看到 **78** 条 skill，而本插件的 `/skills` 只返回 **39** 条。
用户要求：「尽可能地做到 dsh 本身接收到多少 skill，本插件就能探测到多少 skill」。

### 根因
插件的列技能路径**只用**自己的 `scanSkillRoots` 扫文件系统根，从来没问过宿主的
skills 注册表 `ctx.skills`。而宿主有相当一部分技能**根本不在任何文件系统根里** ——
它们由插件自带的 provider 直接注册进注册表：

| 来源 | 条数 | 接法 |
|---|---|---|
| `~/.dsh/skills` | 37 | 文件系统根（另 2 个 `kdocs.bak-*` 名字含 `.`，被宿主 `SKILL_NAME` 正则丢弃） |
| `~/.agents/skills` | 1 | 文件系统根 |
| `aegis/skills` | 23 | `applyFilesystemProvider({providerName:"aegis-method-pack", includeDefaultRoots:false, bundledSkillDir})` |
| `mattpocock-skills-dsh/skills` | 25 | 自写 provider（`PACKAGED_SKILL_RANK=550`） |
| `@tt-a1i/archify-dsh/skills` | 1 | 同样 insert 一个 filesystem provider 行 |

扫盘只能看到前两行（38~39 条），后三行共 **49 条**永远看不到。

模型侧的口径在 `dsh-tool-skill` 的 `agent/pre-step`：

```js
const snapshot = await ctx.skills.snapshot({
  cwd: await ctx.workingDirectory.ensure(agent, signal),
  signal,
  scope: agent,          // ← 关键：宿主按 scope 决定合并哪些层
});
const skills = snapshot.skills.filter(isModelInvocable);
```

`dsh-skill` 的 `collectFresh` 是 `[this.layers.global, ...this.layers.chainLayers(options.scope)]`
—— 不传 `scope` 就只有 global 层，preset / agent 层的 provider 贡献全部丢失。

### 实现
1. **新增 `createSkillDiscoverer({hostRegistry, rootsScan, agents})`**（`lib/index.js`，已导出便于测试）
   - 先问宿主 `snapshot({cwd, scope})`（带得上 `scope` 就带）→ **权威**
   - 自扫描只补宿主没有的名字（宿主不可用、或设置页没有 agent scope 时的兜底）
   - 同名**以宿主为准**：宿主那份才是模型真正会加载的定义
   - `conversationId`（= sessionId）→ 在 `agents.list()` 里找对应 agent 当 scope
2. **`createUpstreamAdapter` 的 `snapshot` 补传 `scope`**（原先只传 `cwd`/`signal`），
   并加**嵌套重入保护**：宿主在收集本插件自己的 provider 时若回调进 `summaries()`，
   必须跳过宿主快照（否则 `snapshot → list() → freshen() → summaries() → snapshot` 无限递归）。
3. **`src/api.js` 的 `listSkills` 允许 async**：`contextForConfig` / `skillContext` /
   `resolveSkillPath` / `skillShape` / `convPayload` 全部 await 化；
   新增 `hint = {conversationId, workspaceId}` 透传给发现器。

### 测试（152 → **157 项**）
`tests/runtime.test.mjs` +5：
- 宿主注册表的技能优先，扫盘看不到的 provider 技能必须出现，同名以宿主为准，cwd 必须透传；
- 给了 `conversationId` 就把对应 agent 作为 `scope` 传给宿主；找不到 agent 时**不得塞 `undefined` scope**（会破坏宿主缓存键）；
- 宿主不可用 / 抛错 / `rootsScan` 抛错时退回自扫描，绝不外泄异常（宿主回调里抛异常 = host fatal）；
- `createUpstreamAdapter` 的 `scope` 透传 + 嵌套重入保护；
- **两个出口共用一份计数器**：设置页快照 → 宿主收集到本插件 per-agent provider →
  `freshen` → 否认路径再快照，必须只发生一次宿主快照，且计数器最后归零。

**变异验证**：去掉 `scope` 透传 → 红；去掉重入保护 → 红；让发现器忽略宿主 → 红。

### 追加修复：否认路径的 `scope` 缺口

`recomputeDenials` 算 `universe` 时 `upstream.summaries({ cwd })` 不带 `scope`
→ agent 层独有的技能（`@michengai/dsh-skills-manager` / `dsh-skillhub` 的
per-agent provider）进不了 universe → **永远无法被禁用**。现在
`refreshSessionInner` → `refreshBySession(sessionId, cwd, agent)` →
`recomputeDenials(sessionId, cwd, scope)` 把 agent 一路传下去。

### 生效方式
`src/api.js` / `lib/index.js` 是 ESM，**必须重启 DSH 桌面进程**（`lib/client.js` 才是刷新即生效）。

## 2026-10-20 — 新增：聊天框「+」菜单里的「管理对话标签」入口

### 需求
「在对话聊天框的左下角的『+』里添加一个管理对话标签的入口。」

### 调研（宿主 0.2.1-rc.2，源码核实）
- 那颗「+」**不是普通按钮**：`dsh-client-ui-conversation/lib/client.js` 的 `InputBar` 里
  `onClick: onToggleCommandMenu` → `toggleCommandMenu(keyboard.caretSpan())` →
  `inputTriggers.toggleSource("command", {trigger:"/", query:"", ...})`，
  即它打开的是宿主 `/` 命令菜单，候选来自 `dsh-client-ui-commands`。
- `dsh-client-ui-commands` 的 `CommandUiRuntime`（`ctx.commandUi`）**预留了客户端贡献位**：
  `register({name, available(session), label(), description(), icon, ui})`，
  `ui` 两种形态：`{kind:"popup", …}` 或 `{kind:"action", run(session)}`。
  官方插件 `dsh-client-ui-message-feedback` 就是这样挂 `/feedback` 的（`commandUi.decorate`）。
- 因此**不需要 DOM 注入**（工作区行菜单那种做法）：走 `ctx.inject(["commandUi"], …)` +
  `scope.effect(() => commandUi.register(...))` 即可。`action` 型被选中时先消费 token 再跑 `run`，
  **不往输入框写字、不发消息**。

### 实现（仅 `lib/client.js`）
- 新增 `registerComposerEntry(ctx)`：注册贡献 `name:"skill-tag-manage"`、
  `label:"管理对话标签"`、`description:"配置本对话的标签条件、技能添加与禁用"`、
  `ui:{kind:"action", run(session) → manageSet({open:true, conversationId: session.sessionId})}`。
  复用已有的 `manage` store 与 `shell.overlay` 浮层，因此打开的正是对话版双列界面。
- `apply(ctx)` 末尾调用它；`ctx.inject` 不存在时静默跳过（老宿主 / 测试桩）。
- `exports.__test` 追加 `registerComposerEntry`。

### 测试（149 → **152 项**）
- `tests/__conv-render.mjs` +3：
  - 「+」菜单里恰好一条贡献、`name/kind/label/available` 正确（**必须是 `action`**，否则会往输入框写字）；
  - 点它 → `manage.conversationId === "sess-9"` 且浮层渲染出「管理标签（对话）」；
  - **没有 `commandUi` 服务时插件照常加载不抛错**（服务缺失不得打死宿主）。
- 全量 `node --test "tests/*.test.mjs" "tests/*.mjs"` → **152 项通过**。

### 兼容性
- 仅 `lib/client.js`：**刷新页面即生效**，无需重启。
- 与 `/skills/reveal` 的 404 是两个独立问题：那条报错是**服务端仍是旧进程**（`src/api.js` 新增路由须重启桌面进程）。

## 2026-10-20 — 新增：skill 联系 tag 页 + 全局「打开技能所在文件夹」

### 需求
1. 设置页「Skill 关联」按钮改名为「tag 联系 skill」；
2. 新增「skill 联系 tag」按钮，打开一个可编辑「某个技能拥有哪些标签」的界面；
3. **本插件所有列出技能的位置**都加一个按钮，一点即在文件资源管理器中定位该技能文件。

### 实现
- **新增 `src/reveal.js`**（纯函数可单测）：
  - `revealCommand(target, platform)` → win32 `explorer.exe /select,<file>` / darwin `open -R` / 其他 `xdg-open <dir>`；
  - `assertRevealable(p)` → 非空、必须是 `.md`/`.md.disabled`、必须存在且是普通文件，否则抛带 `code` 的错误（`NO_PATH` / `NOT_SKILL_FILE` / `NOT_FOUND` / `NOT_FILE`）；
  - `revealInExplorer(target, {platform, spawnImpl})` → `detached:true, stdio:"ignore"` 拉起并 `unref()`；`spawn` 抛错与异步 `error` 事件都被吞掉，绝不冒回宿主调用栈（历史两次 fatal 的教训）。
  - 为什么自己做：宿主 0.2.1-rc.2 **没有**给插件暴露 shell/reveal API（全 asar 搜 `showItemInFolder`/`shell.openPath` 只命中 inspector 的 devtools chunk 与 electron-updater）；官方 `POST /open-in-app/open {app:"explorer"}` 虽然等价，但带 `connection` 服务的 Host/Origin 校验，插件不该绕。
- **`src/api.js` 新增三条路由**：
  - `POST /skills/reveal` `{path}` 或 `{skillName, cwd?}` → 拉起文件管理器；非法路径回 **400 + code**（不是 500），查不到技能回 404。
  - `GET|POST /skills/tags` `{skillName}` → `{tagIds, skill:{name,path,source}, tags}`；带 `tagIds` 的 POST 是**整体覆盖**（空数组 = 删除整条连接记录）。读也接受 POST（前端只有 `apiPost` 一条通道），靠 `hasOwnProperty("tagIds")` 区分读写——空数组写入不能被误判成读。
  - `/skills` 与两处双列载荷新增 `path` / `catalog`：`contextForConfig()` 现在返回 `{universe, candidates, catalog}`，`catalog` 是 `[{name, path, source}]`，前端据此不必二次扫描就能显示「打开文件夹」。
- **`lib/index.js`**：`mountApi` 的 `listSkills(cwd)` 把 `path` 一起透传（原先只映射 name/description/source → 按钮无路径可用）。
- **`lib/client.js`**：
  - `Section` 导航：「Skill 关联」→「**tag 联系 skill**」，新增「**skill 联系 tag**」→ `view:"skilltags"`；state 新增 `linkSkillName / skillTagSearch / skillPickSearch`。
  - 新增 `SkillTagPage`（**skill 联系 tag**）：左列技能（扫描结果 + 只有连接记录的幽灵技能 `*`，每行末尾 `📁`），右列该技能的标签勾选框（**勾选即保存**，整组覆盖 `/skills/tags`）+「清空标签」；下方提示"已拥有: …"。
  - 新增通用 `RevealButton`（`data-skill-tag-reveal` 便于测试）：有 `path` 就发 `{path}`，没有就发 `{skillName}` 让服务端再查；失败 `alert` 提示，不静默。
  - 「打开文件夹」按钮已铺到**所有列出技能的位置**：`SkillLinkPage`（tag 联系 skill 右列）、`SkillPickerModal`（给标签挑技能）、`SkillTagPage` 左列、`TagList`（标签行里的 Skill 列表）、`ManageTagsDialog`（管理标签右列）、`SkillAddDialog`、`DisabledSkillsDialog`。

### 测试（142 → **149 项**）
- 新增 `tests/skilltags.test.mjs`（9 项）：三平台命令行、空路径拒绝、`.md`/`.md.disabled` 白名单与目录拒绝、`spawn` 抛错不外泄、`/skills` 透传 path + catalog、`/skills/reveal` 三态（ok / 404 / 400 带 code）、`/skills/tags` 读写覆盖与清空、两方向共享同一份 `skill_links` 记录。
- `tests/__page-render.mjs` 8 → 16 项：导航三按钮与旧文案消失、切到 `skilltags` 时清空上次选中、双列结构、勾选态与「清空标签」、`RevealButton` 有/无 path 两种请求体、失败必须 alert、`skillPathOf` 边界。
- 全量 `node --test "tests/*.test.mjs" "tests/*.mjs"` → **149 项通过**。

### 兼容性
- `lib/client.js` 宿主 no-cache：**刷新页面即生效**。
- `src/api.js`、`src/reveal.js`、`lib/index.js` 需**重启 DSH 桌面进程**（新路由 + listSkills 带 path）。

## 2026-10-20 — 修复：新对话第一条消息不受技能筛选控制

### 症状
用户报告：**第一条消息**里模型仍能看到全部 skill，从第二条消息起才受本插件控制。

### 根因（三段，缺一不可）
| # | 位置 | 机制 |
| --- | --- | --- |
| 1 | `lib/index.js` provider | `denied` 集合只在 `domain/changed`（**写操作**触发）里被填充。新对话第一轮列技能时没有任何写操作发生过 → 集合为空 → 全部放行；直到第二轮出现 `domain/changed` 才开始过滤。 |
| 2 | `recomputeDenials` 工作区解析 | 只查 `registry.sessionIds`，而宿主是在会话**跑起来之后**才 `attachSession` 写那个 id → 第一轮 `workspaceIdOfSession` 返回 `null` → 拿不到工作区 → 全部放行。 |
| 3 | 候选集来源 | 走 `conversations.candidates(convId, links)`，内部 `conversationEffectiveConfig(conversations.get(id))`；对话行不存在时抛 `TypeError: Cannot read properties of undefined (reading 'config')`，被 `refreshSession` 的 catch 吞掉 → 拒绝集为空。第一轮恰好没有对话行。 |

### 修复
- `createFilterProvider(sessionId, upstream, denied, ensureFresh)` 新增第 4 个参数：
  `list()` 与 `get()` 在消费 `denied` **之前**先 `await ensureFresh(options)`，
  把刷新挂到读路径上。`ensureFresh` 抛错只降级沿用旧集合，不冒回宿主。
- `refreshSession` 拆出 `refreshBySession(sessionId, cwd)`，加 `refreshing` Set 做
  重入保护（刷新→invalidate→宿主重新 list→before===after 自然收敛）。
- 工作区解析新增第 3 档兜底：`workspaceIdOfPath(registry, cwd)`（provider 的
  `options.cwd` 第一轮就可靠），排在 `workspaceIdOfSession` 之后、`inherited` 之前。
- 候选集改用 `candidatesFor({config: effective.config, active: activeTagsOf(...)})`，
  与对话行是否存在彻底解耦。

### 测试（`tests/runtime.test.mjs` 17 → 22 项）
- 首次 `list` 前必须触发一次刷新；`ensureFresh` 抛错降级；不传时向后兼容；
  会话未 attach 时 cwd 兜底；**对话行不存在时端到端组合仍算出正确拒绝集**
  （并断言旧路径 `conversations.candidates` 在该场景下确实抛错——证明修复必要）。
- 变异验证：去掉 `list()` 里的 `await freshen(options)` → 回归测试变红；恢复通过。
- 全量：`node --test "tests/*.test.mjs" "tests/*.mjs"` → **133 项通过**。

## 2026-10-20 — 修复：插件异常导致 DSH 宿主崩溃（fatal load failure）

### 症状
桌面端两次崩溃，日志栈完全一致：

```
dsh: fatal load failure: Error: cannot get property "workspaceRegistry" without inject
    at refreshSession (.../dsh-skill-tag/lib/index.js:301:33)
    at .../lib/index.js:380:9
    at Object.apply (.../@deepseek-ai/cordis/lib/index.js:921:20)
    at DomainImpl.emitChanged (.../dsh-storage-domain/lib/index.js:216:13)
```

两次的日志文件分别是 `crash-2026-10-20T13-41-36-434Z-host.log` 与
`crash-2026-10-20T13-49-11-873Z-host.log`（后者是同一个旧进程里跑的旧代码，
磁盘上的修复写在它启动之后——ESM 不热重载）。

### 根因（两层）
1. **cordis 服务是声明式注入**：`export const inject` 里没声明的服务，
   `ctx.workspaceRegistry` 会**直接抛**，`ctx.workspaceRegistry ?? ctx.get(...)`
   的右侧兜底永远轮不到（左侧先炸）。
2. **事件监听器异常是 fatal**：`domain/changed` 是宿主调用栈上的同步回调，
   cordis 不吞监听器异常，一路冒到 `Object.apply` → 插件加载失败 → 桌面进程退出。
   这说明即使 `refreshSession` 内部 try/catch 也不够——枚举 agent、取 `agents`
   服务本身仍可能同步抛。

### 修复
- `lib/index.js`：新增导出 `getWorkspaceRegistry(ctx)`——只走 `ctx.get(name)`
  并整体 try/catch，拿不到返回 `null`。替换 3 处裸读（`refreshSession`、
  `resolveWorkspaceId`、`resolveWorkspacePath`）。
- `refreshSession` 拆成薄壳 + `refreshSessionInner`：薄壳整体 try/catch，
  只记 `warn` 不抛。
- **`domain/changed` 监听器自身也 self-contain**：外层 try/catch 罩住
  「判域 → 枚举 agents → 逐个 refresh」，单个 agent 的同步抛出再单独兜一层，
  任何异常只 `warn`，绝不逃到宿主栈。
- 同类边界一并加固（都是"注册给宿主的回调"）：
  - `createUpstreamAdapter.summaries`：`rootsScan` 与 `hostRegistry.snapshot`
    各自 try/catch，一边挂掉仍返回另一边的技能（原来任一边抛都直接冒出去）。
  - `createFilterProvider.list` / `.get`：上游抛错时降级为 `[]` / `undefined`，
    不再把 rejection 丢回宿主的 provider 链。
  - `registerProvider` 的 factory 内 `controls.add` 包 try/catch（控制面已释放时）。
  - `apply()` 里"attach 到已存在 agent"的循环包 try/catch。
- `tests/runtime.test.mjs`：新增 7 项回归（`getWorkspaceRegistry` 只走 `ctx.get`、
  服务缺失/属性访问抛异常时返回 `null`、`apply()` 在无 workspaceRegistry 的
  最小 cordis 面不抛、`domain/changed` 监听器内部抛错不逃逸、
  `createFilterProvider` 上游抛错降级、`createUpstreamAdapter` 两侧单独降级）。
- 两处均做过**变异验证**：把 `ctx.get("workspaceRegistry")` 换回裸读 → 对应测试变红；
  去掉监听器 try/catch → 监听器测试变红。恢复后通过。

### 说明
- 崩溃是**旧代码在旧进程里运行**触发的：修复写盘时间（21:47:28）晚于该 host
  进程启动时间，ESM 模块不热重载，内存里仍是旧模块。修复后必须重启桌面进程
  （`lib/index.js` 不在 no-cache 范围）。`lib/client.js` 才是刷新页面即生效。
- 全量：`node --test "tests/*.test.mjs" "tests/*.mjs"` → **128 项通过**。

## 2026-10-20 — 对话 → 管理标签（对话级双列配置 + 继承工作区）

### 新增
- **会话行「⋯」菜单新增「管理标签」**，打开与工作区版同构的双列界面，作用域是单个对话。
  - 走**官方插件槽位** `sidebar.workspaces.session.menu.item`（order 500，排在宿主
    pin/rename/fork/archive/session-id 之后），不需要 DOM 注入。
  - 槽位 owner 给 `{sessionId, displayTitle}` 并注入 `useMenuOpenState`；点击先
    `setMenuOpen(false)` 再打开浮层。宿主没给 hook 时降级为 noop，不崩。
- **「继承工作区配置」按钮**（只在对话版出现）：把工作区的标签条件 + 手动添加 + 禁用
  **整体覆盖**到本对话，并记录 `sourceWorkspaceId` / `inheritedAt`；工作区不被写回。
- **默认继承**：新建对话（`conversations.create(cid, wsId)`）时自动继承一次；
  之后工作区再改**不会**流入已存在的对话——要重新同步必须点继承按钮。
- 左列显示继承状态：`继承来源: ws-1 · 2026-10-20 13:33:28（改动不影响工作区）`
  或 `未继承任何工作区（当前为该对话独立配置）`。
- 对话自己的手动添加 / 禁用**存在对话身上**（`conversationRecord.own`），
  与工作区、与其他对话完全隔离。

### 数据结构
- `src/storage/schema.js`：新增 `conversationOwnConfigSchema`；
  `conversationRecord` 新增 `own`（全字段 optional，兼容磁盘历史行）。
- `src/storage/repository.js`：`serialize/deserializeConversation` 读写 `own`。
- `src/domain/conv.js`：`createConversationState()` 加 `own: null`；新增
  `emptyOwnConfig()`、`ownConfigFromWorkspace(ws, now)`（**深拷贝**，避免共享引用）。
- `src/service.js`：`conversationService` 新增 `ensureOwn` / `own` /
  `inheritFromWorkspace` / `setOwnExpression` / `addOwnManualSkill` /
  `removeOwnManualSkill` / `disableOwnSkill` / `enableOwnSkill` /
  `ownView` / `ownDenied`；`create()` 在绑工作区时自动播种一次。

### 服务端 API（`src/api.js`）
- 新增 `/conversations/config`、`/conversations/inherit`、
  `/conversations/expression`、`/conversations/skills/{add,remove,disable,enable}`。
- 新增 `contextForConfig(config, cwd)`（原 `skillContext` 拆出，支持 cwd 扫项目级技能根）、
  `convShape` / `convPayload` / `workspaceIdForConversation`。
- `createApiHandler` / `mountApi` 多接 `resolveWorkspaceId`、`resolveWorkspacePath`
  两个注入点（由 `lib/index.js` 用宿主 `workspaceRegistry` 提供）。

### 运行时（`lib/index.js`）
- 新增 `workspaceIdOfSession(registry, sessionId)`、`workspaceIdOfPath(registry, cwd)`、
  `effectiveSkillsConfig(own, ws)`。
- **`refreshSession` 主键修正**：`convId = sessionId`（不再用 `cwd`）。旧逻辑把
  "每个目录一个对话"当绑定，与「对话 → 管理标签」按会话配置的口径冲突；`cwd` 仅作旧数据兜底。
- 生效口径改为 `own` 优先（**空快照也算数**：代表用户已把该对话与工作区解耦），
  否则退回工作区；两者都无则不筛。

### 界面（`lib/client.js`）
- `ManageTagsDialog` 单组件双作用域，由 `manageScope(workspaceId, conversationId)` 决定
  四组端点 + 标题 + 空条件文案 + 保存按钮文案。
- `TagSettingsDialog` 改为保存目标由调用方注入（`save` / `saveLabel` / `subtitle`），
  工作区版与对话版共用同一份表达式编辑器。
- 新增 `SessionManageMenuItem({sessionId, displayTitle, useMenuOpenState})`。
- `manage` store 扩出 `conversationId` / `sessionTitle`；`OverlayHost` 两版用不同 key。

### 测试
- 新增 `tests/conversation.test.mjs`（21 项）：快照形态、新建自动继承、工作区改动不流入、
  继承整体覆盖、继承不回写工作区、条件保存/空/非法/未知标签、手动-禁用互斥、两对话隔离、
  历史行补快照、落盘跨实例恢复、ownView/ownDenied、HTTP 全链路 11 步、无工作区 400。
- 新增 `tests/runtime.test.mjs`（11 项）：`effectiveSkillsConfig` 四种情形、
  `runtimeDeniedSkills`、`workspaceIdOfSession` / `workspaceIdOfPath`。
- 新增 `tests/__conv-render.mjs`（11 项）：槽位注册与 order、点击开浮层并关菜单、
  缺 hook 不崩、对话版端点、继承来源展示、空条件不显示 ∅、继承按钮、工作区版无继承按钮、
  tag 设置回显/载入标签组/保存目标、空条件可保存、禁用端点。
- 全量：`node --test "tests/*.test.mjs" "tests/*.mjs"` → **122 项通过**。

### 文档
- 新增 `docs/对话管理标签.md`（需求口径、数据结构、文法、槽位接入、双列/弹窗交互、
  API 表、运行时屏蔽、28 条边界、B1–B21 验收、部署约束）。
- 新增 `docs/preview/render-conv-preview.mjs` + `对话管理标签-preview.html` +
  `conv-manage-shot.png`（3 场景，用真实组件渲染）。

## 2026-10-20 — 修复：空表达式校验自相矛盾

### 修复
- **用户报告的 bug**：「tag 设置」弹窗里空表达式一边提示「表达式不能为空」，
  一边又被当作「掌握全部技能」——同一份 `validateExpression` 承担了两套互斥语义。
- `src/domain/expr.js`：`validateExpression(src, opts)` 新增 `opts.allowEmpty`。
  - `false`（默认，标签组）：空表达式 → `EMPTY` 错误（行为不变）。
  - `true`（工作区条件）：空表达式 → `{ ok: true, normalized: "", config: {orTags:[],andGroups:[]}, dnf: [[]] }`。
  - `dnf: [[]]` 表示"空子句恒真"，与 `evaluateDnf` 语义一致。
- `src/service.js`：`templates.validate(expr, { allowEmpty })` 透传；
  `workspaces.setExpression()` 固定用 `allowEmpty: true`，空串直接存为无条件。
- `src/api.js`：`POST/GET /templates/validate` 接受 `allowEmpty`（布尔或 `"true"`）。
- `lib/client.js`：`TagSettingsDialog` 的 250ms 防抖校验改传 `{ expression, allowEmpty: true }`，
  并且**对空表达式在客户端直接短路**（不依赖服务端版本，见下）；
  空表达式的「解析结果」显示「无条件（掌握全部技能）」而不是容易误解的 `∅`。
- **旧服务端兼容**：本机桌面进程若尚未重启（`validate` 不认 `allowEmpty`，空串一律回 `EMPTY`），
  客户端短路仍能让「tag 设置」正常工作——修复只需刷新页面即可，不必等重启。
- `tests/workspace.test.mjs`：新增 2 项服务层回归 + HTTP 第 8/9 步（带/不带 `allowEmpty`
  的对照、清空条件回到全部技能）。工作区测试 22 → 24 项。
- `tests/__manage-render.mjs`：新增 2 项 UI 回归（空表达式不报错且可保存、模拟旧服务端仍不报错），
  并为迷你 React 运行时补上**假计时器**（250ms 防抖能在断言前落地）与收尾稳定渲染。
  该文件 8 → 10 项。
- 两处回归均做过**变异验证**：去掉修复后对应测试确实失败，恢复后通过。
- 全量：`node --test "tests/*.test.mjs" "tests/*.mjs"` → **79 项通过**。

## 2026-10-20 — 管理标签（工作区双列配置）

### 新增
- `src/domain/workspace.js`：工作区技能视图纯函数。
  `normalizeSkillIds` / `hasFilter` / `activeTagsOf` /
  `workspaceSkillView({config, manualSkills, disabledSkills, candidates, universe})` /
  `workspaceDeniedSkills` / `normalizeWorkspacePath`。
- `lib/client.js`：
  - 工作区行「⋯」菜单注入「管理标签」（`MutationObserver` + `pointerdown` 记行 key，
    因为宿主 `ProjectRowItem` 的菜单项是硬编码的，没有插件槽位）；
  - `shell.overlay` 槽位上的浮层宿主 `OverlayHost`；
  - `ManageTagsDialog`（双列：左=标签条件 + tag 设置，右=技能 + 查看 tag/禁用）；
  - `TagSettingsDialog`（标签运算 + 「添加标签组」载入 + 250ms 防抖校验 + 错误定位）；
  - `SkillAddDialog`（排除已有 + 已禁用）、`DisabledSkillsDialog`（可恢复）。
- `docs/管理标签.md`：数据结构、交互细节、API、边界情况（26 条）、验收标准（A1–A11）。
- `tests/workspace.test.mjs`：领域纯函数 11 项 + 服务层 10 项 + HTTP 全链路 1 项。
- `tests/__manage-render.mjs`：用能真正驱动 hook 的迷你 React 运行时执行真实的
  `ManageTagsDialog` / `TagSettingsDialog` / `SkillAddDialog` / `DisabledSkillsDialog`，8 项。

### 变更
- `src/storage/schema.js`：`workspaceRecord` 增加 `path` / `expression` /
  `manualSkills` / `disabledSkills` / `updatedAt`（全部可选，兼容历史行）。
- `src/service.js`：
  - `workspaceService` 新增 `setExpression` / `addManualSkill` / `removeManualSkill` /
    `disableSkill` / `enableSkill` / `view` / `denied` / `migrate`；
    `edit` 与 `applyTemplate` 结构化变更后用 `configToExpression` 反推回 `expression`；
  - `loadAll()` 末尾自动 `workspaceService.migrate()`（只有 config 的历史行补表达式，幂等）；
  - `tags.rename` 同步改写所有**工作区**表达式（原先只改模板）；
  - `tags.globalDelete` 从所有工作区表达式里摘除该标签名并化简。
- `src/api.js`：新增 `POST/GET /workspaces/expression`、`POST/GET /workspaces/skills`、
  `POST /workspaces/skills/{add,remove,disable,enable}`；
  workspace 响应统一经 `wsShape()` 输出 `expression`/`manualSkills`/`disabledSkills`；
  校验类错误返回 400 + `issues`/`position`。
- `lib/index.js`：新增 `runtimeDeniedSkills(ws, universe, candidates)`；
  `refreshSession` 改为先取真实技能全集再算拒绝集（实现「禁用真的屏蔽技能」），
  旧 `computeDeniedSkillIds` 保留为 `universe` 扫不到时的兜底。

### 说明
- 「空条件 = 全部技能；有条件 = 严格子集」是用户确认的语义。副作用：给某个技能打了
  tag 后，没打 tag 的技能会从该工作区消失，需手动加回。
- 「tag 设置」保存到**当前工作区**；「添加标签组」只是载入已存表达式当起点，不改原标签组。
- 测试：`node --test "tests/*.test.mjs" "tests/*.mjs"` → 79 项全部通过。
- `lib/client.js` no-cache，刷新页面即生效；`lib/index.js`、`src/*` 需重启 DSH 桌面进程。
- 源目录与 desktop 安装副本不是同一物理文件，改完必须手动复制。

## 2026-10-20 — 标签组配置（布尔表达式）

### 新增
- `src/domain/expr.js`：标签组布尔表达式引擎（纯函数）。
  `tokenize` / `parse` / `resolveAst` / `formatExpression` / `toDnf` / `dnfToConfig` /
  `evaluateDnf` / `configToExpression` / `renameTagInExpression` / `removeTagFromExpression` /
  `validateExpression` / `quoteName` / `needsQuote` / `ExprError`。
  文法 `+`=OR、`*`=AND、`*` 优先于 `+`、支持括号；全角 `（）＋＊` 归一；
  错误统一带 `code`/`position`/`length`。
- `docs/标签组配置.md`：数据结构、文法、交互细节、API、错误码表、边界情况、验收标准。
- `docs/preview/`：`render-preview.mjs`（迷你 React 运行时执行真实组件 → 序列化成 HTML，
  含 250ms 防抖校验）、生成的 `标签组配置-preview.html`、截图 `preview-shot.png`。
- `tests/expr.test.mjs`、`tests/template.test.mjs`：表达式引擎与服务层单测。
- `tests/__api-smoke.mjs`：真实 HTTP 全链路验收（校验/新建/回显/编辑/非法拒绝/求值/删除/重名）。
- `tests/__page-render.mjs`：用最小 React 桩执行 `lib/client.js` 中真实的 `TemplateGroupPage`，
  验证上下分区、表达式回显、点击插入（自动补 `+` 与引号）、运算符工具条、按钮启用条件。

### 变更
- `src/storage/schema.js`：`templateRecord` 增加 `expression`、`createdAt`、`updatedAt`
  （`expression`/`config` 均可选，兼容历史行）。
- `src/service.js`：
  - `templateStore` 新增 `validate()` / `evaluate()` / `migrate()`；
  - `create/update` 支持 `expression`，表达式优先，只给 `config` 时反推；
  - `loadAll()` 后自动 `migrate()`，把只有 config 的历史行补成表达式（幂等）；
  - `tags.rename` 同步改写所有模板表达式；标签全局删除时从表达式摘除并化简。
  - `createServices(repo, opts)` 支持 `opts.log`。
- `src/api.js`：新增 `POST/GET /templates/validate`、`POST/GET /templates/evaluate`；
  `/templates` 与 `/templates/update` 透传 `expression`；校验类错误返回 HTTP 400 + `issues`。
- `lib/index.js`：向 `createServices` 传入 logger。
- `lib/client.js`：
  - 主页面导航按钮 `标签组` → `编辑标签组`；
  - `TemplateGroupPage` 重写为「上：已有标签（搜索 + 点击插入）/ 下：表达式输入区」，
    含 250ms 防抖实时校验、错误「定位 第N字符」、规范化预览、解析结果预览、
    运算符工具条、清空、保存/保存新建/删除/关闭编辑；
  - 列表 chip 展示 `name + expression`；
  - 新增纯函数 `quoteTagName`（并导出到 `__test`）。

### 说明
- 标签组为复制语义：修改/删除标签组不影响已应用到工作区或对话的 config。
- `lib/client.js` no-cache，刷新页面即生效；`lib/index.js`、`src/*` 需重启 DSH 桌面进程。
- 测试：`node --test "tests/*.test.mjs" "tests/*.mjs"` → 45 项全部通过。
