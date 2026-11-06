# dsh-mdt-guard

DSH Host 侧的 MDT 话题门禁插件。它在模型调用前读取 `agent/pre-step`，对用户消息执行硬规则和院内分类器判定，拒绝非 MDT 请求，按会话收紧工具集，并写入隐私优先的 JSONL 审计。

本插件独立安装，不修改 DSH 本体，也不修改 `dsh-plugin-hzhospital`。

**当前状态：** MVP，已通过本地自动化测试与 DSH `0.2.1-rc.5` 的隔离 profile 安装验证。医院目标版本、真实客户端呈现和院内分类器尚未验收，详见 [上线边界](#上线边界)。

## 快速开始

除第 1 步的目录创建/复制外，以下命令都以运行 DSH 的服务账号执行。

```bash
# 1. 将本仓库放到 DSH 服务账号可读的固定目录，例如：
sudo install -d -o dsh -g dsh -m 0755 /opt/dsh-mdt-guard
# 将仓库内容复制到 /opt/dsh-mdt-guard；无需复制 .git，不要放入患者数据
sudo chown -R dsh:dsh /opt/dsh-mdt-guard

# 2. 以运行 DSH 的服务账号安装到目标 profile
dsh plugin --profile <profile> add /opt/dsh-mdt-guard

# 3. 确认组装结果中只有一条 dsh-mdt-guard 记录
dsh --profile <profile> --dump-config | grep -A 2 '@local/dsh-mdt-guard'

# 4. 写入服务端配置（路径基于 DSH 服务账号的 HOME，不是 DSH_HOME）
install -d -m 0700 "$HOME/.dsh/mdt"
install -m 0600 /opt/dsh-mdt-guard/Docs/guard.example.json "$HOME/.dsh/mdt/guard.json"
# 编辑 guard.json，至少填写 classifier.baseUrl 与 classifier.model

# 5. 重启 DSH Host，在测试会话中验证拒绝、放行与降级路径
```

不要用 `--patch` 再次叠加本插件的 `cordis.patch.yml`，否则会重复注册。不要手写 profile 的 `package.json` 或 patch 文件，使用 `dsh plugin` 管理。

完整安装、配置、审计、故障排查与安全边界见 **[管理指南](Docs/ADMIN-GUIDE.md)**。

## 本地验证

```bash
node --test
```

在 Node.js 24.13.0 下全量 187 个测试通过，无运行时依赖。

## 上线边界

- 固定拒答文案由门禁生成，但 DSH 默认 Web Chat 不渲染 blocked turn，用户可能只看到“无回答”；见 [#6](https://github.com/xrunda/dsh-plugin-mdt-guard/issues/6)。
- 被拒绝的输入不会写入 DSH 会话历史，与 PRD FR-5 的留存表述不同。
- 工具限制已按会话通过 `agent.ctx.tools.restrict` 安装。默认 `tools.allow` 为空，即**不保留任何继承的全局工具**（`tools.mode: ptc` 下保留的 `run_code` 传输除外）；必须先在目标环境确认实际工具名再写入白名单。
- 文件路径边界已在 Host 侧通过 `ctx.tools.guard` 安装：已注册文件工具的路径参数只允许会话工作区，相对路径按当前有效工作目录解析、按工作区检查；`sandbox.denyPaths`（默认 `~/.dsh`、`/root`）始终拒绝，覆盖 `..` 穿越与符号链接逃逸。shell 工具的路径访问仍依赖 `tools.allow` 排除与 DSH 宿主沙箱；守卫失败时按 FR-10 放行。
- `guard.json` 当前未开放分类代理字段；需要代理的部署须先完成 [#16](https://github.com/xrunda/dsh-plugin-mdt-guard/issues/16) 的配置扩展与验证。
- 真实医院 profile、web/桌面/CLI 入口、院内分类器准确率与上游网关计数必须在医院测试环境验收。

## 文档

- [管理指南：安装、配置、安全与运维](Docs/ADMIN-GUIDE.md)
- [PRD](Docs/PRD.md)
- [DSH 扩展点验证（M0）](Docs/M0-plugin-hook-validation.md)
- [分类服务协议与 CA 验证（M0）](Docs/M0-classifier-protocol-validation.md)
- [插件骨架与安装冒烟（M1）](Docs/M1-plugin-skeleton-validation.md)
- [pre-step 适配边界（M1）](Docs/M1-pre-step-adapter.md)
- [AC-1–AC-14 验收报告（M1）](Docs/M1-acceptance-report.md)
- [工具限制与 DSH restrict 验证（M3）](Docs/M3-tool-restriction.md)
- [文件路径边界与 DSH 沙箱验证（M3）](Docs/M3-file-boundaries.md)
