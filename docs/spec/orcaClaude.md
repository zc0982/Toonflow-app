# Orca Claude 本机文本供应商

在设置的「文本模型 → 添加供应商 → 内置供应商」中添加「Orca Claude」，然后在对话窗口的模型菜单选择「Claude（Orca 当前账号）」。每次生成均使用本机 Orca 管理的 Claude Code 订阅账号。只有一个已登录的本机账号时自动使用，多个账号时在 Orca 中选择当前账号。

如果升级前打开的标签页仍显示 API Key 输入框，刷新该标签页即可加载免密钥表单。内置供应商详情接口以同一份公开定义返回模型信息和非空的模块源码，供新旧页面读取。

Toonflow 将当前对话的文本记录发送给这台 Mac 上的辅助进程。辅助进程通过 Orca CLI 确定配置目录并核对 Claude Code 登录身份，调用官方 Claude Code 生成文本。历史由 Toonflow 会话保存，支持流式回复和停止生成。此模型支持文本，Claude Code 的工具、MCP 和会话持久化在此次调用中均关闭。

## 在 Mac 上启动

确保 `orca`、`claude` 在当前用户的 PATH 中，账号已在 Orca 登录。在已安装工作区依赖的源码目录运行以下命令，保持辅助进程运行。

```sh
bun apps/server/scripts/orcaClaudeHost.ts
```

辅助进程只监听 `127.0.0.1:43819`，首次运行在 `~/.config/toonflow/orcaClaude/connection.key` 创建本机进程间配对文件。原生运行 Toonflow 时，将服务端环境变量 `TOONFLOW_ORCA_KEY_FILE` 指向这个文件。前端只保存供应商和模型信息。

## 已在 Docker 中运行的本地实例

以下命令适用于 Docker Desktop 或 Colima 且项目名为 `toonflow-official` 的本地实例。使用现有 Compose 项目名和数据卷，保留主服务的 `127.0.0.1` 端口绑定。

```sh
export TOONFLOW_ORCA_LOCAL_PEER="$(docker network inspect toonflow-official_default --format '{{(index .IPAM.Config 0).Gateway}}')"
docker compose -p toonflow-official -f compose.yaml -f compose.orcaClaude.yaml up -d --build
```

Compose 将进程间配对文件只读挂载给 Toonflow。重新创建 Docker 网络后重新读取网关地址。遇到「无法连接本机 Orca 文本服务」时，检查 Mac 上的辅助进程和配对文件挂载。遇到登录状态不一致时，在 Orca 中重新登录对应的 Claude 账号。
