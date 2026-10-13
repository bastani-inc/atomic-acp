# atomic-acp

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/get-started/introduction) adapter for the [Atomic coding agent](https://github.com/bastani-inc/atomic).

`atomic-acp` speaks ACP JSON-RPC 2.0 over stdio to an editor such as [Zed](https://zed.dev/docs/agents/external-agents/) and runs a dedicated `atomic --mode rpc` subprocess for each session. Atomic performs local file access and command execution; use it only with workspaces you trust.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Development centers on Zed; other clients may have varying compatibility. Expect some minor breaking changes and see [Limitations](#limitations).

## Features

- Streams assistant text as `agent_message_chunk` and reasoning as `agent_thought_chunk`.
- Maps Atomic tool execution to ACP `tool_call` / `tool_call_update`.
  - File locations support opening context and follow-along in clients such as Zed. Relative paths resolve against the session working directory.
  - For `edit`, a unique `oldText` match in the pre-edit snapshot can supply a 1-based line number. The snapshot also enables structured diffs (`oldText`/`newText`) on completion.
- Session persistence, loading, listing, and deletion.
  - Atomic stores sessions in `~/.atomic/agent/sessions/` by default; adapter mappings live in `~/.atomic/atomic-acp/session-map.json`.
  - Zed session history is supported starting with [v0.225.0](https://zed.dev/releases/preview/0.225.0). Sessions can be resumed in both Atomic and the ACP client.
- File-based, built-in, skill, and extension slash commands, including Atomic workflows. Skills are loaded by Atomic directly.
- Model and thinking selectors via ACP config options, with legacy model/mode compatibility. Model-specific thinking levels come from Atomic's `get_available_thinking_levels`; selectors refresh from applied state after changes.
- Context usage from Atomic's `get_session_stats` → `contextUsage`, reported as ACP `usage_update` after turns, session creation/loading, and model changes. Missing or untrustworthy counts (including immediately after compaction) are omitted. Auxiliary queries have a one-second timeout; explicit `/session` requests do not.
- Structured-question elicitation bridging when both sides support it, subject to the current Atomic limitation below.
- Extension dialogs and notifications, with notification severity metadata.
- Startup information (Atomic version, context, skills, prompts, extensions). Set `quietStartup: true` in Atomic settings to suppress the verbose block; update notices may still appear.

## Prerequisites

- Node.js 22 or newer is recommended (package minimum: Node.js 20).
- **Atomic must be installed separately** and available on `PATH`, or selected with `ATOMIC_ACP_ATOMIC_COMMAND`.
- Atomic RPC must support `get_available_thinking_levels` (verified with Atomic `0.9.35-alpha.4`). Older versions may not support all RPC capabilities, especially structured questions.
- Configure provider credentials in Atomic before using the adapter. Do not put credentials in this repository.

```bash
npm install -g @bastani/atomic
atomic
```

## Install and configure Zed

```bash
npm install -g atomic-acp
```

Add this to your Zed `settings.json`:

```json
{
  "agent_servers": {
    "atomic": {
      "type": "custom",
      "command": "atomic-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Alternatively, use `"command": "npx"` with `"args": ["-y", "atomic-acp"]`. For a source checkout, run `npm install && npm run build`, then use `"command": "node"` with `"args": ["/path/to/atomic-acp/dist/index.js"]`.

### Authentication (ACP Registry support)

The adapter advertises terminal authentication so supporting clients can launch Atomic's interactive setup. In Zed this appears as an **Authenticate** banner. You can also run it manually:

```bash
atomic-acp --terminal-login
```

Registry publication is separate from support for [ACP Registry](https://agentclientprotocol.com/get-started/registry) authentication; use the custom configuration above unless the adapter is listed in your client's registry.

## Environment variables

Set these in the agent server's `env` object when needed:

| Variable                             | Default                            | Purpose                                                                                                                              |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ATOMIC_ACP_ATOMIC_COMMAND`          | `atomic` (`atomic.cmd` on Windows) | Atomic executable name or absolute path, not a shell command with arguments.                                                         |
| `ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT` | `false`                            | Set exactly `true` to advertise ACP embedded-resource support. Resources received when disabled are still converted to text context. |

When embedded context is disabled, compliant clients should avoid sending embedded `resource` blocks; the adapter still degrades gracefully if they do.

Atomic's own environment is inherited by the subprocess. `ATOMIC_CODING_AGENT_DIR` overrides the global Atomic configuration directory, and `ATOMIC_CODING_AGENT_SESSION_DIR` overrides session storage. Provider authentication follows Atomic's configuration; it is not managed by the adapter.

Example Zed environment override:

```json
{
  "agent_servers": {
    "atomic": {
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

Global Atomic settings live at `~/.atomic/agent/settings.json`; project settings live at `<project>/.atomic/settings.json`. Atomic also supports legacy `.pi` settings as compatibility fallbacks. The default `.atomic/agent` paths are intentional, not adapter-owned storage.

## Slash commands

Prompt templates are loaded from top-level `*.md` files in `<Atomic agent dir>/prompts` (normally `~/.atomic/agent/prompts`), `<cwd>/.atomic/prompts`, and configured resource paths. Atomic's project trust policy controls project resource loading. Skill commands appear as `/skill:skill-name` when enabled in Atomic settings.

Adapter built-ins:

- `/compact [instructions...]` — compact context with optional custom instructions.
- `/autocompact on|off|toggle` — configure automatic compaction.
- `/export` — export session HTML in the session working directory.
- `/session` — show session statistics (tokens, messages, cost, session file).
- `/name <name>` — rename the session.
- `/changelog` — show the installed Atomic changelog when available.
- `/steering` and `/follow-up` — inspect or set queue modes.
- `/model` and `/thinking` — point to the client selectors; legacy clients use the mode selector for thinking.

Use the client's new-session action instead of `/clear`.

## Workflows

Atomic extension commands (including `/workflow`) are discovered through RPC and passed through unchanged. Usage text supplies the command argument hint; interactive argument completion itself is not part of ACP slash commands.

- `/workflow list` lists available workflows; other `/workflow` actions run and inspect them.
- `/workflow-runs [status]` lists retained runs for the current project.
- `/workflow-run <runId>` shows a retained run summary. Summaries may lag the live run.

Workflow tool progress, visible extension messages, status text, and text widgets stream as session updates, including after the initiating prompt completes. Workflow dialogs are handled by the extension UI bridge according to client capabilities.

Run `npm run build && node scripts/smoke-workflow.mjs` to check `/workflow list` against the installed Atomic CLI.

## Limitations

The adapter targets ACP v1. Its protocol behavior follows the ACP documentation for [initialization](https://agentclientprotocol.com/protocol/v1/initialization), [stdio transport](https://agentclientprotocol.com/protocol/v1/transports), [session setup/loading](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn), [content](https://agentclientprotocol.com/protocol/v1/content), [tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls), and [slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands). Available methods and capabilities depend on the installed SDK and Atomic version; this is not a claim of complete ACP support.

- No ACP filesystem (`fs/*`) or terminal (`terminal/*`) delegation: Atomic executes locally. Tool output can still be rendered as terminal content by clients that support it.
- ACP `mcpServers` parameters are accepted and stored but not connected to Atomic. Configure integrations in Atomic itself (including the [Atomic MCP adapter](https://github.com/bastani-inc/atomic)).
- Concurrent prompts are queued by the adapter and delivered one at a time after the active prompt finishes.
- Client compatibility is primarily exercised with Zed; other ACP clients may differ.
- `ask_user_question` is not available over ACP with current Atomic RPC (`0.9.35-alpha.4`): `ui.custom()` is unsupported in RPC mode.

## Development

```bash
npm install
npm run dev
npm run build
npm test
npm run lint
npm run format
```

After building, run the opt-in, credentialed end-to-end check:

```bash
npm run smoke:e2e:atomic
```

It starts the built adapter against real Atomic, creates a session in a temporary workspace, selects `openai/gpt-6-luna-fast`, and checks streamed assistant text and `end_turn`. It requires provider access, incurs model usage, and saves a normal Atomic session. It does not run in the unit-test suite.

When running through npm, a locally installed Atomic peer dependency may shadow the global binary. To test a specific installation, set `ATOMIC_ACP_ATOMIC_COMMAND=/path/to/atomic` before running the smoke command.

Protocol handling lives in `src/acp/`; the Atomic JSONL subprocess wrapper lives in `src/atomic-rpc/`.

## Credits

This project is an Atomic-focused fork of [svkozak/pi-acp](https://github.com/svkozak/pi-acp) by Sergii Kozak. Atomic-specific maintenance is by Bastani, Inc.

## License

See [LICENSE](LICENSE) for the license terms.
