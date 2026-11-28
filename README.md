<h1 align="center">atomic-acp</h1>

<p align="center">
  <b>Use the <a href="https://github.com/bastani-inc/atomic">Atomic</a> coding agent in Zed and other editors that speak the Agent Client Protocol.</b>
</p>

<p align="center">
  <a href="#install"><b>Install →</b></a>
  &nbsp;·&nbsp;
  <a href="#what-you-get">What you get</a>
  &nbsp;·&nbsp;
  <a href="#subagents-and-background-work">Subagents</a>
  &nbsp;·&nbsp;
  <a href="#configuration">Configuration</a>
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

Your editor starts `atomic-acp` and talks to it over stdio using [ACP](https://agentclientprotocol.com/). For each chat thread, `atomic-acp` starts its own `atomic --mode rpc` process and translates messages between the two.

```text
Zed (ACP client)  <->  atomic-acp  <->  atomic --mode rpc
```

Atomic reads files, edits code and runs commands on your machine, the same as in a terminal. Only open workspaces you trust.

## Install

`atomic-acp` needs Node.js 20 or newer. It does not install Atomic. It runs whichever `atomic` is on your `PATH`, so install Atomic 0.10.0 or newer separately, in either of two ways.

**With the standalone installer.** This needs no Node.js for Atomic itself:

```bash
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

**With npm.** Atomic's npm package needs Node.js 24.20 or newer:

```bash
npm install -g @bastani/atomic
```

Then install the adapter and sign in to Atomic once:

```bash
npm install -g @bastani/atomic-acp
atomic   # sign in to a model provider, then quit
```

To run a different Atomic, set `ATOMIC_ACP_ATOMIC_COMMAND` to its path. Run `atomic-acp --help` to see all options.

### Add it to Zed

Add this to Zed's `settings.json`:

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

Open the agent panel, pick **Atomic** and start a thread.

If Atomic has no working login, Zed shows an **Authenticate** banner. It opens Atomic in a terminal so you can sign in. Running `atomic-acp --terminal-login` does the same.

To skip the global install of the adapter, use `"command": "npx"` with `"args": ["-y", "@bastani/atomic-acp"]`.

## What you get

- Replies and reasoning stream into the thread as Atomic writes them.
- Tool calls show their status and the files they touch. Edits show a diff, and shell commands show their output.
- Each thread is an Atomic session. It shows up in the editor's history and in `atomic --resume`, keeps its title and survives an adapter restart. Deleting the thread deletes the session.
- The model and thinking pickers list what your Atomic setup offers. The context indicator shows how full the context window is.
- Prompt templates, skills (`/skill:name`) and extension commands appear in the slash menu.
- When Atomic asks you to pick, confirm or type something, the editor shows a form. `ask_user_question` puts all of its questions in one form, including multi-select ones.
- MCP servers configured in the editor are passed to the thread's Atomic process. Their tools are named `mcp__<server>__<tool>`. Stdio and HTTP servers work. SSE servers are skipped. `atomic-acp` never writes to your Atomic MCP config, and a server with the same name in that config takes precedence.
- If Atomic exits in the middle of a message, the message fails with the reason. Your next message starts Atomic again on the same session.

## Subagents and background work

Atomic splits larger tasks across [subagents](https://docs.bastani.ai/orchestration) and background shells. The editor shows each one as a tool call.

- A message ends when Atomic finishes its turn, even if subagents or shells it started are still running. Atomic does not report background work over RPC, so `atomic-acp` cannot wait for it. If you need the result before the message ends, ask the agent to wait for it.
- When background work finishes, Atomic reads the result in a new turn. That turn streams into the thread on its own. A message you send during it joins that turn.
- Cancelling a message stops the current turn and drops any queued messages, like pressing Esc in Atomic. Subagents and shells keep running. Ask the agent to stop them.
- Switching to another thread, deleting a thread, or reopening it with different MCP servers stops its Atomic process. A message still running there ends as cancelled, and its subagents stop with the process.

## Slash commands

On top of your Atomic prompts, skills and extension commands, `atomic-acp` adds:

| Command                        | What it does                                       |
| ------------------------------ | -------------------------------------------------- |
| `/compact [instructions]`      | Compact the context                                |
| `/autocompact on\|off\|toggle` | Turn automatic compaction on or off                |
| `/session`                     | Show the session ID, tokens, messages and cost     |
| `/name <name>`                 | Rename the session                                 |
| `/export`                      | Export the session as HTML into the working folder |
| `/steering`, `/follow-up`      | Show or set how queued messages are delivered      |
| `/changelog`                   | Show the changelog of the installed Atomic         |

For `/model` and `/thinking`, use the editor's pickers. For `/clear`, start a new thread.

## Configuration

Set these variables in the `env` of the agent server entry:

| Variable                             | Default  | What it does                                                    |
| ------------------------------------ | -------- | --------------------------------------------------------------- |
| `ATOMIC_ACP_ATOMIC_COMMAND`          | `atomic` | Path or name of the Atomic executable                           |
| `ATOMIC_ACP_ATOMIC_ARGS`             | unset    | JSON array of extra arguments for every Atomic process          |
| `ATOMIC_ACP_HEADLESS`                | unset    | Set to `1` when no person is there to answer questions          |
| `ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT` | unset    | Set to `true` to let the editor attach file contents to prompts |
| `ATOMIC_ACP_DIR`                     | unset    | Directory for the adapter's own state, see below                |

You can also pass Atomic arguments after `--`, for example `"args": ["--", "--model", "openai/gpt-6.1-sol"]`. The adapter refuses flags it manages itself, such as `--mode` and the session flags.

Everything else comes from your normal Atomic settings, including logins, models, skills, extensions and the session store.

### The adapter's own state

The adapter keeps a single file, `session-map.json`. It records which project each session belongs to, so threads can be listed and reopened. The file lives in `~/.atomic/atomic-acp`, or in `ATOMIC_ACP_DIR` if you set it. The directory is created on first use and only you can read it.

Set `ATOMIC_ACP_DIR` if Atomic runs in a sandbox with its own agent directory (`ATOMIC_CODING_AGENT_DIR`) and your `~/.atomic` is read-only. Without it, starting a session fails because the map cannot be written. Keep the same `ATOMIC_ACP_DIR` afterwards, because a session can only be reopened from the directory it was saved in.

### Headless clients

With `ATOMIC_ACP_HEADLESS=1`, questions return immediately instead of waiting for an answer. `ask_user_question` tells the model that nobody is available, and extension dialogs are cancelled.

## Limitations

- `ask_user_question` needs an editor that supports ACP forms (elicitation). Other editors cannot answer it.
- Atomic reads files, writes files and runs commands itself. The editor's file and terminal APIs are not used.
- Messages sent while Atomic is busy wait in a queue and go out one at a time.
- Zed is the only tested client. Other ACP clients should work, but they may display some updates differently.

## Development

```bash
npm install
npm run dev     # run from source
npm test
npm run lint
npm run build
```

`src/acp/` holds the ACP side and `src/atomic-rpc/` wraps the Atomic process. The `npm run smoke:*` scripts drive a real, signed-in Atomic and spend model tokens, so `npm test` does not run them.

## Releasing

1. Open a pull request that sets the new version in `package.json` and whose last commit is titled `Release X.Y.Z`, or `Release X.Y.Z-alpha.N` for an alpha.
2. Merge it with a squash or rebase merge. A regular merge commit is titled `Merge pull request ...` and does not start a release. For a squash merge, title the commit `Release X.Y.Z`. The ` (#N)` suffix GitHub adds is fine.
3. The [tag-release workflow](.github/workflows/tag-release.yml) tags the commit and starts the [publish workflow](.github/workflows/publish.yml). It checks the tag, runs the tests and publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers). Stable versions go to the `latest` tag and alphas to `next`.

If a publish run fails after the tag exists, start it again from `main`:

```bash
gh workflow run publish.yml --ref main -f tag=X.Y.Z
```

## Credits

- [pi-acp](https://github.com/svkozak/pi-acp) by Sergii Kozak
- [Pi](https://pi.dev)

## License

[MIT](LICENSE)
