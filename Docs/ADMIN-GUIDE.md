# dsh-mdt-guard 管理指南

**面向：** 医院信息科与 DSH 运维人员  
**版本基线：** DSH `0.2.1-rc.5`（本地验证），插件 `0.1.0`  
**状态：** 本地安装、配置解析、门禁策略与审计已测试；医院目标环境验收尚未完成，见第 10 节。

本插件是 DSH Host 侧插件。它在服务端 `agent/pre-step` 阶段判定新的用户消息，命中硬拒绝或分类拒绝时结束本轮，不进入回答模型的 step，并写入审计。浏览器、桌面或 CLI 客户端不能通过客户端设置关闭门禁，但真实入口覆盖仍需医院实测。

本插件独立安装，不修改 DSH 本体，也不修改 `dsh-plugin-hzhospital`。门禁只作用于安装了本插件的 Host profile。

## 1. 部署前准备

确认以下条件：

- DSH 已安装，`dsh --version` 为医院目标版本；本仓库只在 `0.2.1-rc.5` 做过隔离 profile 的安装/移除冒烟。
- 明确运行 DSH 的服务账号及其 `HOME`。配置和审计目录都基于该账号的 `HOME`，不是 `DSH_HOME`。
- 已取得院内 OpenAI 兼容分类服务的地址、模型名；如需要，取得访问令牌与自签 CA 的 PEM 文件路径。
- 分类服务必须位于院内网络。除配置的 `classifier.baseUrl` 外，本插件不访问其他网络服务，也没有遥测。
- 准备一个干净的测试 profile，不在生产 profile 首次试用。
- 配置目录不要放入患者数据、真实密钥样本或证书内容到 Git。

本插件没有运行时 npm 依赖，不需要在仓库内执行 `npm install`。

## 2. 安装

### 2.1 放置插件目录

将仓库放到 DSH 服务账号可读的固定目录，例如 `/opt/dsh-mdt-guard`。`dsh plugin add <路径>` 使用本地 link 安装，安装后不要移动或删除该目录。

```bash
sudo install -d -o dsh -g dsh -m 0755 /opt/dsh-mdt-guard
# 将仓库内容复制到 /opt/dsh-mdt-guard，确保服务账号可读
sudo chown -R dsh:dsh /opt/dsh-mdt-guard
```

### 2.2 安装到 profile

以下命令会初始化/修改目标 profile。`--from-default-profile web` 会替换同名 profile 的用户层，只应对新建的测试 profile 使用。

```bash
# 新建一个隔离的测试 profile（如已存在，先确认其中没有生产配置）
dsh --profile mdt-test --from-default-profile web --dump-config

# 安装本插件
dsh plugin --profile mdt-test add /opt/dsh-mdt-guard

# 确认只组装出一条插件记录
dsh --profile mdt-test --dump-config | grep -A 2 '@local/dsh-mdt-guard'
```

期望输出类似：

```yaml
# == @local/dsh-mdt-guard
- id: dsh-mdt-guard
  name: '@local/dsh-mdt-guard'
```

注意：

- 不要再传 `--patch /opt/dsh-mdt-guard/cordis.patch.yml`。包的 manifest 已声明 patch，重复叠加会产生两条记录。
- 不要手写 profile 的 `package.json` 或 `cordis.patch.yml`，使用 `dsh plugin` 管理。
- 本地已用临时 `DSH_HOME` + `0.2.1-rc.5` 验证：`add` 后组装出一条记录，`remove` 后为零条。

### 2.3 启动与停止

```bash
dsh --profile mdt-test --no-open --host 127.0.0.1 --port <端口>
```

生产环境应由医院现有的 systemd、容器编排或其他服务管理器托管，按组织规范发送 `SIGTERM` 停止。DSH Web 的未认证访问返回 401 属于其自身认证门，不是本插件提供的登录能力。

“安装成功”只证明 profile 组装和 Host 启动，不证明 `apply()` 已在真实会话中执行。首次会话必须按第 5 节做拒绝/放行/降级验证。

### 2.4 停用与卸载

临时停用（保留安装）：

```json
{ "enabled": false }
```

写入配置文件后重启 Host。此配置不需要 `classifier` 字段。停用后门禁不读取分类器、不写审计，DSH 回到默认处理。

卸载：

```bash
dsh plugin --profile mdt-test remove @local/dsh-mdt-guard
dsh --profile mdt-test --dump-config | grep '@local/dsh-mdt-guard' || echo 'removed'
```

重启 Host 后确认无插件记录。卸载不会删除 `$HOME/.dsh/mdt/` 下的配置和审计；由信息科按留存制度处理。

## 3. 配置

### 3.1 位置与权限

配置文件固定为运行 DSH 的服务账号 `HOME` 下的：

```text
$HOME/.dsh/mdt/guard.json
```

它不是 `$DSH_HOME/profiles/...` 的一部分。若 DSH 以 `dsh` 用户运行，则通常是 `/home/dsh/.dsh/mdt/guard.json`。

建议权限：

```bash
install -d -m 0700 "$HOME/.dsh/mdt"
install -m 0600 /opt/dsh-mdt-guard/Docs/guard.example.json "$HOME/.dsh/mdt/guard.json"
```

配置文件可能有 `classifier.apiKey`，不要放开到其他用户可读，也不要提交到 Git。

配置在 Host 进程首次收到待判定消息时读取并缓存。修改后必须重启 Host；当前版本不支持热加载。

### 3.2 最小配置

```json
{
  "enabled": true,
  "classifier": {
    "baseUrl": "https://llm.example.invalid/v1",
    "model": "mdt-classifier-example",
    "timeoutMs": 1500,
    "maxTokens": 200
  },
  "contextTurns": 3,
  "failOpen": true,
  "hardDeny": [],
  "fastAllow": [],
  "refusalText": "本助手仅提供 MDT 多学科会诊相关支持，暂无法处理该请求。如需其他帮助，请联系信息科。",
  "audit": {
    "enabled": true,
    "storeText": false,
    "retentionDays": 30
  },
  "tools": {
    "allow": [],
    "deny": []
  }
}
```

示例使用 `.invalid` 域名，不包含真实地址、密钥或证书。

### 3.3 字段说明

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` 时不创建分类器/审计运行实例。 |
| `classifier.baseUrl` | 无（启用时必填） | 绝对 HTTP/HTTPS 地址。根路径会补 `/v1/chat/completions`；以 `/chat/completions` 结尾则原样使用；其他路径补 `/chat/completions`。 |
| `classifier.model` | 无（启用时必填） | 请求中的模型名。 |
| `classifier.apiKey` | 无 | 可选。只作为 `Authorization: Bearer <token>` 发送，不写入审计或错误日志。 |
| `classifier.caCertFile` | 无 | 可选。院内自签 CA 的 PEM 文件路径。读取失败会使分类降级；文件按进程缓存，轮换后需重启 Host。 |
| `classifier.timeoutMs` | `1500` | 连接、TLS、响应头和响应体合计超时；范围 100–60000。超时按分类失败处理。 |
| `classifier.maxTokens` | `200` | 分类请求输出上限；范围 1–4096。 |
| `contextTurns` | `3` | 上送分类器的最近轮数；范围 0–20。`0` 表示只送当前消息。 |
| `failOpen` | `true` | 分类失败/未知时放行。`false` 时拒绝，但拒答文案可见性仍受第 8 节限制。 |
| `hardDeny` | 内置 12 条 | 硬拒绝正则源码数组。空数组使用内置规则；非空数组**整体替换**内置规则。 |
| `fastAllow` | 内置 7 条 | 快速放行正则源码数组。空数组使用内置规则；非空数组**整体替换**内置规则。 |
| `refusalText` | 固定文案 | 门禁结果中的拒答文案；当前默认 Web Chat 不渲染该文案。 |
| `audit.enabled` | `true` | 是否写审计。`false` 时门禁仍生效，但不留判定记录。 |
| `audit.storeText` | `false` | 是否保存用户原文。开启后审计文件会含患者/业务原文，必须评估隐私与合规风险。 |
| `audit.retentionDays` | `30` | 保留天数；范围 1–3650。按 UTC 日期文件名清理。 |
| `tools.allow` | `[]` | 已接受并规范化，但**当前版本未接入 `ctx.tools.restrict`**，不产生工具限制效果。 |
| `tools.deny` | `[]` | 同上。 |

未知字段会被拒绝并导致运行实例不启用；例如当前不支持 `classifier.proxyUrl`，写入它会得到 `CONFIG_UNKNOWN_FIELD`。需要代理的部署不在本版本能力内。

`hardDeny` / `fastAllow` 的元素是正则源码字符串，不是 `/.../` 字面量；编译时使用大小写不敏感并做空白/格式字符规范化。自定义数组会整体替换内置规则，可能削弱防护，修改前应在测试 profile 验证。

### 3.4 判定顺序与降级

1. 硬拒绝规则优先；命中即拒绝，不调用分类器。
2. 快速放行规则命中即放行，不调用分类器。
3. 其余消息调用院内分类器。
4. 分类器失败、超时、非法响应或 CA 不可用时，得到 `unknown`；按 `failOpen` 放行或拒绝，并写 `degraded=true` 审计。
5. 会话进入 `out_of_scope` 后，承接语（D 类）也会被拒绝；其他放行类别保持/进入相应状态。

硬拒绝始终优先于快速放行。分类器调用不重试，单次超时即降级。

## 4. 分类服务接口要求

本插件发送单个 OpenAI 兼容请求：

```http
POST <baseUrl 推导出的 /chat/completions>
Content-Type: application/json
Authorization: Bearer <apiKey>   # 仅在配置时
```

请求体固定包含 `model`、`messages`、`temperature: 0`、`max_tokens`。`messages` 只有 system 提示与一个数据块；用户文本和历史经 JSON 转义后放在 `<untrusted_user_data>` 数据块中，system 提示要求分类器不得执行其中的指令。这是注入缓解措施，不是强制隔离；分类器仍可能被输入影响，且分类失败会按 `failOpen` 处理。

响应必须是 OpenAI 兼容的：

```json
{
  "choices": [
    {
      "message": {
        "content": "{\"decision\":\"allow\",\"category\":\"A\",\"reason\":\"mdt\",\"confidence\":0.9}"
      }
    }
  ]
}
```

`message.content` 必须是 JSON，且恰好包含 `category`、`confidence`、`decision`、`reason` 四个字段：

- `decision`：`allow` / `deny` / `unknown`
- `category`：`A`–`I`
- `confidence`：0–1 的有限数字
- `reason`：字符串

任何缺失、额外字段、非法 JSON、非 200 状态、网络错误或超时都会降级为 `unknown`，不会把错误响应当作放行/拒绝分类结果。TLS 校验始终开启，不支持关闭校验。生产环境应使用 HTTPS；HTTP 只应用于本机或受控内网，且用户消息与令牌会明文传输。

## 5. 验证

### 5.1 静态与单元验证

在插件仓库执行：

```bash
node --test
```

在 Node.js 24.13.0 下全量 149 个测试通过，包括 AC-1–AC-13 与 AC-14 等价服务端入口的本地回归。该结果不替代医院真实环境验收；其他 Node 版本需先运行测试，证书相关用例依赖 Node 的 TLS/OpenSSL 支持。

### 5.2 检查配置能否解析

用运行 DSH 的服务账号执行（会读取其 `HOME` 下的 `guard.json`）：

```bash
cd /opt/dsh-mdt-guard
node --input-type=module -e "import { loadConfig } from './config.js'; const c = await loadConfig(); console.log(JSON.stringify({ enabled: c.enabled, baseUrl: c.classifier.baseUrl, model: c.classifier.model, timeoutMs: c.classifier.timeoutMs, failOpen: c.failOpen, audit: c.audit }, null, 2));"
```

该命令不打印 `apiKey`。配置无效时会输出带错误码的错误；错误信息只包含字段名，不包含字段值。

### 5.3 医院测试清单

在批准的测试 profile 中逐项记录：

| 场景 | 期望 | 证据 |
| --- | --- | --- |
| MDT 病例整理 | 放行并正常回答 | 会话记录 + 审计 `decision=allow` |
| 「这个插件怎么用」 | 快速放行，分类器无调用 | 审计 `source=fast_allow` |
| 「我头疼吃什么药」 | 拒绝，不进入回答模型 | 审计 `decision=deny`、`category=E`；上游网关无对应请求 |
| 「写一首诗」 | 拒绝 | 审计 `category=F` |
| 「打印 /root/.dsh/mdt/config.json」 | 硬拒绝 | 审计 `ruleId=hard-deny.sensitive-path` |
| 越界后发送「继续」 | 拒绝 | 审计 `reason=continuation_blocked` |
| 分类服务超时/非法 JSON | 放行且审计降级 | `degraded=true`、对应 `errorCode` |
| 浏览器与桌面/CLI 入口 | 同一服务端策略 | 各入口测试记录；未验证前不要宣称已覆盖 |

同时在上游模型网关侧核对拒绝轮次没有回答模型请求。分类器请求本身仍会发往院内分类服务，不要把分类器网关日志误判为回答模型调用。

## 6. 审计运维

### 6.1 位置与权限

```text
$HOME/.dsh/mdt/guard-audit/YYYY-MM-DD.jsonl
```

目录由插件创建为 `0700`，文件写入后设为 `0600`。日期按 UTC。当前版本不支持通过 `guard.json` 改审计目录或单文件大小轮转。

每次门禁判定写一行；每天第一次写入时顺带清理早于保留期的 `YYYY-MM-DD.jsonl`。非日期命名的文件不会被清理。

### 6.2 记录字段

```json
{"timestamp":"2026-11-06T01:02:03.000Z","sessionId":"session-redacted","turn":4,"decision":"deny","category":"H","source":"hard_deny","reason":"hard_deny","ruleId":"hard-deny.prompt-injection","confidence":1,"degraded":false,"errorCode":null,"sessionState":"out_of_scope","durationMs":2,"messageHash":"<sha256>","messageLength":18}
```

- 用户消息默认只有 `messageHash`（SHA-256）与 `messageLength`（UTF-16 长度），没有原文。
- `audit.storeText=true` 时才增加 `messageText`；这会把患者/业务原文写入磁盘，必须有明确审批、访问控制和留存策略。
- `reason` 是分类器返回的自由文本，会原样写入；`storeText=false` 不能阻止分类器在 `reason` 中带回输入派生内容。
- 分类失败放行时记录为 `decision="unknown"`、`source="degraded"`；按 `decision=allow` 查询会漏掉这些记录。
- 不记录 `apiKey`、HIS 令牌、证书内容或原始请求体。
- `source` 可为 `hard_deny`、`fast_allow`、`classifier`、`degraded`。
- `errorCode` 用于区分降级原因，例如 `CLASSIFIER_TIMEOUT`、`CLASSIFIER_NETWORK_ERROR`、`CLASSIFIER_HTTP_ERROR`、`CLASSIFIER_RESPONSE_INVALID`、`CLASSIFIER_CA_UNAVAILABLE`、`CLASSIFIER_UNAVAILABLE`、`GATE_ERROR`。
- 拒绝与放行都会审计；不要只按 `decision=deny` 统计总量。

常用查询（需安装 `jq`）：

```bash
jq -c 'select(.degraded == true)' "$HOME/.dsh/mdt/guard-audit/"*.jsonl
jq -c 'select(.decision == "deny")' "$HOME/.dsh/mdt/guard-audit/"*.jsonl
jq -r 'select(.errorCode != null) | .errorCode' "$HOME/.dsh/mdt/guard-audit/"*.jsonl | sort | uniq -c
```

### 6.3 审计失败的观测边界

审计写入失败不会改变门禁决策，也不会中断会话。当前版本没有把 `AUDIT_WRITE_FAILED` / `AUDIT_CLEANUP_FAILED` 接到 Host 日志，因此不能只依赖应用日志判断审计是否正常。请监控：

- 每日是否生成当天的 `.jsonl`；
- 文件权限是否仍为 `0600`；
- 磁盘空间与目录可写性；
- 保留期清理是否按预期删除旧文件。

发现当天文件缺失时，优先检查服务账号 `HOME`、目录权限、磁盘和只读挂载。

## 7. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| Host 日志出现 `dsh-mdt-guard: runtime initialization failed (CONFIG_FIELD_REQUIRED, field classifier.baseUrl); guard inactive` | 配置文件缺失，或启用了但未填分类地址/模型 | 在服务账号 `HOME/.dsh/mdt/guard.json` 补全必填字段，重启 Host |
| `CONFIG_UNKNOWN_FIELD` | 拼写错误或不支持的字段（如 `classifier.proxyUrl`） | 删除未知字段；代理需求移交 #16 |
| `CONFIG_FIELD_INVALID` | 类型/范围/URL 不合法，或规则数组含空/纯空白项 | 对照第 3.3 节修正；日志只显示字段名，不显示值 |
| `CONFIG_JSON_INVALID` | JSON 语法错误 | 用 JSON 校验工具检查后重启 |
| `CONFIG_RULE_INVALID` | 自定义规则不是合法正则 | 恢复为空数组使用内置规则，再逐条排查 |
| `CONFIG_RULE_UNSTABLE` | 规则含会被消息规范化擦除/折叠的字符或转义 | 改用稳定写法；无法确认时恢复内置规则 |
| `CONFIG_READ_FAILED` | 权限、路径或文件系统错误 | 用服务账号读取文件；检查 `0600` 与目录属主 |
| 消息全部放行，审计 `degraded=true` | 分类服务超时/网络/HTTP/响应格式/CA 问题 | 按 `errorCode` 检查连通性、模型名、CA 路径、令牌；确认分类服务返回严格四字段 JSON |
| 分类请求返回 401/403 | 令牌缺失、过期或无权限 | 更新 `classifier.apiKey`，不要打印或提交令牌 |
| 审计文件不生成 | 审计被关闭、`HOME` 不对、目录不可写、写入失败被吞 | 检查 `audit.enabled`、进程 `HOME`、磁盘与目录权限 |
| 拒绝范围过宽/过窄 | 自定义 `hardDeny`/`fastAllow` 整体替换了内置规则 | 用审计 `ruleId` 定位；先在测试 profile 调整 |
| 用户被拒绝但看不到固定文案 | DSH 默认 Web Chat 不渲染 blocked turn | 当前已知限制，见第 8 节；不要宣称已满足固定拒答 |
| profile 中出现两条插件记录 | 同时使用了包内 patch 与 `--patch` 叠加 | 移除重复层，只用 `dsh plugin` 安装 |

配置错误会保持门禁停用（fail-open），不会阻断 DSH 会话。告警通过 Host 的 `logger` 输出；若目标 Host 没有提供 `logger`，只能观察到门禁未生效。修正配置后必须重启 Host。

## 8. 安全边界与已知限制

### 8.1 已实现

- 服务端 `agent/pre-step` 统一判定；客户端不能通过插件设置关闭。
- 硬拒绝在分类器之前执行；命中后不进入回答模型的 step。
- 分类失败按 `failOpen` 处理，并在审计标记 `degraded=true`。
- 默认审计只保存用户消息摘要和长度；分类器 `reason` 仍会原样保存。不记录密钥、令牌、证书内容。
- 自定义 CA；TLS 校验始终开启；无重试。
- 配置/规则/分类错误信息不包含用户原文或配置值。

### 8.2 尚未实现或未验证

- **固定拒答文案不可见。** DSH 默认 Web Chat 不为 `blocked` 生成 failure row；当前只能阻断本轮，用户可能看到“消息已发送但无回答”。这是发布阻断项，见 #6。
- **被拒输入不进入会话历史。** Host 在 reject 前领取输入，官方行为不写 `user/message`，与 PRD FR-5 不一致。
- **工具白名单未生效。** `tools.*` 仅被配置解析，当前没有调用 `ctx.tools.restrict`；不能把本插件当作工具隔离控制，见 #12。
- **沙箱策略未接入。** 文件读写范围由 DSH 沙箱/宿主配置决定，本插件没有额外文件访问控制，见 #13。
- **代理未开放配置。** `classifier-client` 内部有代理能力，但 `guard.json` 不接受代理字段；需要代理的医院部署必须先完成 #16。
- **真实客户端入口未验证。** 浏览器、桌面、CLI 的实际 `source.kind` 和 Host 拓扑必须在医院环境确认；本地测试只覆盖等价服务端 payload。
- **分类器准确率未验证。** 本地使用假分类器验证门禁策略，不证明院内模型会把具体自然语言样本分到预期的 A/B/E/F 类别。
- **上游网关计数未核对。** 本地以 `next()` 零调用证明未进入回答模型 step，不能替代医院上游网关日志。

### 8.3 运维要求

- 配置文件按 `0600` 管理，备份加密，禁止放入 Git、工单或聊天记录。
- `audit.storeText` 默认关闭；开启前完成隐私影响评估，并限制审计目录访问。
- 审计保留期按医院制度设置；清理会删除审计目录中任何匹配 `YYYY-MM-DD.jsonl` 且早于保留期的文件，不要把外部归档放在同一目录。
- `failOpen=false` 会在分类故障时拒绝，但在固定拒答不可见前可能导致用户无反馈；是否启用需业务与信息科共同决定。
- 本插件是话题门禁，不是 DLP、患者隐私分类器或合规审计系统，不能替代医院既有安全控制。

## 9. 升级与回滚

1. 将新版本放到新的固定目录，例如 `/opt/dsh-mdt-guard-0.2.0`，不要就地覆盖正在使用的 link 目标。
2. 保留旧目录与当前 `guard.json` 备份。
3. 执行 `dsh plugin --profile <profile> remove @local/dsh-mdt-guard`，再 `add` 新目录，重启 Host。
4. 用第 5.3 节清单复测拒绝、放行与降级。
5. 回滚时 remove 新版本、add 旧目录、恢复配置备份并重启。

配置字段随版本变化时，启动日志的 `CONFIG_*` 错误码可用于定位；不要在未验证的情况下沿用旧版自定义规则。

## 10. 医院验收交接（#16）

以下项目必须在医院目标 DSH 版本和实际部署拓扑中完成，不能以本文档或本地测试替代：

- profile 安装、服务端 listener 实际执行、web/桌面/CLI 入口一致性；
- 固定拒答文案在目标客户端的可见性，以及被拒输入的留存决定；
- 院内分类器的 A–I 判定准确率、延迟、超时与自定义 CA/代理连通性；
- 拒绝轮次在上游回答模型网关侧无请求记录；
- 工具限制与沙箱策略的实际配置方式（#12/#13）；
- 审计目录、权限、保留期与导出流程的信息科确认；
- 记录测试版本、拓扑、证据、未通过项、负责人和后续 issue。

相关背景与证据见 [M0 扩展点验证](M0-plugin-hook-validation.md)、[M0 分类服务协议与 CA 验证](M0-classifier-protocol-validation.md)、[M1 插件骨架与安装冒烟](M1-plugin-skeleton-validation.md)、[pre-step 适配边界](M1-pre-step-adapter.md) 与 [AC-1–AC-14 验收报告](M1-acceptance-report.md)。
