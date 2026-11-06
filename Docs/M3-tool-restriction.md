# M3 工具限制与 DSH `restrict` 验证

## 1. 目标与范围

对应 FR-7 / issue #12：对所有会话安装服务端工具白名单/黑名单，默认不向模型暴露未确认的工具，`deny` 优先，并且工具循环内不能绕过限制。

本阶段只接入 DSH 已公开的 `tools.restrict` 接口，不实现文件沙箱和路径边界（#13），也不修改 DSH 本体或 `dsh-plugin-hzhospital`。

## 2. 接口确认

本地 DSH `0.2.1-rc.5` 的实现与类型声明确认了以下事实：

- `ToolRuntime.restrict(filter)` 只接受 agent 作用域，即通过 `agent.ctx.tools.restrict(...)` 调用；从插件全局 `ctx.tools` 调用会抛错。
- `filter.allow` 与 `filter.deny` 至少提供一个；允许列表为空会过滤掉全部继承的全局工具。
- 限制按 agent 作用域叠加，并在 agent 销毁时随作用域释放；后续创建的全局工具在每次解析可见工具时继续受同一限制。
- `restrict` 对未注册的全局工具名、保留的 `run_code` 名称会抛错；因此不能把未确认的配置名直接传入。
- 限制只过滤 agent 继承的工具；注册在该 agent 自身作用域的机制性工具不受影响。
- `agent/created` 在 agent 可做 per-agent 初始化时触发；`ctx.agents.list()` 提供进程内已有 agent。

## 3. 实现

新增 `tool-policy.js`，插件入口 `index.js` 做以下接线：

1. 声明 `inject = ['agents', 'tools']`。
2. 配置加载仍为一次性缓存；启用时返回 `{ config, handler }`，工具限制与 pre-step 判定共享同一份配置。
3. 创建 `createToolScopeInstaller(...)`：
   - 读取 `runtime.config.tools`；
   - `enforce !== true` 时不安装；
   - 通过 `ctx.tools.schemas(agent)` 取得该 agent 当前可见的工具名；
   - 用 `resolveToolFilter` 把配置收敛为 `{ allow, deny }`；
   - 通过 `agent.ctx.tools.restrict(filter)` 安装。
4. 对 `ctx.agents.list()` 中已有 agent 逐个安装；注册 `agent/created` 覆盖之后创建的 agent 和子 agent。
5. 过滤被 Host 拒绝时，立即重试 `{ allow: [], deny: [] }`，保证默认拒绝而不是整体放行；只有降级也失败时才保持 fail-open。
6. 任何失败都只输出固定告警码，不抛出、不阻断 agent 创建。

### 配置语义

| 配置 | 结果 |
| --- | --- |
| `enforce=false` | 不安装限制，保留原有工具集（仅排障）。 |
| `enforce=true, allow=[]` | 拒绝全部继承的全局工具（默认安全值）。 |
| `allow=['a','b']` | 只保留当前已注册的 `a`、`b`；其余全局工具隐藏。 |
| 同一名称同时在 `allow` 和 `deny` | `deny` 优先。 |
| 配置名未在当前 profile 注册 | 忽略；不会抛错，也不会因此放行其他工具。 |
| 配置名被 Host 拒绝（如 agent 自作用域工具） | 整个过滤被拒绝后降级为 `allow=[]`，拒绝全部继承的全局工具。 |
| 配置包含 `run_code` | 忽略；该名称是 DSH 保留传输名。 |
| profile 使用 `tools.mode: ptc` | 保留的 `run_code` 传输在空允许列表下仍可见；FR-7 的脚本禁用假设 `tools.mode: native`。 |

## 4. 验证

新增 `tests/tool-policy.test.mjs`，并更新 `tests/config.test.mjs` 与 `tests/plugin-skeleton.test.mjs`：

- 空 `allow` 产生空允许集合（默认拒绝）；
- 未注册名称不会被授予；
- `deny` 覆盖同名的 `allow`；
- 未注册的 `deny` 被丢弃，避免 `restrict` 抛错；
- `run_code` 不会出现在过滤器中；
- `enforce=false` 和运行实例未启用时不调用限制；
- schema 读取失败、过滤被拒后降级为默认拒绝、降级也失败时保持 fail-open，并上报固定码；
- 配置 `tools.enforce` 默认 `true`，只接受布尔值；
- 插件入口声明 `agents`/`tools` 注入，启动时限制已有 agent，并在 `agent/created` 时限制新 agent。

执行：

```bash
node --test
```

结果：163/163 通过（Node.js 24.13.0）。

## 5. 未验证与边界

- **没有在真实医院 profile 中确认工具名。** 测试使用假 `tools.schemas`，只验证插件的过滤与接线；目标环境的实际工具集合、web/桌面/CLI 一致性仍属于 #16。
- **没有启动真实 DSH Host 做端到端工具调用。** 未验证真实模型被拒绝调用被隐藏工具、允许工具保持原功能，以及上游网关计数。
- **失败路径分三级。** 配置不可用或 schema 读取失败时不安装限制（fail-open）；过滤被 Host 拒绝时降级为拒绝全部继承工具；降级也失败时才完全 fail-open。运维必须监控固定告警。
- **不覆盖 agent 自作用域工具。** 这是 DSH `restrict` 的既定语义；若后续有机制性工具注册到 agent 自身作用域，需要单独评估。配置若写入这类名称，Host 会拒绝整个过滤并触发默认拒绝降级，因此不要配置机制性工具名。
- **PTC 模式保留 `run_code`。** `tools.mode: ptc` 下该保留传输始终可见；要按 FR-7 禁用脚本执行，目标 profile 应使用 `tools.mode: native`，PTC 运行时的隔离需单独验收。
- **不实现文件沙箱。** 任意路径读写、HIS 证书和 `~/.dsh` 的排除仍依赖 DSH 沙箱/宿主策略（#13）。
- **不保证未被工具名覆盖的能力。** `run_code` 等保留传输或后续新增的呈现机制不由本过滤器命名。

## 6. 部署建议

1. 先在测试 profile 中确认实际工具名，不要从文档推断。
2. 初始保持 `allow=[]`，确认模型看不到工具；再逐个加入已确认的 MDT 业务工具。
3. 用 `deny` 显式压掉白名单中风险较高的工具，验证拒绝优先。
4. 在 web、桌面、CLI 入口分别验证相同名称集合。
5. 医院验收时记录 profile、DSH 版本、工具名清单、允许/拒绝样本和 Host 日志，交由 #16 归档。
