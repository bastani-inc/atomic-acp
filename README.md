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
- Atomic 0.9.39 or newer, installed and logged in to at least one model provider:

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

`atomic-acp --version` prints the installed version and `atomic-acp --help` lists the options. With no options, `atomic-acp` waits for an ACP client on stdio. Any other option before `--` makes it exit with an error.

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

If Atomic has no working provider login, Zed shows an **Authenticate** banner that opens Atomic in a terminal. You can run the same flow yourself with `atomic-acp --terminal-login`. Since Atomic 0.9.42, device-code logins such as GitHub Copilot, Kimi Code and Meta show the code and wait for you to press Enter in that terminal before they open the browser and copy the code.

## What works

Chat and tools

- Assistant text and reasoning stream into the thread as they arrive.
- Tool calls appear with their status and file locations, so Zed can follow along as files are read and edited.
- Edits and writes show a real diff of the file before and after the change, including Atomic's multi-file edits.
- Bash commands render as terminal output.

Sessions

- Atomic saves every session in its own session store (by default its local database), so you can pick a thread back up in Zed's history or with `atomic --resume` in a terminal.
- The editor's thread history lists the project's sessions the way Atomic's `/resume` does: newest first, leaving out sessions that have no messages, name or summary.
- Threads get a title from your first message. Renaming in Atomic updates the title in the editor.
- Deleting a thread in the editor deletes its session from Atomic's session store.
- Listing or deleting sessions of a project with no open thread briefly starts Atomic in that project to read its session store.
- Sessions survive an adapter restart. The next message restores the saved session.
- Work that a previous Atomic process left unfinished in a session, such as messages from background subagents that never reached the agent, is recovered once the session is loaded or restored: Atomic replays it in a turn that streams into the thread, as `atomic --resume` does in a terminal.
- If a session's Atomic process exits during a message, the message fails with an error saying how Atomic exited, and its open tool calls and workflow runs are marked failed. A message that fails never ends as a normal reply. The next message starts Atomic again on the same session, with the same MCP servers.

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
- `atomic-acp` doesn't write to `~/.atomic/agent/mcp.json` or `.atomic/mcp.json`. It registers the servers through a temporary Atomic extension in a private directory, deleted when the session's Atomic process exits or the adapter quits. Env and header values are never written to that file: they reach Atomic through its environment and are used exactly as the editor sent them, with no `${VAR}` or `!command` expansion. Node's compile cache is turned off for that Atomic process so it keeps no copy of the extension. Server names are reduced to letters, digits, `_` and `-`.
- `session/new` and `session/load` fail with invalid params for a server Atomic can't use safely: an HTTP header name that isn't a valid token, a header value with a CR, LF or NUL, a URL containing `${` or `$env:` (Atomic would fill in its own environment variables), or a stdio env value with a NUL. The error names the server and header, never the value.
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

A message that starts workflows, with `/workflow <name>` or through the agent's `workflow` tool, stays open until every run it started has completed, failed, been blocked or been cancelled. Each run shows up as a tool call with its stages and final result. When the runs end, the agent replies to Atomic's completion notice, and then the message finishes. Editors treat the end of a message as "the agent is done", so they don't report a workflow as finished while it is still running.

- Stopping the message (cancel in the editor) also quits the runs it started. They stay resumable with `/workflow resume <runId>`.
- If a run stops to wait for human input, the message stops waiting for that run and tells you. Reply in the thread and the agent can answer the prompt with its `workflow` tool.
- Set `ATOMIC_ACP_WAIT_FOR_WORKFLOWS=0` to end the message as soon as the run starts, as before. Runs then continue in the background, and their notices stream into the thread.

Two extra commands read the workflow history Atomic keeps for the current project:

| Command                   | Shows                                              |
| ------------------------- | -------------------------------------------------- |
| `/workflow-runs [status]` | Recent runs, optionally filtered by status         |
| `/workflow-run <runId>`   | The saved summary for one run (may lag a live run) |

## Slash commands

On top of your Atomic prompts, skills, and extension commands, `atomic-acp` adds:

| Command                        | What it does                                          |
| ------------------------------ | ----------------------------------------------------- |
| `/compact [instructions]`      | Compact the context, with optional instructions       |
| `/autocompact on\|off\|toggle` | Turn automatic compaction on or off                   |
| `/session`                     | Session ID, token, message, and cost stats            |
| `/name <name>`                 | Rename the session                                    |
| `/export`                      | Export the session as HTML into the working directory |
| `/steering`, `/follow-up`      | Show or set how queued messages are delivered         |
| `/changelog`                   | Show the installed Atomic changelog                   |

Use the editor's model picker instead of `/model`, its thinking or mode picker instead of `/thinking`, and a new thread instead of `/clear`.

Prompt templates load from `~/.atomic/agent/prompts/` and `<project>/.atomic/prompts/`.

## Configuration

Set these in the `env` object of your agent server entry:

| Variable                             | Default                            | Purpose                                                                                              |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ATOMIC_ACP_ATOMIC_COMMAND`          | `atomic` (`atomic.cmd` on Windows) | Path or name of the Atomic executable. Arguments are not allowed here.                               |
| `ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT` | unset                              | Set to `true` to tell the editor it may attach file contents directly to prompts.                    |
| `ATOMIC_ACP_WAIT_FOR_WORKFLOWS`      | `1`                                | Set to `0` to end a message without waiting for the workflow runs it started.                        |
| `ATOMIC_ACP_HEADLESS`                | unset                              | Set to `1` when no person can answer questions. See [Headless clients](#headless-clients).           |
| `ATOMIC_ACP_ATOMIC_ARGS`             | unset                              | JSON array of extra arguments for every Atomic process, for example `["--model", "openai/gpt-5.5"]`. |

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

### Headless clients

Set `ATOMIC_ACP_HEADLESS=1` for clients that run Atomic without a person watching, such as automation. Questions then end at once instead of waiting:

- `ask_user_question` returns a tool result saying no person is available, so the model states the question and its assumption in its reply and stops.
- Extension dialogs (pick, confirm, text input) are cancelled, and the thread shows `No person is available to answer "<question>"`.
- When a workflow stops for human input, `atomic-acp` quits that run (it stays resumable with `/workflow resume`) and says so in the thread.

Without the variable, a dialog that the client rejects, for example because it can't show permission prompts, is cancelled with the same notice.

### Extra Atomic arguments

Arguments after `--` are added to every `atomic --mode rpc` that `atomic-acp` starts, after the ones from `ATOMIC_ACP_ATOMIC_ARGS`:

```json
{ "command": "atomic-acp", "args": ["--", "--model", "openai/gpt-5.5", "-e", "/path/to/extension.ts"] }
```

Each argument is passed to Atomic as is, without a shell. `atomic-acp` exits with an error at startup if `ATOMIC_ACP_ATOMIC_ARGS` isn't a JSON array of strings, or if an argument would take over what the adapter manages: `--mode`, `--print`, the session flags (`--session`, `--session-id`, `--session-dir`, `--session-store`, `--session-prefix`, `--storage`, `--storage-file`, `--no-session`, `--continue`, `--resume`, `--fork`, `--import`), `--export`, `--list-models`, `--help`, `--version`, or a nested `--`.

Everything else comes from Atomic itself. Provider logins, models, skills, extensions, and the session store (the `storage` or `sessions.storage` setting, including a shared database joined with `atomic storage join`) use your normal Atomic settings in `~/.atomic/agent/settings.json` and `<project>/.atomic/settings.json`. Atomic's own variables, such as `ATOMIC_CODING_AGENT_DIR`, `ATOMIC_CODING_AGENT_SESSION_DIR` and `ATOMIC_STORAGE`, pass through to every Atomic process.

## Limitations

- `ask_user_question` can't be answered over ACP because Atomic RPC mode can't carry its custom UI. Headless clients get a clear "no person is available" result instead.
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

These smoke scripts exercise a real Atomic install. They need a provider login and use real model tokens, so they aren't part of `npm test`:

```bash
npm run build
npm run smoke:e2e:atomic          # one prompt, checks streamed text and end_turn
npm run smoke:mcp                 # an editor MCP server's tool is called through ACP
npm run smoke:workflow-wait       # /workflow sleepy keeps the message open until the run ends; killing Atomic mid-run fails the message and the next one restarts it
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
