# M0: DSH 插件加载、前置拦截与拒答呈现验证

**日期：** 2026-11-05

**结论状态：** 扩展点的公开源码验证完成；拒答呈现、医院部署与跨客户端实测仍待验证。

## 结论摘要

1. DeepSeek 官方 `deepseek-ai/deepseek-harness` 仓库在 `dsh-v0.2.1-rc.3` 和 `dsh-v0.2.1-rc.5` 均包含 `agent/pre-step` waterfall。拒绝决策会在 `step/start` 之前结束本轮，并以 `turn/end` 的 `blocked` 原因收尾。
2. 官方回归测试为 reject 路径配置空 `MockAdapter`，并断言模型请求数、持久化 `user/message` 数和 `step/start` 数均为 0。该测试源码已核对，但本次没有安装 DSH monorepo 依赖并执行该测试；这不是医院环境的运行证据。
3. 需要注意一个产品行为差异：reject 会领取并移出待处理输入，官方测试断言没有 `user/message` 写入会话历史；这与 PRD FR-5「用户消息保留在会话中」不一致。
4. 官方 Web Chat 的默认 `turn-error` 渲染器明确不为 `blocked` 创建 failure row；本次没有找到默认固定拒答文案的证据。Web Chat 有 `conversation.chat.turnTail` 扩展槽，其 `turn` owner prop 为 `TurnLocation`；后续在已安装的 rc.5 类型上确认 `turn.end.data.reason.kind` 可用于只识别 blocked turn，并已据此实现客户端提示条（见 [M1 固定拒答提示条](M1-refusal-notice.md)）。医院构建是否加载该客户端插件仍需部署验证。
5. 公开资料能验证 Host 插件的 bundle/patch 机制和 profile 安装模型，但不能证明医院实际 profile、web/桌面部署拓扑或所有入口均经过该 Host。以上需在医院目标环境实测。

因此，**代码层面可确认 `agent/pre-step` 可用于阻止模型请求；Web Chat 固定拒答已实现客户端半边并通过本地契约测试，但输入留存与医院部署验收尚未完成**。在被拒输入的 UX 差异有明确决定、医院环境证据补齐前，不应将本报告视为 v0.1 可上线结论。

## 验证环境与版本

- 检查方式：macOS 上使用 GitHub CLI 读取官方公开源码、release tags 与插件开发文档；无本地 DSH 安装、医院 profile、医院模型或浏览器/桌面测试环境。
- 官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，仓库描述为 “DeepSeek Harness: Everything is a Plugin.”。
- `dsh-v0.2.1-rc.3`：tag 指向 commit [`1f81c047fc48fa190a683e469daa699857e9afe8`](https://github.com/deepseek-ai/deepseek-harness/commit/1f81c047fc48fa190a683e469daa699857e9afe8)，release 于 2026-10-23 发布。
- `dsh-v0.2.1-rc.5`：tag 指向 commit [`b830ec950faba0a46dda564be3e2d854afed94f1`](https://github.com/deepseek-ai/deepseek-harness/commit/b830ec950faba0a46dda564be3e2d854afed94f1)，release 于 2026-10-30 发布。
- 在两个 tag 下，以下相关文件的 Git blob SHA 相同，表示这些文件在 rc.3 与 rc.5 内容一致（不代表整个发行版无其他差异）：

| 文件 | blob SHA |
|---|---|
| `packages/core/agent-loop/src/agent.ts` | `adf2e33ddcc9b37e8e20e89203a276bcdf18ee5d` |
| `packages/core/agent-loop/tests/loop.spec.ts` | `9ae652df61791d1d0e2110f3b7508ea8524770c8` |
| `packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts` | `902382666da6992f70093262ab699c4ea9e32964` |
| `packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md` | `938798a37451b2c2d9ffb842d7db46edf435f670` |
| `packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md` | `fe88761ae47a73e0d98eb6305b8e724f9dcb57bf` |

## 发现与证据

### 插件注册与安装模型

官方插件开发文档定义了 Host-only bundle：`package.json` 声明 `dsh.bundle.patch`，patch 插入插件行，插件通过 `apply(ctx, config)` 导出，并在 `apply` 中使用 `ctx.on`/`ctx.effect` 注册资源。安装文档要求通过 `plugin_manager` 将 bundle 安装到当前 profile；不应手写 profile 的 `package.json` 或 `cordis.patch.yml`。

- [插件开发工作流](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md)
- [Host bundle 格式与安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md#L1-L27)
- [Host plugin apply 与事件资源注册](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md#L57-L70)
- [Web Client plugin 模型](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md#L1-L13)

这确认了公开 DSH 的插件机制，但文档明确以“当前 profile”为安装目标；没有医院 profile 路径或实际医院加载证据。

### 前置 hook、reject 与模型调用

`@deepseek-ai/dsh-agent-loop` 的 `preStep` 先领取输入并组装 system prompt，再调用 `dispatch.waterfall('agent/pre-step', ...)`。返回 `reject` 时直接返回拒绝决策；主 turn 循环将结束原因设为 `blocked` 并提前退出，正常的 `step/start` 与 `step()` 路径位于其后。

- [rc.3 `preStep` 与 waterfall 调用](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent-loop/src/agent.ts#L268-L287)
- [rc.3 reject 分支与 blocked 收尾](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent-loop/src/agent.ts#L313-L323)
- [rc.5 对应源码](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/core/agent-loop/src/agent.ts#L268-L323)
- [rc.3/rc.5 同一测试文件中的拒绝回归用例](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/core/agent-loop/tests/loop.spec.ts#L905-L915)
- [官方 pre-step 生命周期说明](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/.agents/notes/archived/architecture/2026-07-31-claimed-pre-step-inbox-lifecycle.md)

该测试对 `reject` 分支断言 `adapter.requests` 长度为 0、会话中 `user/message` 数为 0、`step/start` 数为 0。另有测试通过 `ctx.on('agent/pre-step', ...)` 注册 waterfall listener，验证扩展点在 step 边界打开前执行。

**证据边界：** 这些是官方源码和测试断言；本次没有执行 DSH 的 Vitest 测试，也没有医院上游模型网关计数。医院上线验收仍需实际运行并观察上游请求日志/计数。

### 输入留存与拒答可见性

- reject 路径会先 `inbox.claim(...)`，再以 `blocked` 结束 turn。官方 reject 用例没有 `user/message` 写入，也没有 `step/start`。因此 DSH 核心会话历史不会保留被拒输入；PRD FR-5 的输入留存要求需要调整实现方案或明确产品决定。
- Web Chat 的 `turn-error.ts` 对 error、部分 aborted 与 interrupted 生成 failure row；默认分支将 `blocked` 与 completed、max-tokens 等一并排除。因此 `turn/end { reason: blocked }` 本身不等于固定拒答文案。
- `turn-tail` 会为 `turn/end` 构建 turn-tail 节点；当没有 assistant closing 时，`TurnTailNodeView` 仍会尝试渲染 `conversation.chat.turnTail` 槽。`TurnTailOwnerProps` 为 `{ turn, seq, openFile }`，其中 `turn` 是 `TurnLocation`，其 `end` 字段为 `SessionEvent<'turn/end'> | undefined`，`end.data.reason` 即 `TurnEndReason`。因此在已安装的 rc.5 类型上，插件可按 `turn.end.data.reason.kind === 'blocked'` 只识别被拒轮次，无需伪造消息。该结论仍不证明医院 web/桌面包加载了本插件，实现与限制见 [M1 固定拒答提示条](M1-refusal-notice.md)。

相关来源：

- [默认 Web Chat failure row 规则](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts#L36-L49)
- [Turn-tail 从 turn/end 构造数据](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts#L63-L100)
- [无 assistant closing 时仍尝试渲染扩展槽](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx#L47-L50)
- [TurnTail 槽 owner props](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-chat/src/client/contract/slots.ts#L55-L60)
- [UI 插件注册方式与 slot 查询指引](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md#L1-L13)

**拒答呈现结论（本地已实现客户端半边）：** 已采用客户端提示条方案：`client.js` 在 `conversation.chat.turnTail` 中按 `blocked` 结束原因显示固定文案，不伪造 `assistant/message`、不生成模型输出。医院 Web 构建的加载与实际显示仍需 #16 验证；CLI/桌面端没有该提示条。被拒输入是否保留在 transcript 仍是独立的产品决定。

## 版本与验收矩阵

| 验收点 | rc.3 | rc.5 | 结论 |
|---|---|---|---|
| Host bundle 与 profile 插件机制 | 官方开发文档存在 | 相关文档 blob 与 rc.3 相同 | 文档层面已确认；医院安装路径未验证 |
| `agent/pre-step` hook | core source 存在 | 对应 core 文件与 rc.3 相同 | 公开源码已确认 |
| `{ kind: 'reject' }` | 返回前置 hook 的拒绝结果 | 对应 core 文件与 rc.3 相同 | 公开源码已确认 |
| reject 不进入 step/模型请求 | 官方测试断言 requests、step/start 均为 0 | 对应测试文件与 rc.3 相同 | 测试源码已确认；本次未执行，医院网关计数待验证 |
| reject 输入保留在 session | 测试断言没有 `user/message` | 同 rc.3 | **与 PRD FR-5 不一致** |
| 默认 Web 固定拒答 | blocked 不创建 failure row | rc.5 包内类型确认 `turn.end.data.reason` 可用 | 默认 UI 不显示；已实现客户端半边（仅 Web，目标构建未验证） |
| blocked 专属 Client 提示条 | slot 存在，但 owner props 无 reason | `TurnLocation.end` 携带 `turn/end` 原因 | 本地插件已实现；医院构建加载待验证 |
| 医院 web/桌面入口不可绕过 | 未验证 | 未验证 | 需医院部署测试 |

## 可复现的源码检查

以下命令使用官方 tag，复现本报告的源码检查（GitHub CLI 已认证且可访问公开仓库时）：

```bash
gh repo view deepseek-ai/deepseek-harness --json name,description,url,defaultBranchRef

gh api repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.2.1-rc.3 \
  --jq '{name,html_url,published_at,tag_name}'
gh api repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.2.1-rc.5 \
  --jq '{name,html_url,published_at,tag_name}'

gh api 'repos/deepseek-ai/deepseek-harness/contents/packages/core/agent-loop/src/agent.ts?ref=dsh-v0.2.1-rc.3' \
  --jq '.content' | base64 -D | nl -ba | sed -n '268,323p'
gh api 'repos/deepseek-ai/deepseek-harness/contents/packages/core/agent-loop/tests/loop.spec.ts?ref=dsh-v0.2.1-rc.3' \
  --jq '.content' | base64 -D | nl -ba | sed -n '905,915p'
gh api 'repos/deepseek-ai/deepseek-harness/contents/packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts?ref=dsh-v0.2.1-rc.3' \
  --jq '.content' | base64 -D | nl -ba | sed -n '36,50p'
```

`base64 -D` 是本次 macOS 环境的解码参数。将 `ref=dsh-v0.2.1-rc.3` 替换为 `dsh-v0.2.1-rc.5` 可重复检查 rc.5；用 `--jq '.sha'` 可比较两个 tag 下文件的 blob SHA。

本次实际执行了 tag/release 查询、source tree 查询、相关文件读取与 blob SHA 比较。**未执行** DSH monorepo 的 Vitest、未安装 profile、未启动 web/desktop Host、未访问医院模型网关；本地插件仓库也没有运行时代码或测试命令。

## 医院环境待办

- [ ] 确认医院实际 DSH build/tag、profile 绑定方式及 web/桌面 Host 拓扑。
- [ ] 在医院批准的测试 profile 安装 Host bundle，确认服务端 listener 已加载；切换浏览器客户端后仍走同一门禁。
- [ ] 对一条明确拒绝的测试请求同时记录 DSH hook 决策和上游模型网关请求计数/日志，证明模型未被调用。
- [ ] 验证 Web 与桌面客户端能看到完全匹配 PRD 的固定拒答文案，且该文案不是模型生成；确认目标构建加载了本插件客户端半边。
- [ ] 决定被拒输入的历史留存策略，并验证最终行为符合批准后的 FR-5；当前核心实现不会写入 `user/message`。
- [ ] 验证普通会话入口、恢复会话和其他实际客户端都无法绕过 Host 门禁；记录未覆盖的入口。
- [ ] 记录失败/阻塞项及责任方；不要把源码检查或 mock 断言写成医院环境通过。
