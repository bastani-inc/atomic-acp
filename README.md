<h1 align="center">atomic-acp</h1>

<p align="center">
  <b>Use the <a href="https://github.com/bastani-inc/atomic">Atomic</a> coding agent inside Zed and other editors that speak the Agent Client Protocol.</b>
</p>

<p align="center">
  Chat with Atomic, watch its tool calls and diffs, switch models and thinking levels, and run Atomic workflows from your editor's agent panel.
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#what-works">What works</a>
  &nbsp;·&nbsp;
  <a href="#workflows">Workflows</a>
  &nbsp;·&nbsp;
  <a href="#limitations">Limitations</a>
  &nbsp;·&nbsp;
  <a href="https://docs.bastani.ai/">Atomic docs</a>
</p>

<p align="center">
  <a href="https://github.com/bastani-inc/atomic-acp/actions/workflows/test.yml"><img src="https://github.com/bastani-inc/atomic-acp/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="https://agentclientprotocol.com/"><img src="https://img.shields.io/badge/ACP-v1-0A7EA4" alt="ACP v1"></a>
  <a href="https://docs.bastani.ai/"><img src="https://img.shields.io/badge/docs-atomic-blue" alt="Docs"></a>
  <a href="https://discord.gg/9CvdXUGXR4"><img src="https://img.shields.io/badge/join%20community-discord-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

## How it works

Your editor starts `atomic-acp` and talks to it over stdio using [ACP](https://agentclientprotocol.com/) JSON-RPC. For each chat session, `atomic-acp` starts its own `atomic --mode rpc` process and translates between the two protocols.

```text
Zed (ACP client) ⇄ atomic-acp ⇄ atomic --mode rpc
```

Atomic reads files, edits code, and runs commands on your machine, exactly as it does in the terminal. Only open workspaces you trust.

## Get started

### Prerequisites

- Node.js 22 or newer (20 is the minimum).
- Atomic installed and logged in to at least one model provider:

```bash
npm install -g @bastani/atomic
atomic   # sign in, then quit
```

`atomic-acp` uses whatever `atomic` it finds on your `PATH`. Point it at a different binary with `ATOMIC_ACP_ATOMIC_COMMAND`.

### Install

```bash
npm install -g @bastani/atomic-acp
```

To run from source instead, clone this repository and run `npm install && npm run build`. The entry point is `dist/index.js`.

### Add it to Zed

Open Zed's `settings.json` and add an agent server:

```json
{
  "agent_servers": {
    "Atomic": {
      "type": "custom",
      "command": "atomic-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Other ways to launch it:

| Setup                     | `command`    | `args`                                  |
| ------------------------- | ------------ | --------------------------------------- |
| Global install            | `atomic-acp` | `[]`                                    |
| No install, always latest | `npx`        | `["-y", "@bastani/atomic-acp"]`         |
| Source checkout           | `node`       | `["/path/to/atomic-acp/dist/index.js"]` |

Then open the agent panel, pick **Atomic**, and start a thread.

If Atomic has no working provider login, Zed shows an **Authenticate** banner that opens Atomic in a terminal. You can run the same flow yourself with `atomic-acp --terminal-login`.

## What works

Chat and tools

- Assistant text and reasoning stream into the thread as they arrive.
- Tool calls appear with their status and file locations, so Zed can follow along as files are read and edited.
- Edits and writes show a real diff of the file before and after the change, including Atomic's multi-file edits.
- Bash commands render as terminal output.

Sessions

- Sessions are saved by Atomic in `~/.atomic/agent/sessions/`, so you can pick a thread back up in Zed's history or with `atomic --resume` in a terminal.
- Threads get a title from your first message. Renaming in Atomic updates the title in the editor.
- Deleting a thread in the editor deletes the Atomic session file.
- Sessions survive an adapter restart. The next message restores the saved session.

Models and context

- The model and thinking-level pickers list what your Atomic setup offers, including model-specific levels such as `max`.
- The context window indicator shows how full the current context is after each turn.

Commands and dialogs

- Atomic prompt templates, skills (`/skill:name`), and extension commands such as `/workflow` show up in the slash command menu.
- When an Atomic extension or workflow asks you to pick, confirm, or type something, the editor shows a form. Clients without form support get a permission prompt for pick and confirm questions.
- Extension notifications show up in the thread.

MCP servers

- MCP servers the editor passes in `session/new` and `session/load` are given to that session's Atomic process. Stdio and streamable HTTP servers work; SSE servers are skipped with a warning on stderr, because Atomic doesn't support SSE.
- Their tools are exposed directly as `mcp__<server>__<tool>`, so a prompt can name a tool and the model can call it without codemode or tool search.
- `atomic-acp` doesn't write to `~/.atomic/agent/mcp.json` or `.atomic/mcp.json`. It registers the servers through a temporary Atomic extension in a private directory, deleted when the session's Atomic process exits or the adapter quits. Server names are reduced to letters, digits, `_` and `-`.
- If your own Atomic MCP configuration defines a server with the same name, your configuration wins, as it does for any extension-contributed server.
- Loading a running session with a different set of servers restarts its Atomic process. A session restored by a prompt after an adapter restart has no editor MCP servers until the editor loads it again.

Startup info

- New threads open with a short summary of the Atomic version, skills, prompts, and extensions in use. Set `quietStartup: true` in your Atomic settings to hide it.

## Workflows

Atomic workflows run from the editor the same way they do in the terminal.

```text
/workflow list
/workflow ralph prompt="Add rate limiting to the API"
/workflow status
```

Workflows keep running in the background after the command returns, and you can keep chatting while they do. Progress notices, status lines, and the completion message stream into the thread as they happen. If a workflow stage needs your input, you'll get a form in the editor.

Two extra commands read the workflow history Atomic keeps for the current project:

| Command                   | Shows                                              |
| ------------------------- | -------------------------------------------------- |
| `/workflow-runs [status]` | Recent runs, optionally filtered by status         |
| `/workflow-run <runId>`   | The saved summary for one run (may lag a live run) |

## Slash commands

On top of your Atomic prompts, skills, and extension commands, `atomic-acp` adds:

| Command                        | What it does                                              |
| ------------------------------ | --------------------------------------------------------- |
| `/compact [instructions]`      | Compact the context, with optional instructions           |
| `/autocompact on\|off\|toggle` | Turn automatic compaction on or off                       |
| `/session`                     | Token, message, and cost stats plus the session file path |
| `/name <name>`                 | Rename the session                                        |
| `/export`                      | Export the session as HTML into the working directory     |
| `/steering`, `/follow-up`      | Show or set how queued messages are delivered             |
| `/changelog`                   | Show the installed Atomic changelog                       |

Use the editor's model picker instead of `/model`, its thinking or mode picker instead of `/thinking`, and a new thread instead of `/clear`.

Prompt templates load from `~/.atomic/agent/prompts/` and `<project>/.atomic/prompts/`.

## Configuration

Set these in the `env` object of your agent server entry:

| Variable                             | Default                            | Purpose                                                                           |
| ------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------- |
| `ATOMIC_ACP_ATOMIC_COMMAND`          | `atomic` (`atomic.cmd` on Windows) | Path or name of the Atomic executable. Arguments are not allowed here.            |
| `ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT` | unset                              | Set to `true` to tell the editor it may attach file contents directly to prompts. |

```json
{
  "agent_servers": {
    "Atomic": {
      "type": "custom",
      "command": "atomic-acp",
      "args": [],
      "env": {
        "ATOMIC_ACP_ATOMIC_COMMAND": "/path/to/atomic",
        "ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT": "true"
      }
    }
  }
}
```

Everything else comes from Atomic itself. Provider logins, models, skills, and extensions use your normal Atomic settings in `~/.atomic/agent/settings.json` and `<project>/.atomic/settings.json`. Atomic's own variables, such as `ATOMIC_CODING_AGENT_DIR` and `ATOMIC_CODING_AGENT_SESSION_DIR`, pass through to the Atomic process.

## Limitations

- `ask_user_question` isn't available over ACP because Atomic RPC mode can't carry its custom UI.
- The editor's file and terminal APIs aren't used. Atomic reads, writes, and runs commands locally, and the editor displays the results.
- If you send several messages while Atomic is busy, they are queued and sent one at a time.
- Zed is the client this is tested against. Other ACP clients should work but may render some updates differently.

## Development

```bash
npm install
npm run dev        # run from source with tsx
npm run build
npm test
npm run lint
npm run format
```

The ACP side lives in `src/acp/`, and the wrapper around the Atomic subprocess lives in `src/atomic-rpc/`.

Three smoke scripts exercise a real Atomic install. They need a provider login and use real model tokens, so they aren't part of `npm test`:

```bash
npm run build
npm run smoke:e2e:atomic          # one prompt, checks streamed text and end_turn
npm run smoke:mcp                 # an editor MCP server's tool is called through ACP
node scripts/smoke-workflow.mjs   # runs /workflow list over ACP
```

`npm run` puts `node_modules/.bin` first on `PATH`, which can pick up an older Atomic installed as a dependency. Set `ATOMIC_ACP_ATOMIC_COMMAND=$(which atomic)` to test the one you have installed globally.

## Releasing

Releases go to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers), so there is no npm token in this repository.

1. Merge a commit to `main` titled `Release X.Y.Z` (or `Release X.Y.Z-alpha.N`) that sets the same version in `package.json`.
2. Push a tag named `X.Y.Z` on that commit.

The [publish workflow](.github/workflows/publish.yml) checks the tag against the version and commit title, runs the test suite, stages a draft GitHub Release, publishes to npm from the `npm-publish` environment, and then publishes the release. Stable versions go to the `latest` tag on npm and alpha versions go to `next`.

## Credits

- [pi-acp](https://github.com/svkozak/pi-acp) by Sergii Kozak
- [Pi](https://pi.dev)

## License

[MIT](LICENSE)
