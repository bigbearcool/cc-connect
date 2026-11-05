# remote-ssh: run the agent on another machine over SSH

> Community contribution, **not an official cc-connect component**. No cc-connect source code is changed;
> it plugs in through the existing `type = "acp"` agent (`cmd` / `args`). 中文说明见文末。

cc-connect stays on one host (your laptop / a VM that can reach the chat platform), while the agent
(Claude Code via the [ACP adapter](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp))
runs on a **remote machine** over SSH — the same idea as Claude Desktop's SSH mode:

- the remote machine does not need its own Claude login: an OAuth token is injected **per connection**;
- optionally the remote machine does not need internet at all: traffic can go through a reverse tunnel
  to an HTTP proxy on the host (and then shares the host's egress IP);
- chat attachments are uploaded to the remote, and the agent can send files back with `cc-connect send`;
- each chat / group can be bound to a different directory **on the remote** with `/workspace bind`.

```
 chat platform ──► cc-connect (host) ──acp/stdio──► remote-acp.js ──ssh──► claude-agent-acp (remote)
                         ▲                              │  ▲                    │
                         │ cc-connect send              │  │ outbox watcher     │ cc-connect (shim)
                         └──────────────────────────────┘  └────────────────────┘
 optional: remote 127.0.0.1:17897 ──ssh -R──► host HTTP proxy (e.g. 127.0.0.1:7890)
```

## Files

| File | Runs on | Purpose |
|---|---|---|
| `remote-acp.js` | host | ACP launcher used as the project's `cmd`; all logic below |
| `remote.example.json` | host | launcher config (copy and edit) |
| `remote-shim-cc-connect.js` | remote | installed as `~/.cc-connect-remote/bin/cc-connect`; bridges `send` and `workspace-prepare` |
| `tunnel-guard.sh` / `tunnel-guard.cmd` | host | optional auto-reconnecting reverse tunnel |

## Requirements

- Host: cc-connect, Node.js ≥ 18, OpenSSH client with **key-based, non-interactive** login to the remote (`ssh <host> true` must not prompt).
- Remote: Node.js ≥ 18, `@agentclientprotocol/claude-agent-acp` installed (`npm i -g @agentclientprotocol/claude-agent-acp`),
  a POSIX shell, `base64`.
- A long-lived token from `claude setup-token` (run it where you can log in; store it only on the host).

## Setup

1. **Remote — install the adapter and the shim**

   ```bash
   npm i -g @agentclientprotocol/claude-agent-acp      # note the absolute path of dist/index.js
   mkdir -p ~/.cc-connect-remote/bin
   # copy remote-shim-cc-connect.js to ~/.cc-connect-remote/bin/cc-connect, then:
   chmod 755 ~/.cc-connect-remote/bin/cc-connect
   ```

   The shim refuses to run outside a remote-acp session (`CC_REMOTE_BRIDGE=1`), so other tools on
   the remote are not affected.

2. **Host — token and config**

   ```bash
   claude setup-token            # copy the sk-ant-oat01-... line into a file readable only by you
   cp remote.example.json ~/.cc-connect/remote/devbox.json   # edit it
   ```

   | Key | Meaning |
   |---|---|
   | `sshHost` | SSH host / alias |
   | `tokenFile` | local file with the `claude setup-token` token |
   | `remoteHome` | remote `$HOME` (absolute) |
   | `remoteBase` | remote folder whose sub-folders are bindable by name (default: `remoteHome`) |
   | `remoteDefaultCwd` | remote cwd for chats without a binding (default: `remoteHome`) |
   | `localRoot` | local folder = the project's `base_dir`; holds placeholders and attachments |
   | `adapterCommand` | remote command that starts the ACP adapter (use absolute paths) |
   | `proxy` | optional, e.g. `http://127.0.0.1:17897` (the reverse tunnel) |
   | `ccProject` | fallback project name for `cc-connect send` (cc-connect normally sets `CC_PROJECT`) |
   | `ccConnectBinary` | path to `cc-connect` on the host (default: `cc-connect` on PATH) |
   | `autoCreateRemoteDirs` | create `remoteBase/<name>` on the remote when a session starts there (default `true`) |
   | `sshBinary`, `sshExtraArgs`, `systemPromptFile`, `logFile` | optional overrides |

3. **Host — cc-connect project**

   ```toml
   [[projects]]
     name = "devbox"
     mode = "multi-workspace"
     base_dir = "/home/me/.cc-connect/remote/devbox-workspaces"   # == localRoot
     skip_git = true                                             # placeholders are not git repos

     [projects.agent]
       type = "acp"
       [projects.agent.options]                                  # no work_dir in multi-workspace mode
         cmd = "node"
         args = ["/path/to/contrib/remote-ssh/remote-acp.js", "/home/me/.cc-connect/remote/devbox.json"]
         display_name = "Claude @ devbox"

     [[projects.platforms]]
       type = "feishu"
       [projects.platforms.options]
         app_id = "..."
         app_secret = "..."
         allow_from = "..."
         # group_reply_all = true   # answer group messages without @
   ```

   `multi-workspace` is optional. Without it, set `work_dir = <localRoot>` and every chat uses `remoteDefaultCwd`.

4. **Optional — reverse tunnel** (remote without internet, or to share the host's egress IP):
   run `tunnel-guard.sh` / `tunnel-guard.cmd` with `SSH_HOST` and `LOCAL_PROXY_PORT` (your local HTTP proxy),
   keep it alive with systemd / launchd / Task Scheduler, and set `"proxy": "http://127.0.0.1:17897"`.

## Usage in chat

| Goal | Send |
|---|---|
| Bind this chat to `remoteBase/<name>` | `/workspace bind <name>` (spaces as `%20`) |
| Bind to any remote directory | ask the agent: "prepare binding /some/dir" → it runs `cc-connect workspace-prepare` and replies with `/workspace bind @/some/dir`; send that |
| Show / list / remove bindings | `/workspace`, `/workspace list`, `/workspace unbind` |
| Get a file back | just ask ("send me the report") — the agent runs `cc-connect send --file …` |

A group whose name equals a folder under `remoteBase` is auto-bound by cc-connect's naming convention.

## How it works

- **Auth.** The token is the first line written to the SSH stdin; the remote shell exports it as
  `CLAUDE_CODE_OAUTH_TOKEN` and `exec`s the adapter. It never appears in any argv or on the remote disk.
- **Working directory.** cc-connect only accepts bindings to directories that exist **locally**
  (`/workspace bind` checks `base_dir/<name>`), so the launcher keeps empty local placeholders and maps
  the cwd of `session/new|load|resume|fork`:
  `localRoot` → `remoteDefaultCwd`, `localRoot/@/<abs>` → `/<abs>`, `localRoot/<rel>` → `remoteBase/<rel>`.
  Top-level folders of `remoteBase` are mirrored automatically at every start; other directories are
  prepared on demand via `cc-connect workspace-prepare`.
- **System prompt.** For `type = "acp"` cc-connect does not inject its agent prompt
  (`~/.cc-connect/agent-prompts/cc-connect-system.md`), so the agent would not know about `cc-connect send`.
  The launcher appends that file plus remote-specific notes through the adapter's `_meta.systemPrompt`.
- **Inbound files.** In every `session/prompt`, local attachment paths (any spelling: `/`, `\`, `file://`)
  are uploaded to `~/.cc-connect-remote/inbox/<message_id>/` and rewritten.
- **Outbound files.** The shim writes a job to `~/.cc-connect-remote/outbox/`; one SSH watcher per
  agent claims it atomically, the launcher downloads the files and runs the real `cc-connect send`,
  which targets the originating session via the inherited `CC_SESSION_KEY`. The remote loop exits
  when its SSH session ends and puts unprinted jobs back, so no job is lost to an orphan.

## Limitations

- `cron`, `relay`, `--tts` and other cc-connect subcommands are not bridged (`--tts` falls back to text).
- Images embedded inline in a prompt are passed to the agent as-is (not written to the remote disk).
- The host must be up (and the tunnel, if used); same as Claude Desktop's SSH mode.
- A resumed session that previously concluded it "cannot send files" may keep that belief; `/new` fixes it.
- `/workspace bind` takes one argument; encode spaces as `%20` (done for you by `workspace-prepare`).

## Verified

Windows 11 host (cc-connect v1.5.0, Feishu) → macOS 27 remote (claude-agent-acp 0.100.0, Claude Code 2.1.318):
chat, inbound attachment (non-ASCII name with spaces), outbound `cc-connect send`, `/workspace bind` in
DM and group, `group_reply_all`, reverse tunnel (remote egress = host egress).

---

## 中文简介

让 cc-connect 留在本机，agent（Claude Code，经 ACP 适配器）通过 SSH 跑在**另一台机器**上，思路同 Claude Desktop 的 SSH 模式：

- 远端不用登录 Claude：`claude setup-token` 生成的长期 token 只存本机，每次连接经 SSH 标准输入注入；
- 远端可以完全没外网：可选反向隧道，让远端经本机 HTTP 代理出网（出口 IP 与本机一致）；
- 聊天里发的附件自动传到远端，agent 用 `cc-connect send` 回传文件；
- 私聊/每个群可用 `/workspace bind` 绑定远端的不同目录；任意目录先让 agent 执行 `cc-connect workspace-prepare` 再按它给的命令绑定。

不改 cc-connect 源码，只用现有的 `type = "acp"` + `cmd/args` 接入。部署步骤见上文 Setup。
