# M3 文件路径边界与 DSH 沙箱验证

## 1. 目标与范围

对应 FR-7 / issue #13：在 Host 侧限制已注册文件工具可达的路径，只允许当前会话工作区；`~/.dsh`、`/root` 等保护前缀始终拒绝；覆盖 `..` 穿越和符号链接逃逸。守卫失败时按 FR-10 放行。

本阶段只接入 DSH 已公开的 `tools.guard` 接口，不修改 DSH 本体或 `dsh-plugin-hzhospital`，也不替换 `dsh-sandbox-policy`。

## 2. 接口确认

本地 DSH `0.2.1-rc.5` 的实现与类型声明确认了以下事实：

- `dsh-sandbox-policy` 默认只约束文件**写入**（以及部分命令执行），普通文件读取不受其限制；仅靠宿主沙箱不能阻止读取工作区外的配置、证书或令牌。
- `ToolRuntime.guard(guard)` 注册进程级、同步的工具守卫；守卫签名是 `(execution) => string | undefined`，返回字符串即拒绝该次工具调用，返回 `undefined` 放行。
- `ToolExecution` 提供 `name`、已解析的 `arguments`，以及可选的 `agent`；会话工作区位于 `agent.session.header.cwd`。
- DSH 文件工具的参数名：`read` / `write` / `edit` / `read_image` 使用 `file_path`，`glob` / `grep` / `str_replace_editor` 使用 `path`。
- `guard` 是同步接口，不能在其中执行异步 I/O；因此符号链接校验使用同步 `realpathSync.native`，与 DSH fs 工具使用的 `realpath.native` 一致。

## 3. 实现

新增 `sandbox-guard.js`，并在插件入口 `index.js` 接线：

1. `createSandboxGuard({ getConfig })` 返回同步守卫，从 `index.js` 的 `activeConfig` 读取已加载配置；配置加载完成前 `activeConfig` 为 `undefined`，守卫放行（fail-open）。
2. 路径处理顺序：
   - 按工具名取路径参数（见上表）；未列出的工具只接受明确的 `file_path` 参数，其余参数不解析；
   - 展开 `~`；相对路径按会话的**当前有效工作目录**解析，与 DSH fs 工具一致（会话可通过 `working_directory` 改变该目录）；
   - 包含性仍按会话创建时的 `session.header.cwd` 检查，因此 `cd` 到工作区外后，相对路径同样被拒绝；
   - 未提供 `path` 的 `glob` / `grep` 以其隐式目录（当前有效工作目录）作为目标检查；
   - 保留请求路径的原始拼写，不在 POSIX 上预先折叠 `..`（Windows 与 DSH 一致，按词法折叠）：DSH fs 工具在 POSIX 上按内核语义**物理**解析 `..`，即先跟随符号链接再回退父目录；
   - 以 `realpath.native` 规范化后的路径为准比较工作区与保护前缀（符号链接、大小写不敏感文件系统均与 fs 工具一致）；仅在无法规范化时退回词法比较；
   - 目标不存在时回溯到最近的已存在祖先再比较，避免“不存在即可绕过”的检测缺口。
3. 拒绝原因是两条固定常量，不回显请求路径、工作区或配置值：
   - `SANDBOX_WORKSPACE_DENIED`：文件访问超出会话工作区；
   - `SANDBOX_PROTECTED_DENIED`：访问受保护路径。
4. 守卫内部任何异常（配置读取、`realpath`、参数结构异常）都返回 `undefined`，不阻断会话（FR-10）。
5. `ctx.tools.guard` 不可用或抛错时，插件输出固定告警并继续工作；pre-step 门禁和工具限制不受影响。

### 配置语义

| 配置 | 结果 |
| --- | --- |
| `enabled=false` | 不判定，守卫放行。 |
| `sandbox.enforce=false` | 不检查文件工具参数（仅排障）。 |
| `sandbox.enforce=true`（默认） | 只允许会话工作区内的路径；相对路径按当前有效工作目录解析、按工作区检查。 |
| 路径位于 `sandbox.denyPaths` 前缀下 | 拒绝，即使位于工作区内。 |
| `sandbox.denyPaths` 含相对路径 | 按会话工作区解析后比较。 |
| 工具无路径参数、或参数不是字符串 | 不判定，放行；由工具自身校验。 |
| 配置或运行状态不可用 | 放行，并保持固定告警。 |

## 4. 验证

新增 `tests/sandbox-guard.test.mjs`（23 个用例），并更新 `tests/config.test.mjs`、`tests/plugin-skeleton.test.mjs` 与 `tests/pre-step-integration.test.mjs`：

- 工作区内相对路径、`..` 归一化后仍在工作区的路径、未提供路径参数的 `glob`/`grep` 放行；
- 有效工作目录被改到工作区外后，相对路径与 `glob`/`grep` 的隐式目录仍被拒绝；
- 工作区外绝对路径、`../../etc/passwd` 式穿越、工作区内的 `~/.dsh`、`~` 展开的保护路径拒绝；
- 相对 `denyPaths` 按工作区解析后拒绝；
- 上表列出的全部文件工具与带 `file_path` 的未知工具都经过检查；
- 拒绝文案不包含请求路径；
- 真实符号链接逃逸被拒绝；符号链接后的 `..`（物理父目录穿越）被拒绝；不存在的目标经已存在祖先判定；
- 大小写不敏感的受保护路径（macOS）按 `realpath.native` 规范化后拒绝；
- 参数结构异常、工具名为空、配置关闭、配置读取抛错、`realpath` 抛错时放行；
- 包含性根目录优先取 `execution.agent.session.header.cwd`，缺失时取宿主 `sandboxPolicy` 的 `workspaceRoot`；
- `sandbox` 配置默认值、覆盖、非法类型与未知键校验；
- 插件入口注册一个守卫，应用销毁时同时释放监听器与守卫。

执行：

```bash
node --test
```

结果：187/187 通过（Node.js 24.13.0）。

## 5. 未验证与边界

- **没有在真实医院 profile 中确认工作区根目录。** 测试使用临时目录和假 `agent`，只验证守卫逻辑与接线；目标 profile 的实际 `cwd`、文件工具后端根目录仍需 #16 验收。
- **不解析 shell 命令。** `bash` / `pwsh` / `terminal_*` 的命令文本不在守卫范围；这些工具必须通过 `tools.allow` 排除，若允许则路径访问只能依赖 DSH 沙箱。
- **不替代 DSH 沙箱。** 守卫补充读取边界，写入范围与命令执行模式仍由目标 profile 的 `dsh-sandbox-policy` 决定。
- **仅覆盖已注册文件工具。** 后续新增工具若使用非 `file_path` 的参数名，需要扩展映射表；未知工具的 `path` 等其他参数不会被解析。
- **工作目录服务缺失时退化为按工作区解析。** DSH fs 工具会注入 `workingDirectory`；若目标 profile 未加载该服务或其不可用，相对路径按工作区解析，与 fs 工具的实际行为可能不一致。
- **无 `header.cwd` 的会话依赖宿主根目录。** 此时包含性取 `sandboxPolicy.workspaceRoot`；若该服务也不可用，包含性退化为当前有效工作目录，另有 `denyPaths` 生效。该宿主状态需在医院 profile 中确认。
- **DSH 安装目录、`$DSH_HOME`、HIS 证书与配置目录不会自动加入 `denyPaths`。** 它们仅在工作区外时被拒绝；若可能落在工作区内，必须在配置中显式加入 `sandbox.denyPaths`。
- **同步守卫无法覆盖异步解析。** 符号链接检查基于调用时刻的 `realpath`；执行与检查之间的路径替换（TOCTOU）不在本阶段处理范围。
- **失败放行。** 配置无效、守卫异常或 Host 不提供 `guard` 时边界不生效，需要在运维监控中关注固定告警。

## 6. 部署建议

1. 在医院 profile 中确认会话工作区根目录，以及实际加载的文件工具名与参数。
2. 保持 `sandbox.enforce=true`；确需访问工作区外材料时，先将其放入工作区，或按审批显式调整 `sandbox.denyPaths`，不要关闭守卫。
3. 用 `tools.allow` 排除 shell 与终端工具，避免绕过路径检查。
4. 在 web、桌面、CLI 入口分别验证工作区内读写、工作区外读取、`..` 穿越和符号链接样本。
5. 医院验收时记录 profile、DSH 版本、沙箱模式、允许/拒绝样本与 Host 告警，交由 #16 归档。
