# atomic-acp

[Agent Client Protocol (ACP)](https://agentclientprotocol.com/get-started/introduction) adapter for the [Atomic coding agent](https://github.com/bastani-inc/atomic).

`atomic-acp` speaks ACP JSON-RPC 2.0 over stdio to an editor such as [Zed](https://zed.dev/docs/agents/external-agents/) and runs a dedicated `atomic --mode rpc` subprocess for each session. Atomic performs local file access and command execution; use it only with workspaces you trust.

## Prerequisites

- Node.js 22 or newer is recommended (package minimum: Node.js 20).
- **Atomic must be installed separately** and available on `PATH`, or selected with `ATOMIC_ACP_ATOMIC_COMMAND`.
- Configure provider credentials in Atomic before using the adapter. Do not put credentials in this repository.

```bash
npm install -g @bastani/atomic
atomic
```

The real-Atomic smoke test is verified with Atomic `0.9.35-alpha.4`. Older releases may not support all RPC capabilities, especially structured questions.

## Install and configure Zed

Install the adapter globally:

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

The adapter advertises terminal authentication so supporting clients can launch Atomic's interactive setup. You can also run it manually:

```bash
atomic-acp --terminal-login
```

Registry publication is separate from support for ACP registry authentication; use the custom configuration above unless the adapter is listed in your client's registry.

## Environment variables

Set these in the agent server's `env` object when needed:

| Variable                             | Default                            | Purpose                                                                                                                              |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ATOMIC_ACP_ATOMIC_COMMAND`          | `atomic` (`atomic.cmd` on Windows) | Atomic executable name or absolute path, not a shell command with arguments.                                                         |
| `ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT` | `false`                            | Set exactly `true` to advertise ACP embedded-resource support. Resources received when disabled are still converted to text context. |

Atomic's own environment is inherited by the subprocess. In particular, `ATOMIC_CODING_AGENT_DIR` overrides the global Atomic configuration directory, and `ATOMIC_CODING_AGENT_SESSION_DIR` overrides session storage. Provider authentication follows Atomic's configuration; it is not managed by the adapter.

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

## Features

- Streams assistant text as `agent_message_chunk` and reasoning as `agent_thought_chunk`.
- Maps Atomic tool execution to ACP `tool_call` / `tool_call_update`, including file locations when available. Relative locations resolve against the session working directory. Edit tools can include structured diffs and inferred line numbers.
- Supports session history and loading saved sessions. Atomic stores sessions in `~/.atomic/agent/sessions/` by default. Adapter mappings live separately in `~/.atomic/atomic-acp/session-map.json`.
- Offers model and thinking selectors and advertised slash commands.
- Bridges Atomic's structured questions to ACP elicitation when both sides support it.
- Displays startup information. Set `quietStartup: true` in Atomic settings to suppress the verbose startup block; update notices may still appear.

Global Atomic settings live at `~/.atomic/agent/settings.json`; project settings live at `<project>/.atomic/settings.json`. Atomic also supports legacy `.pi` settings as compatibility fallbacks. The default `.atomic/agent` paths are intentional, not adapter-owned storage.

### Slash commands

Prompt templates are loaded from `<Atomic agent dir>/prompts` (normally `~/.atomic/agent/prompts`), `<cwd>/.atomic/prompts`, and configured resource paths. Skill commands appear as `/skill:skill-name` when enabled in Atomic settings. Atomic's project trust policy controls project resource loading.

Adapter built-ins:

- `/compact [instructions...]` — compact context.
- `/autocompact on|off|toggle` — configure automatic compaction.
- `/export` — export session HTML in the session working directory.
- `/session` — show session statistics.
- `/name <name>` — rename the session.
- `/changelog` — show the installed Atomic changelog when available.
- `/steering` and `/follow-up` — inspect or set queue modes.
- `/model` and `/thinking` — point to the client selectors.

Use the client's new-session action instead of `/clear`. Extension-provided slash commands are not currently supported.

## Protocol and limitations

The adapter targets ACP v1. Its protocol behavior follows the ACP documentation for [initialization](https://agentclientprotocol.com/protocol/v1/initialization), [stdio transport](https://agentclientprotocol.com/protocol/v1/transports), [session setup/loading](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn), [content](https://agentclientprotocol.com/protocol/v1/content), [tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls), and [slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands). Available methods and capabilities depend on the installed SDK and Atomic version; this is not a claim of complete ACP support.

- No ACP filesystem (`fs/*`) or terminal (`terminal/*`) delegation: Atomic executes locally.
- ACP `mcpServers` parameters are accepted but not connected to Atomic. Configure integrations in Atomic itself.
- Concurrent prompts are queued by the adapter and delivered one at a time.
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

## Upstream

This project is an Atomic-focused fork of [svkozak/pi-acp](https://github.com/svkozak/pi-acp). Atomic-specific maintenance is by Bastani, Inc.

## License

See [LICENSE](LICENSE) for the license terms.

## Credits

- [pi-acp](https://github.com/svkozak/pi-acp) by Sergii Kozak
