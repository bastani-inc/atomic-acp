<h1 align="center">atomic-acp</h1>

<p align="center">
  <b>Use the <a href="https://github.com/bastani-inc/atomic">Atomic</a> coding agent inside Zed and other editors that speak the Agent Client Protocol.</b>
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#what-works">What works</a>
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

Your editor starts `atomic-acp` and talks to it over stdio with [ACP](https://agentclientprotocol.com/). For each chat thread, `atomic-acp` starts an `atomic --mode rpc` process and translates between the two.

```text
Zed (ACP client) ⇄ atomic-acp ⇄ atomic --mode rpc
```

Atomic reads files, edits code and runs commands on your machine, exactly as it does in a terminal. Only open workspaces you trust.

## Get started

You need Node.js 20 or newer and Atomic 0.10.0 or newer, signed in to at least one model provider:

```bash
npm install -g @bastani/atomic @bastani/atomic-acp
atomic   # sign in, then quit
```

If you use Atomic's standalone release archive instead of the npm package, install only the adapter:

```bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh   # Windows: irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
npm install -g @bastani/atomic-acp
```

`atomic-acp` uses the `atomic` on your `PATH`, or the one `ATOMIC_ACP_ATOMIC_COMMAND` names, and never installs Atomic itself. Run `atomic-acp --help` for its options.

### Add it to Zed

In Zed's `settings.json`:

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

Open the agent panel, pick **Atomic** and start a thread. If Atomic has no working login, Zed shows an **Authenticate** banner that opens Atomic in a terminal. `atomic-acp --terminal-login` does the same.

Without a global install, use `"command": "npx", "args": ["-y", "@bastani/atomic-acp"]`.

## What works

- Text and reasoning stream into the thread. Tool calls show their status and files, edits show a diff, and shell commands show their output.
- Threads are Atomic sessions. They appear in the editor's history and in `atomic --resume`, keep their title and survive an adapter restart. Deleting a thread deletes its session.
- The model and thinking pickers list what your Atomic setup offers, and the context indicator shows how full the context is.
- Prompt templates, skills (`/skill:name`) and extension commands appear in the slash menu.
- When Atomic asks you to pick, confirm or type something, the editor shows a form.
- `ask_user_question` shows all of its questions in one form, multi-select included.
- MCP servers the editor configures reach the thread's Atomic process, and their tools are callable as `mcp__<server>__<tool>`. Stdio and HTTP servers work, SSE servers are skipped. `atomic-acp` never writes to your Atomic MCP config, and a server you define there under the same name wins.
- If Atomic exits during a message, the message fails with the reason, and the next message starts Atomic again on the same session.

## Subagents and background work

Atomic 0.10 has no workflows. The agent splits work across [subagents](https://docs.bastani.ai/orchestration) and background shells instead, and the editor shows them as tool calls.

- A message ends when Atomic finishes its turn, even if subagents or shells it started are still running. Atomic doesn't report background work over RPC, so `atomic-acp` can't wait for it. To keep a message open until a result is in, ask the agent to wait for it.
- When background work finishes, Atomic reads the result in a new turn. That turn streams into the thread without a message of yours. A message you send while it runs joins that turn and ends when it ends.
- Cancelling a message stops the current turn and drops the messages queued behind it, as Esc does in Atomic. Subagents and shells keep running; ask the agent to stop them.
- Opening another thread, deleting a thread, or opening it again with different MCP servers stops its Atomic process. A message still running there ends as cancelled, and its subagents stop with the process.

## Slash commands

Besides your Atomic prompts, skills and extension commands:

| Command                        | What it does                                     |
| ------------------------------ | ------------------------------------------------ |
| `/compact [instructions]`      | Compact the context                              |
| `/autocompact on\|off\|toggle` | Turn automatic compaction on or off              |
| `/session`                     | Session ID, tokens, messages and cost            |
| `/name <name>`                 | Rename the session                               |
| `/export`                      | Export the session as HTML to the working folder |
| `/steering`, `/follow-up`      | Show or set how queued messages are delivered    |
| `/changelog`                   | Show Atomic's changelog                          |

Use the editor's pickers instead of `/model` and `/thinking`, and a new thread instead of `/clear`.

## Configuration

Set these in the `env` of your agent server entry:

| Variable                             | Default  | Purpose                                                         |
| ------------------------------------ | -------- | --------------------------------------------------------------- |
| `ATOMIC_ACP_ATOMIC_COMMAND`          | `atomic` | Path or name of the Atomic executable                           |
| `ATOMIC_ACP_ATOMIC_ARGS`             | unset    | JSON array of extra arguments for every Atomic process          |
| `ATOMIC_ACP_HEADLESS`                | unset    | `1` when no person can answer questions (see below)             |
| `ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT` | unset    | `true` lets the editor attach file contents directly to prompts |
| `ATOMIC_ACP_DIR`                     | unset    | Directory for the adapter's own state (see below)               |

Arguments after `--` also go to every Atomic process, for example `"args": ["--", "--model", "openai/gpt-6.1-sol"]`. Flags the adapter manages itself, such as `--mode` and the session flags, are refused at startup.

Everything else, including logins, models, skills, extensions and the session store, comes from your normal Atomic settings.

### The adapter's own state

The adapter keeps one file of its own, `session-map.json`, which records the project each session belongs to so it can be listed and loaded again. It lives in `~/.atomic/atomic-acp`, or in `ATOMIC_ACP_DIR` when that is set. The directory is made on first use, readable only by you.

Set `ATOMIC_ACP_DIR` when Atomic runs on a private agent directory (`ATOMIC_CODING_AGENT_DIR`) in a sandbox where your `~/.atomic` is read-only; otherwise starting a session fails because the map can't be written. A reload finds a session only through the same `ATOMIC_ACP_DIR` it was saved under.

### Headless clients

With `ATOMIC_ACP_HEADLESS=1`, questions end at once instead of waiting. `ask_user_question` tells the model that no person is available, and extension dialogs are cancelled.

## Limitations

- `ask_user_question` needs an editor that supports ACP forms (elicitation). Without them, the question can't be answered.
- Atomic reads, writes and runs commands itself. The editor's file and terminal APIs aren't used.
- Messages sent while Atomic is busy are queued and sent one at a time.
- Zed is the tested client. Other ACP clients should work but may render some updates differently.

## Development

```bash
npm install
npm run dev     # run from source
npm test
npm run lint
npm run build
```

`src/acp/` holds the ACP side and `src/atomic-rpc/` the Atomic process wrapper. The `npm run smoke:*` scripts drive a real, signed-in Atomic and spend model tokens, so they aren't part of `npm test`.

## Releasing

Merge a pull request whose commit is titled `Release X.Y.Z` (or `Release X.Y.Z-alpha.N`) and sets that version in `package.json`. Any merge style works: a squash merge's ` (#N)` suffix is accepted. The [tag-release workflow](.github/workflows/tag-release.yml) then tags that commit and starts the [publish workflow](.github/workflows/publish.yml), which checks the tag, runs the tests and publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers). Stable versions go to `latest` and alphas to `next`.

To publish a tag that already exists, for example after a failed run, start the publish workflow from `main` with that tag: `gh workflow run publish.yml --ref main -f tag=X.Y.Z`.

## Credits

- [pi-acp](https://github.com/svkozak/pi-acp) by Sergii Kozak
- [Pi](https://pi.dev)

## License

[MIT](LICENSE)
