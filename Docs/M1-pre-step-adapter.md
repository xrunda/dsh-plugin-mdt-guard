# M1: `agent/pre-step` 门禁适配

**日期：** 2026-11-06

**结论状态：** Host 侧 `agent/pre-step` 已接入规则、分类器、会话状态与审计；拒绝可阻止模型调用。固定拒答文案的 Web 呈现已实现客户端半边并通过本地契约测试，CLI/桌面端与医院构建仍待验证，见“适配边界”。

## 实现

- `index.js` 在 `apply(ctx)` 中注册唯一 `agent/pre-step` listener，并返回宿主清理函数。
- 首次收到待判定消息时读取并校验 `~/.dsh/mdt/guard.json`，缓存运行实例；配置禁用或无效时保持 DSH 默认行为。
- `pre-step.js` 只处理 `source.kind === 'user'` 的新用户消息：
  - 工具循环或仅注入上下文的 step 直接 `next()`，不调用分类器。
  - 合并本批次用户文本与附件类型，连同 `session.deriveMessages()` 的最近历史交给 gate。
  - gate 返回 `reject` 时返回 `{ kind: 'reject' }`，不调用 `next()`，因此本轮不进入 `step/start` 与模型请求。
  - 允许、未知或适配器异常时调用 `next()`，保持 DSH 原有处理。
- 配置 `audit.enabled=false` 时不创建审计写入器；分类器与审计失败均按既有 gate 行为处理。

## 验证

- `node --test`：136/136 通过。
- 适配器测试覆盖：拒绝批次返回 reject 且不调用 `next()`、允许批次透传宿主决策、工具循环与注入上下文跳过分类、历史上送、附件类型去重、gate/历史异常降级放行、缺失会话 ID 放行、`next()` 拒绝不会重复调用。
- 集成测试以临时 `HOME` 加载真实配置、规则、gate 与审计：硬拒绝返回 reject、`next()` 调用次数为 0、审计文件只含摘要与长度；快速放行透传宿主决策；无效配置输出脱敏告警并保持停用；`enabled=false` 无告警放行。
- 未在真实 DSH Host、医院 profile、web/桌面客户端或上游模型网关上运行；这些仍属于 #16 部署验收。

## 适配边界

1. **固定拒答文案的呈现只覆盖 Web Chat，且未在目标构建验证。** DSH `PreStepDecision` 的 reject 分支只有 `{ kind: 'reject' }`，没有文案字段；默认 Web Chat 也不为 `blocked` 生成 failure row。本包新增的客户端半边在 `conversation.chat.turnTail` 中按 `turn.end.data.reason.kind === 'blocked'` 显示固定文案（不伪造模型消息），实现见 [M1 固定拒答提示条](M1-refusal-notice.md)。CLI 不加载客户端插件，桌面端与医院 Web 构建未验证；这些入口仍只有“拒绝、无提示”。`blocked` 没有拒绝来源字段，其他 `agent/pre-step` 的 reject 也会触发该文案。
2. **被拒输入不进入会话历史。** Host 在 reject 前已领取输入，且官方测试断言不写 `user/message`。这与 PRD FR-5 的输入留存表述不一致，需产品决定后再调整。
3. **绕过面已在服务端入口收窄。** 远程 prompt 路径与 ACP 路径都在服务端构造 `source: { kind: 'user' }` 并经 agent inbox 进入 `agent/pre-step`，客户端不能伪造来源或跳过 listener；但医院实际 profile、web/桌面拓扑、恢复会话和其他入口仍需实测。
4. **配置错误停用并告警。** 配置读取/校验失败时向 Host logger 输出仅含错误码与字段名的固定告警，保持 DSH 默认行为；配置只加载一次，修正文件后需重启 Host 才生效。

参考证据与源码链接见 [M0 验证报告](./M0-plugin-hook-validation.md)。
