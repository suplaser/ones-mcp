# ONES MCP

让支持 MCP 的 AI 客户端连接 ONES，通过对话查询项目和工作项。

本项目使用用户级个人 API Key，包名为 `@suplaser/onces-mcp`。目前支持只读查询，可访问的数据由你的 ONES 权限决定。

## 可以做什么

- 查看团队的项目列表。
- 查看项目详情。
- 查询工作项列表，支持按项目和工作项类型筛选。
- 查看工作项详情。
- 检查本地 API Key 是否已配置。

## 让 AI 帮你安装

将下面的提示词复制给支持本地操作的 AI 助手，并替换源码目录。也可以附上团队 ID，让 AI 完成一次真实查询验证。

```text
请将 @suplaser/onces-mcp 安装到当前 MCP 客户端，优先使用 npx；若尚未发布，则从本地源码 <项目完整路径> 构建安装。
使用项目自带的 API Key 配置引导，不要在聊天、配置文件或日志中保存 Key。
安装后连接服务，列出可用工具，并用我提供的团队 ID 验证一次项目查询。
```

## 手动安装

### 1. 准备并构建项目

安装 [Node.js](https://nodejs.org/)（推荐 26），在项目目录执行：

```sh
npm install
npm run build
```

### 2. 添加到 MCP 客户端

在客户端的 MCP 设置中添加以下配置，将路径替换为你本机的项目路径，然后启动或重新连接服务：

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

提供团队 ID 后，可以向 AI 提出这样的请求：

- “查询团队 TEAM_ID 的项目列表。”
- “查看这个项目的详情。”
- “查询团队 TEAM_ID 的工作项列表，继续读取下一页。”
- “查看这个工作项的详细信息。”

将 `TEAM_ID` 替换为你的实际团队 ID，可从 ONES 项目页面 URL 获取。AI 可以使用列表查询返回的 ID 继续查看详情。列表分批返回；需要完整列表时，请明确要求继续翻页。

## 通过 npx 使用

当前尚未发布到 npm。发布后，可将客户端配置中的启动方式改为：

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

- **如何检查 Key 是否已保存？** 在项目目录运行 `npm run auth:status`，或让 AI 检查 ONES 凭据配置状态。已保存不代表拥有所有查询权限。
- **查询提示认证或权限不足？** 检查 Key 是否有效、是否授予查询权限，以及你的 ONES 账号能否访问相应团队和项目；需要更换时运行 `npm run auth:login`。
- **使用其他 ONES 部署地址？** 默认连接 `https://sz.ones.cn`。其他部署可在客户端的服务环境变量中设置 `ONES_BASE_URL` 为实际站点地址；若 API 地址不同，再设置 `ONES_API_BASE_URL`。
