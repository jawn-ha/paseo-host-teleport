Host Teleport moves Paseo workspaces, uncommitted file edits, and live agent sessions between your local machine and remote SSH servers.

## How it works

When you push or pull a workspace, the plugin runs `rsync` over SSH to synchronize workspace directories (including uncommitted Git changes and untracked files, while excluding build artifacts such as `node_modules` and `dist`). It then transfers Paseo project definitions, workspace records, agent timeline JSON files, and native provider session files (Codex and Claude Code), rewriting home directory paths so the conversation can resume on the target machine.

## Setup

Requires Paseo 0.16.0 or later on macOS or Linux, with `ssh` and `rsync` installed on both hosts and passwordless SSH access configured. The plugin automatically discovers host aliases from `~/.ssh/config`, and you can also add custom `user@host:port` targets in the Host Teleport screen.

## Capabilities

- Sidebar screen (`Host Teleport`) to probe SSH hosts, inspect latency and remote session counts, configure custom targets, and push or pull all active workspaces.
- Composer pill (`Teleport`) on each agent session to push or pull the current workspace and conversation in one click.
- Client slash command (`/teleport push [host]` or `/teleport pull [host]`) and Command Center action.
- Timeline receipt card appended to the agent conversation after each transfer.
