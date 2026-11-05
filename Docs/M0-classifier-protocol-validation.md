# M0: 分类模型协议、超时与 TLS/代理验证

**日期：** 2026-11-05

**结论状态：** 本地 test-only conformance harness 通过；生产客户端和院内连通性未验证。

## 结论摘要

新增了一个无 npm 依赖的本地 Node.js conformance harness，用本机 mock 验证 FR-3 的 OpenAI 兼容请求形状、分类 JSON、总请求超时、TLS 证书/主机名校验，以及 HTTPS CONNECT 代理传输。

**本报告验证的是测试专用 reference client，不是生产分类器客户端，也不证明医院网络、模型服务或院内部署配置可用。** issue #8 实现实际客户端后，仍需让该客户端运行同一 mock conformance tests，再单独进行院内环境验收。

## 环境与复现

- Node.js：`v24.13.0`
- OpenSSL：`3.6.3 9 Jun 2026`
- 测试命令（从仓库根目录运行）：

  ```sh
  node --test tests/model-gateway/*.test.mjs
  ```

- 结果：9 tests，9 passed，0 failed，0 skipped。
- TLS 测试在每次运行时通过本机 OpenSSL 在唯一临时目录创建测试 CA 和仅含 `DNS:localhost` SAN 的服务器证书。私钥限制为仅当前用户可读写；测试清理临时目录，不在仓库中保存证书或私钥。
- 不访问外部服务，不需要安装 npm 包。

## 覆盖结果

| 验收项 | 结果 |
|---|---|
| `POST /v1/chat/completions` 与 OpenAI response envelope | 通过；mock 记录 method、path、headers 和请求 JSON |
| 分类结果 JSON | 通过；检查 `decision`、`category`、`reason`、`confidence` 的字段、类型与取值范围；畸形 JSON 被拒绝 |
| 请求参数 | 通过；reference client 发送 `temperature: 0`、`max_tokens: 200`，以及传入的 model/messages |
| 超时及不重试 | 通过；3500 ms mock 延迟下，1500 ms 请求超时在 1200–2500 ms 断言窗口内触发；mock 最终只收到 1 次请求 |
| 默认 TLS 信任 | 通过；系统默认信任不包含本地测试 CA，连接失败 |
| 自定义 CA 与主机名校验 | 通过；显式配置测试 CA 后 `localhost` 成功，同一证书用于 `127.0.0.1` 时因无 IP SAN 而失败 |
| HTTPS CONNECT 代理 | 通过；验证 `CONNECT localhost:<port>`、仅接受 200 CONNECT 响应，并在隧道内继续验证 CA 和 hostname；错误 authority、未信任 CA 和主机名不匹配均失败 |
| 临时资源清理 | 通过；每个测试注册清理，证书 fixture 另断言临时目录已删除；mock server、代理隧道和 socket 均关闭 |

## 院内配置待提供与验证

以下值均为待确认项，不在本 harness 中预设或填入真实值：

- 模型 base URL、协议兼容性及完整 endpoint 路径。
- 院内模型名。
- 是否需要认证、认证方式，以及安全的服务端密钥配置来源；密钥不得写入日志或回显。
- 如使用院内 CA，批准的 CA 文件及其部署路径。
- 代理类型、地址、认证要求，以及代理是否支持 HTTPS CONNECT。
- TLS 目标 hostname 与服务器证书 SAN 是否匹配。
- 部署环境中的 DNS、路由、防火墙及模型服务可达性。

院内 URL、模型、认证、CA、代理和网络连通性尚未验证。

## 边界

- `tests/model-gateway/reference-client.mjs` 是仅供测试使用的参考传输，不是可供生产插件导入的客户端 API。
- 超时测试证明传输会超时并且不重试；它**不**验证生产状态机是否按 FR-3 将超时映射为 `unknown` 并放行。
- 没有连接医院模型，没有使用真实凭据、患者数据、院内 endpoint 或生产证书。
- OpenSSL 缺失或证书生成失败时测试会明确报错，不跳过 TLS 覆盖。
- 生产客户端实现后，issue #8 必须使用该 mock 验证实际客户端；院内连通性和参数仍需在获批环境另行验收。
