Host Teleport 用于在本地电脑与远端 SSH 服务器（如云端开发机、VPS、Homelab）之间双向迁移 Paseo 工作区、未提交的代码改动（Uncommitted diff）以及正在进行的 Agent 会话上下文。

## 工作原理

执行推送（Push）或拉取（Pull）时，插件通过 `rsync` 增量同步工作区目录（包含未 commit 的代码修改和新建文件，默认排除 `node_modules`、`dist` 等构建目录）。`rsync` 会覆盖接收端有差异的同名文件，但不会删除接收端多余文件（不使用 `--delete`）。随后同步 Paseo 项目配置、工作区记录、会话时间线 JSON 以及底层 Agent 原生上下文文件（如 Codex 和 Claude Code 的 `.jsonl` 会话文件），并自动将路径中的 `$HOME` 映射改写为目标主机的用户目录路径。推送完成后默认会在远端主机执行 `paseo daemon restart` 以立即加载迁移后的会话。

## 环境要求

需要 macOS 或 Linux 环境下的 Paseo 0.16.0 及以上版本，本机与远端主机均需安装 `ssh` 和 `rsync` 并配置好免密登录。插件会自动读取 `~/.ssh/config` 中的主机别名，也支持在界面中手动添加 `user@host:port` 目标主机。

## 主要功能

- 侧边栏工作台（`Host Teleport`）：支持一键探测远端 SSH 连通性、延迟与远端会话数，支持批量推送或拉取全部活跃工作区。
- 会话输入框按钮（`Teleport`）：在任意对话底部一键将该会话及所在工作区的未提交代码推送到远端主机，或从远端拉回最新改动。
- 斜杠命令（`/teleport push [host]` 或 `/teleport pull [host]`）及命令面板（⌘K）快捷入口。
- 每次迁移完成后在对话时间线内生成可视化迁移回执卡片。
