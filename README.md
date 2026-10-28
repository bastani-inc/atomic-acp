<h1 align="center">atomic-acp</h1>

<p align="center">
  <b>Use the <a href="https://github.com/bastani-inc/atomic">Atomic</a> coding agent inside Zed and other editors that speak the Agent Client Protocol.</b>
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#what-works">What works</a>
  &nbsp;·&nbsp;
  <a href="#workflows">Workflows</a>
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

You need Node.js 20 or newer and Atomic 0.9.39 or newer, signed in to at least one model provider:

```bash
npm install -g @bastani/atomic @bastani/atomic-acp
atomic   # sign in, then quit
```

`atomic-acp` uses the `atomic` on your `PATH`. Run `atomic-acp --help` for its options.

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
- Prompt templates, skills (`/skill:name`) and extension commands such as `/workflow` appear in the slash menu.
- When Atomic asks you to pick, confirm or type something, the editor shows a form.
- `ask_user_question` shows all of its questions in one form, multi-select included.
- MCP servers the editor configures reach the thread's Atomic process, and their tools are callable as `mcp__<server>__<tool>`. Stdio and HTTP servers work, SSE servers are skipped. `atomic-acp` never writes to your Atomic MCP config, and a server you define there under the same name wins.
- If Atomic exits during a message, the message fails with the reason, and the next message starts Atomic again on the same session.

## Workflows

Atomic workflows run from the editor as they do in the terminal:

```text
/workflow list
/workflow ralph prompt="Add rate limiting to the API"
/workflow status
```

A message that starts a workflow stays open until every run it started ends, so the editor doesn't report the agent as done while work is still going. Each run appears as a tool call with its stages and result.

- Cancelling the message quits its runs. Resume one with `/workflow resume <runId>`.
- A run that waits for your input stops holding the message. Reply in the thread and the agent answers the prompt.
- Set `ATOMIC_ACP_WAIT_FOR_WORKFLOWS=0` to end the message as soon as a run starts.

`/workflow-runs [status]` lists the project's recent runs, and `/workflow-run <runId>` shows one run's saved summary.

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
| `ATOMIC_ACP_WAIT_FOR_WORKFLOWS`      | `1`      | `0` ends a message without waiting for the runs it started      |
| `ATOMIC_ACP_HEADLESS`                | unset    | `1` when no person can answer questions (see below)             |
| `ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT` | unset    | `true` lets the editor attach file contents directly to prompts |

Arguments after `--` also go to every Atomic process, for example `"args": ["--", "--model", "openai/gpt-6.1-sol"]`. Flags the adapter manages itself, such as `--mode` and the session flags, are refused at startup.

Everything else, including logins, models, skills, extensions and the session store, comes from your normal Atomic settings.

### Headless clients

With `ATOMIC_ACP_HEADLESS=1`, questions end at once instead of waiting. `ask_user_question` tells the model that no person is available, extension dialogs are cancelled, and a workflow that stops for input is quit. It stays resumable.

## Limitations

- `ask_user_question` needs Atomic 0.9.50 or newer and an editor that supports ACP forms (elicitation). Without them, the question can't be answered.
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

Merge a commit titled `Release X.Y.Z` (or `Release X.Y.Z-alpha.N`) that sets that version in `package.json`, then push the tag `X.Y.Z` on it. The [publish workflow](.github/workflows/publish.yml) checks the tag, runs the tests and publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers). Stable versions go to `latest` and alphas to `next`.

## Credits

- [pi-acp](https://github.com/svkozak/pi-acp) by Sergii Kozak
- [Pi](https://pi.dev)

## License

[MIT](LICENSE)
