# Agent 客户端配置

`setup` 参考 [REA 的客户端配置流程](https://github.com/morluto/rea)：选择客户端、预览、合并、备份和重复运行检查。实现独立于 REA，不需要安装或运行 `rea-agents`。

## 命令

```sh
npm run setup
node dist/index.js setup --client codex,cursor --yes
node dist/index.js setup --all --dry-run
node dist/index.js setup --client vscode --config /absolute/profile/mcp.json --yes
node dist/index.js setup --client codex --name ones-personal --dry-run
```

发布后对应命令为 `npx @suplaser/onces-mcp@latest setup`。`--client` 支持逗号分隔或重复传入；`claude_code` 和 `gemini_cli` 也可识别。`--all` 选择发现配置文件或目录的客户端，不代表检测到应用已安装。自动执行时必须明确选择目标并传入 `--yes`。

`--dry-run` 只显示客户端、文件位置、服务名称和新增/更新状态，不写文件或备份，不展示已有配置的内容。不指定目标时预览已发现的客户端。

## 默认文件位置

`~` 表示用户主目录。以下是用户级配置，不修改项目级配置。

| 客户端 ID | 默认位置 | MCP 节点 |
| --- | --- | --- |
| `codex` | `~/.codex/config.toml` | `mcp_servers` |
| `claude-code` | `~/.claude.json` | `mcpServers` |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers` |
| `gemini` | `~/.gemini/settings.json` | `mcpServers` |
| `vscode` | Windows: `%APPDATA%/Code/User/mcp.json`；macOS: `~/Library/Application Support/Code/User/mcp.json`；Linux: `~/.config/Code/User/mcp.json` | `servers` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| `opencode` | `~/.config/opencode/opencode.json`（已有 `.jsonc` 时优先使用） | `mcp`，兼容已有 `mcp.servers` |

支持 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`GEMINI_CLI_HOME`、`XDG_CONFIG_HOME`、`VSCODE_PORTABLE`、`VSCODE_APPDATA`、`OPENCODE_CONFIG_DIR` 和 `OPENCODE_CONFIG`。路径覆盖值必须是绝对路径。非默认产品版本或配置档案用单个 `--client` 配合 `--config` 指定；项目配置和客户端自身的其他覆盖机制仍可能影响最终加载结果。

Codex 配置格式依据[官方 MCP 文档](https://developers.openai.com/codex/mcp/)。Claude Desktop、VS Code Insiders 等其他客户端或发行版不在自动发现范围内。

## 写入行为

- 注册当前 Node 和本次安装中 `dist/index.js` 的绝对路径，不依赖 GUI 应用的 shell PATH。通过 npx 运行时绑定 npm 缓存中的该次安装；清理缓存、移动安装或升级后须重新执行 `setup`。
- 不读取系统 API Key，不捕获 `ONES_API_KEY`。只转入显式设置且验证为 HTTPS 站点地址的 `ONES_BASE_URL`、`ONES_API_BASE_URL`。首次连接的凭据输入仍由已有认证引导负责。
- 识别本包的 npx 配置或可验证的本包 Node 启动项，复用其原名称并更新启动命令。已有环境变量、启停状态、允许/禁用工具设置都保留，不自动批准工具。
- 同名的其他服务、重复 ONES 条目、无效或重复键配置会报错退出。`--yes` 不允许覆盖冲突；可用 `--name` 选择不同的初始名称。
- 先验证全部目标，再逐个写入。已有文件先在原位置生成 `.onces-mcp.<时间>.<随机值>.bak`。临时文件与原文件位于同一目录，通过锁、修改检查、重命名与回读校验降低覆盖风险。外部程序不遵守此锁时仍可能出现竞争。
- 原有 JSONC 注释、TOML 注释和不相关字段会保留。拒绝非 UTF-8、大于 5 MB 的文件以及文件符号链接。备份可能包含原文件已有的其他服务凭据，应按原配置文件保管。
- 多客户端执行不是整体事务；若后续写入失败，已完成的客户端配置会保留，并显示错误。恢复时使用输出中的备份路径还原原文件，再重启客户端。

`setup` 验证配置写入，不代替 MCP 连接或 ONES API 权限验证；加载后由客户端执行 `tools/list`，再按用户权限进行查询。
