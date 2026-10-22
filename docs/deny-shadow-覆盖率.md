# deny-shadow 的覆盖率：为什么包带来的技能永远屏蔽不掉

> 2026-10-22。线上实测复现 + 修复。适用于 `lib/index.js` 的 `createFilterProvider` /
> `createUpstreamAdapter` / `createSkillDiscoverer`。

## 1. 现象

模型上下文里技能目录 71 条，插件口径 `universe 105 / visible 54 / denied 51`：

- 71 − 17 = 54 = 插件 `visible` → 数字自洽，说明**恰好 17 个本该被屏蔽的技能漏网**；
- 成功屏蔽 34 个，全部来自文件系统技能根（`~/.dsh/skills` 33 + `~/.agents/skills` 1）；
- 漏网 17 个，全部来自别的 provider / npm 包 / 运行时：

| 来源 | 数量 | 名字 |
| --- | --- | --- |
| aegis（bundled） | 4 | using-aegis, update-aegis, writing-skills, communicating-concisely |
| mattpocock（custom） | 4 | ask-matt, research, teach, writing-for-agents |
| archify | 1 | archify |
| dsh-skill-tag（本插件） | 1 | tagging-skills |
| office（bundled，`path` 为 null） | 7 | office, office-docx, office-export-pdf, office-pptx, office-recalculate, office-render, office-xlsx |

分界线极干净：**`path` 落在文件系统技能根的 → 被屏蔽；由别的 provider 送进来的 → 全部漏网。**

失效是**静默**的：插件日志、右列界面、`/skill-tag/api/skills` 全都对（universe 105），
只有模型侧少了那 17 条影子。

## 2. 根因

### 2.1 发射范围 = 本次可见的 summary

```js
// 修前
for (const summary of summaries) {
  if (denied.has(summary.name)) shadows.push({ ...summary, invocation: DENY })
}
```

只看得见的手才发影子。**看不见的名字，就算在 `denied` 里也一个字节都不发。**

### 2.2 范围为何会变窄：重入守卫把宿主快照整段跳过

`createUpstreamAdapter.summaries()` 在 `nesting.depth > 0` 时跳过
`hostRegistry.snapshot()`，只剩扫盘结果：

```js
if (hostRegistry && nesting.depth === 0) { ... await hostRegistry.snapshot(...) }
```

### 2.3 守卫为何会被占住：与发现器共用一份计数器

修前 `apply()` 里只有一份 `snapshotGuard`，同时交给 `createUpstreamAdapter` 与
`createSkillDiscoverer`。于是任何**另一个** snapshot 在飞 —— 设置页 discoverer、
skill-explorer / skills-manager 的 UI 快照、另一个 agent 的收集、`domain/changed`
引发的并发刷新 —— 都会把否认路径挤成"只看得到扫盘结果"。

触发是**时序相关**的，不是永久失效，所以更像偶发：同一时刻
`GET /skill-tag/api/skills` 仍返回 105（那条路走的是发现器）。

## 3. 宿主语义（修复必须遵守）

`@deepseek-ai/dsh-skill`（asar 0.2.1-rc.2，源码核实）：

| 事实 | 位置 |
| --- | --- |
| `layers = [global, ...chainLayers(scope)]`，逐层 `merged.set(name, entry)` → **近层整条覆盖同名**（不是按字段合并） | `collectFresh` |
| 层内才按 `rank` 升序去重（`compareIndexedCandidates`：rank → providerOrder → localOrder） | `collectLayer` / `compareIndexedCandidates` |
| `RUNTIME_RANK = 250`，`BUNDLED_SKILL_RANK = 600` | 同包常量 |
| `validateCandidate` 强制：`name` 匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`、`description` 非空字符串、`invocation` 是对象、`source` 字符串、`rank` 有限数、`provider` 必须等于 provider 自己的名字 | `validateCandidate` |
| 候选校验失败 → `provider.list()` 抛错 → 宿主只记一条 `skill provider ... skipped` 并**丢弃该 provider 的全部候选** | `listLayerCandidates` 的 try/catch |
| 模型侧口径：`snapshot({cwd, signal, scope: agent}).skills.filter(isModelInvocable)` | `dsh-tool-skill` |

## 4. 修复

三件事一起做（`lib/index.js`）：

1. **影子按名字发**：`list()` 分两段 —— 看得见的照抄 summary；看不见的直接造一条
   最小合法候选（`name` / `description` / `source` / `rank` / `provider` / `invocation`
   齐全）。屏蔽是按键名生效的，不需要知道那名字长什么样。
2. **两个出口各用一份计数器**：递归那圈只在 adapter 内部，`createSkillDiscoverer`
   不在回路里；共用只会互相连坐。发现器另加同 key 并发合并。
3. **观测**：发生补发时打一行 warn（`shadow backfill ... backfilled=N`，
   降级时再带 `hostSnapshot=skipped(nested)`）；健康路径不刷日志。
   `denied` 里的脏名字也会单独 warn，而不是让整批影子被宿主丢掉。

配套细节：

- `rank` 统一取 **0**，不照抄上游 rank。office 是 600，若同层里另有 rank 250 的
  同名候选，影子会被顶掉 —— 屏蔽随即失效。
- 上游 `summaries()` 抛错时**不再 `return []`**：返回空增量等于把全部技能放行，
  正是本 bug 的一个分支。现在降级为"只用 `denied` 补影子"。
- `source` 兜底为 `"skill-tag"`：上游 summary 缺 `source` 时宿主会以"非字符串"整段丢弃。

## 5. 验证

`tests/shadow-coverage.test.mjs`（8 条）：

- 守卫被占 / 宿主 `snapshot` 直接抛错时，`denied` 里 22 个名字**全部**拿到影子；
- 且造出来的候选逐个通过宿主 `validateCandidate` 的等价校验；
- 脏名字只跳过自己，不炸整批；
- 健康路径不刷日志、降级路径必留痕；
- 同一名字只发一条影子。

`tests/runtime.test.mjs` 另锁住"另一个出口在飞时否认路径仍要问宿主"。

仓外的 `probe-nesting.mjs`（假 hostRegistry 23 技能 / 扫盘 7 个 / denied 全量）
修前 `CASE B: emitted=7 missed=16`，修后 `emitted=23 missed=0`。

## 6. 未决

1. **补发会造出"幽灵影子"**：`denied` 里有、但本机已卸载的名字（历史标签残留）也会
   拿到一条影子。它 `modelInvocable:false`，模型侧不可见（被 `isModelInvocable` 过滤），
   只可能在技能列表 UI 里多一条「blocked by skill-tag」。要彻底消除需要给
   `skill_links` 加路径/存在性证据，暂不做。
2. `recomputeDenials` 的 `universe` 在降级那一趟仍然偏窄（`denied` 靠
   `computeDeniedSkillIds` 兜底把已打标签的补了回来）。未打标签、且这一趟看不见的
   技能不会被判 deny —— 下一趟正常快照会纠正，且不影响已知名单。
3. ~~`provider.get()` 对影子名字会回问宿主 `get`，而宿主选中的又是影子自己 →
   理论上可自递归。实际不可达（影子两个 invocation 都是 false，模型与 `/命令`
   都调不到），暂不改。~~
   **2026-10-22 更正：可达，已修。** 模型侧走 `skill` 工具确实调不到（先 `list()`，
   影子 `modelInvocable:false` 直接抛错），但 `dsh-tool-skill` 的 `agent/pre-step`
   对 `/name` 手势是**先 `get` 再判 `userInvocable`**（line 909），于是人打一轮
   `/<被屏蔽的技能名>` 就会触发 `registry.get → provider.get → registry.get`
   的无限回环（async，栈不涨、Promise 不 settle → 静默卡死）。
   现在 `get()` 对 denied 名字直接返回 deny 定义（`content: ""`），不再回问宿主。
