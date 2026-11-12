# ONES MCP

让支持 MCP 的 AI 客户端连接 ONES，通过对话查询项目和工作项。

本项目使用用户级个人 API Key，包名为 `@suplaser/onces-mcp`。目前支持只读查询，可访问的数据由你的 ONES 权限决定。

## 可以做什么

- 验证当前用户身份与 API Key 权限范围，查看可访问的团队。
- 搜索团队用户，获取负责人等人员的真实 ID。
- 查看项目列表和项目详情。
- 查询工作项列表，支持按项目和工作项类型筛选。
- 查看工作项详情。
- 查询工作项类型、属性目录和项目详情表单字段。
- 检查本地 API Key 是否已配置。

项目详情表单字段不等于新建工作项的完整必填规则。目前仍只提供查询功能。

## 让 AI 帮你安装

将下面的提示词复制给支持本地操作的 AI 助手，并替换源码目录。也可以附上团队 ID，让 AI 完成一次真实查询验证。

```text
请用 @suplaser/onces-mcp 的 setup 为当前 AI 客户端配置 MCP；npm 版本尚未支持时，从本地源码 <项目完整路径> 构建运行。
API Key 使用项目自带的安全输入引导，完成后连接服务并列出可用工具。
```

## 手动安装

### 1. 准备并构建项目

安装 [Node.js](https://nodejs.org/)（推荐 26），在项目目录执行：

```sh
git clone https://github.com/suplaser/ones-mcp.git
cd ones-mcp
npm install
npm run build
```

### 2. 一键配置 AI 客户端

在项目目录执行：

```sh
npm run setup
```

用空格选择客户端，按 Enter 查看并确认配置计划。支持 Codex、Claude Code、Cursor、Gemini CLI、VS Code、Windsurf 和 OpenCode。完成后重启或重新连接所选客户端。

已有配置会先备份，再合并 ONES MCP；其他服务和权限设置会保留。重复执行不会重复添加，遇到同名的其他服务会停止并提示。此步骤不需要 API Key，也不会把 Key 填入客户端配置。

也可以指定客户端或只看预览：

```sh
node dist/index.js setup --client codex,cursor --yes
node dist/index.js setup --client codex --dry-run
```

配置会绑定本次运行所在的安装目录，请保留该目录；移动或更新后重新运行 `setup`。

<details>
<summary>手动添加配置</summary>

也可在客户端 MCP 设置中添加以下配置，将路径替换为本机项目路径：

```json
{
  "mcpServers": {
    "ones": {
      "command": "node",
      "args": ["E:/workspaces-cqwy-oa/ones-mcp/dist/index.js"]
    }
  }
}
```

不同客户端的配置入口和格式可能略有不同。若通过表单添加，启动命令填 `node`，参数填项目中的 `dist/index.js` 完整路径。

</details>

### 3. 配置个人 API Key

Windows 首次启动时，若没有保存 API Key，会自动打开 [ONES 个人 API Key 设置页](https://ones.cn/project/#/profile/personal_openapi_keys) 和一个独立终端：

1. 登录 ONES，在设置页创建个人 API Key，并授予所需的查询权限。
2. 将 Key 值粘贴到弹出的终端，按 Enter 保存。请使用用户级个人 API Key。
3. 返回 AI 客户端，即可开始查询。

输入和粘贴时都显示等长的 `*`。Key 保存在系统凭据库中，不会写入项目文件或日志。已有 Key 时会直接使用，无需重复输入。

也可以在项目目录手动配置或更换 Key（macOS/Linux 请使用此方式）：

```sh
npm run auth:login
```

若已有 Key，会先询问是否覆盖，默认保留。保存新 Key 后，下次查询即可使用，无需重启服务。

### 4. 开始对话

连接成功后，可以向 AI 提出这样的请求：

- “验证我的 ONES 用户身份和权限范围。”
- “列出我能访问的团队，再查询选定团队的项目列表。”
- “查询团队 TEAM_ID 的项目列表。”
- “查看这个项目的详情。”
- “查询团队 TEAM_ID 的工作项列表，继续读取下一页。”
- “查看这个工作项的详细信息。”
- “搜索团队里的张三，获取他的用户 ID。”
- “查看团队的工作项类型，以及这个项目的详情表单字段。”

通常先让 AI 查询团队列表，再选择要查询的团队，无需自己查找团队 ID。若使用带 `TEAM_ID` 的示例，请替换为实际团队 ID。AI 可以使用查询返回的 ID 继续查看详情。项目、工作项、用户和属性目录分批返回；需要完整列表时，请明确要求继续翻页。

## 通过 npx 使用

0.2.0 发布到 npm 后，可以直接运行配置向导：

```sh
npx @suplaser/onces-mcp@latest setup
```

也可以直接将 npm 上已发布的服务添加到客户端。未发布的新功能请使用上面的本地源码方式：

```json
{
  "mcpServers": {
    "ones": {
      "command": "npx",
      "args": ["--yes", "@suplaser/onces-mcp"]
    }
  }
}
```

## 常见问题

- **如何检查 Key 是否可用？** 在项目目录运行 `npm run auth:status` 可检查是否已保存；让 AI 验证 ONES 当前用户身份和权限范围，可检查远端是否接受凭据。具体资源是否可访问，以实际查询结果为准。
- **查询提示认证或权限不足？** 检查 Key 是否有效、是否授予查询权限，以及你的 ONES 账号能否访问相应团队和项目；需要更换时运行 `npm run auth:login`。
- **使用其他 ONES 部署地址？** 默认连接 `https://sz.ones.cn`。其他部署可在客户端的服务环境变量中设置 `ONES_BASE_URL` 为实际站点地址；若 API 地址不同，再设置 `ONES_API_BASE_URL`。
