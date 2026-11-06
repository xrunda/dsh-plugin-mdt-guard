# M1 固定拒答提示条（Web Chat）

对应 Issue #6 的“可见固定拒答”部分。Host 门禁负责在模型调用前结束被拒轮次；本插件另提供一个 Web 客户端半边，在 DSH 默认 Web Chat 中把 PRD FR-5 的固定文案显示为提示条。它不生成、也不伪造任何模型消息。

## 1. DSH 接口事实（rc.5）

以下均在已安装的 `dsh 0.2.1-rc.5` 包内核对：

- `@deepseek-ai/dsh-client-ui-chat` 在 `TurnTailNodeView` 中渲染 `conversation.chat.turnTail` 槽，即使该轮没有 assistant 收尾消息也会渲染。
- 槽的 owner props 为 `{ turn, seq, openFile }`。`turn` 的类型是 `TurnLocation`，其 `end` 字段为 `SessionEvent<'turn/end'> | undefined`；该事件的 `data.reason` 是 `TurnEndReason`，门禁拒绝时为 `{ kind: 'blocked' }`。因此只识别被拒轮次不需要伪造事件，也不必读取会话文本。
- 客户端插件包通过 `package.json` 的 `dsh.client` 声明平台，bundle 在页面中调用 `globalThis.__ModuleLoader__.load({ id, factory })` 注册工厂；工厂内通过 cordis 的 `ctx.slots.inject(slot, callback)` + `ctx.slots.register(options, Component)` 挂载组件。`conversation.chat.turnTail` 是 `kind: 'list'` 的槽，rc.5 的 `SlotCore.register` 对 list 注册强制要求 `options.id`，缺失会同步抛错。`react/jsx-runtime` 属于客户端平台基线模块，无需声明 `external`；其签名是 `jsx(type, props, key)`，文案必须放在 `props.children`。

## 2. 实现

- `client.js`：Web 客户端半边。仅当 `turn.end.data.reason.kind === 'blocked'` 时渲染一句固定文案；其他结束原因（`completed`、`max-tokens`、`aborted` 等）返回 `null`。注册时带 `id: '@local/dsh-mdt-guard'` 以满足 list 槽要求，文案放在 `props.children`。
- 文案与 Host 默认 `refusalText` 一致，由测试 `tests/client.test.mjs` 与 `config.js` 的默认值比对，避免两边漂移。
- `package.json`：导出 `./client`，`files` 包含 `client.js`，并声明
  `dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-chat'] }`。`inject` 表示包依赖边，保证 UI Chat 的 bundle 先于本插件到达。
- 提示条是纯 UI 文本：不写入会话日志、不触发模型调用、不改变门禁结果；它只是把已经发生的 `blocked` 结果呈现给用户。

## 3. 验证

- `tests/client.test.mjs`：bundle 注册 id 与导出形状；`apply` 只向 `conversation.chat.turnTail` 注入一次，并带 list 槽必需的 `id`；伪 `jsx` 按 `(type, props, key)` 契约建模，断言文案位于 `props.children`；`blocked` 渲染固定文案，其他原因和缺失 turn 返回 `null`；文案与 Host 默认值一致。
- `tests/plugin-skeleton.test.mjs`：包清单中的 `./client` 导出、`client.js` 打包白名单与 `dsh.client` 声明。
- 全量 `node --test`：192 项通过。

未验证项：

- 未在真实浏览器 + 医院 DSH Web 构建中加载该客户端插件。单元测试使用伪 `__ModuleLoader__` 与伪 slot 注册表，证明的是插件自身契约，不是目标构建的加载结果。
- 桌面端与 CLI 未验证。CLI 没有 Web Chat 的 slot 渲染路径；门禁仍会拒绝，但不会显示该提示条。
- 医院 web/桌面包是否启用客户端插件、slot 名称是否与 rc.5 一致，需在目标环境复验。

## 4. 已知限制

- **只覆盖 Web Chat。** 默认 CLI 不加载客户端插件，被拒轮次没有可见文案；不得据此宣称所有入口均已满足 FR-5 的固定拒答呈现。
- **`blocked` 不区分拒绝来源。** rc.5 的 `turn/end` 只记录结束原因，没有字段标明是哪一个 `agent/pre-step` listener 拒绝的；其他插件（例如归档会话或失效 goal round）返回 reject 时也会显示本 MDT 文案。当前版本无法在客户端只归因于 MDT 门禁，需在部署说明中告知。
- **文案固定为默认值。** 若管理员在 `guard.json` 自定义 `refusalText`，Host 审计与门禁结果使用自定义值，但客户端提示条仍显示默认文案。当前版本不把配置下发给客户端。
- **被拒输入不在 transcript。** DSH reject 路径不写入 `user/message`，因此刷新页面后可能只看到提示条而看不到原始输入；这是 DSH 行为，与 PRD FR-5 的留存表述不同，需产品侧决定。
- **客户端插件失败不影响门禁。** 若客户端 entry 未激活，DSH 会报告该插件入口未加载，提示条不出现；Host 侧拒绝与审计不受影响，但用户会失去反馈。不要宣称此时页面一定无报错。
- **样式随宿主主题。** 提示条使用中性边框与继承色，不引入 CSS 文件；若医院构建的排版或对比度不满足要求，需要按其设计系统调整。

## 5. 部署

1. 将本包安装到医院 DSH profile（与 Host 插件同一包）。
2. 确认 Web 构建加载了客户端插件；插件清单里的 `platform: 'web'` 与 `inject` 已声明，但运行时是否注册需在浏览器开发者工具中确认 `__ModuleLoader__` 收到 `@local/dsh-mdt-guard`。
3. 发一条明确越界的测试请求，确认轮次结束原因为 `blocked` 且页面显示固定文案；同时核对模型网关没有对应请求。
