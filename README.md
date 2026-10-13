# atomic-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`atomic`](https://github.com/bastani-inc/atomic) coding agent (fka shitty coding agent).

`atomic-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `atomic --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps Atomic tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from Atomic are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `atomic-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `atomic-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - Atomic stores its own sessions in `~/.atomic/agent/sessions/...`
  - `atomic-acp` stores a small mapping file at `~/.atomic/atomic-acp/session-map.json` so `session/load` can reattach to a previous Atomic session file
- Slash commands
  - Loads file-based slash commands compatible with Atomic’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in Atomic settings, they appear as `/skill:skill-name` in the ACP client)
- Model and thinking selectors
  - Exposes ACP session config options, with legacy model/mode compatibility
  - Discovers model-specific thinking levels through Atomic's `get_available_thinking_levels` RPC and refreshes selectors from applied state after changes
- Context window usage
  - Reports Atomic's actual context occupancy (`get_session_stats` → `contextUsage`) as ACP `usage_update` after each turn, on `session/new` and `session/load`, and after model changes
  - Missing or untrustworthy context counts (including immediately after compaction) are omitted until valid data is available
  - Auxiliary usage queries have a one-second timeout; explicit `/session` requests do not
- Skills are loaded by Atomic directly and are available in ACP sessions
- (Zed) `atomic-acp` emits “startup info” block into the session (Atomic version, context, skills, prompts, extensions - similar to `atomic` in the terminal). You can disable it by setting `quietStartup: true` in Atomic settings (`~/.atomic/agent/settings.json` or `<project>/.atomic/settings.json`). When `quietStartup` is enabled, `atomic-acp` will still emit a 'New version available' message if the installed Atomic version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to Atomic's session files. Sessions can be resumed both in `atomic` and in the ACP client.

## Prerequisites

Make sure Atomic is installed

```bash
npm install -g @bastani/atomic
```

- Node.js 22+
- `atomic` installed and available on your `PATH` (the adapter runs the `atomic` executable)
- Atomic RPC must support `get_available_thinking_levels` (verified with Atomic 0.9.35-alpha.4)
- Configure Atomic separately for your model providers/API keys

## Install

### Add atomic-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it:

In Zed launch the registry with `zed: acp registry` command and select `Atomic ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "atomic-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version):

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "atomic": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "atomic-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g atomic-acp
```

```json
  "agent_servers": {
    "atomic": {
      "type": "custom",
      "command": "atomic-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "atomic": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/atomic-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Environment variables

- `ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client.
- Default: unset/any other value means `false`.
- When disabled, compliant ACP clients should avoid sending embedded `resource` blocks. If they send them anyway, `atomic-acp` still degrades gracefully by converting them into plain-text prompt context.

You can add the environment variable in the Zed settings with:

```json
  "agent_servers": {
    "atomic": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/atomic-acp/dist/index.js"],
      "env": {
          "ATOMIC_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Slash commands

`atomic-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: top-level `*.md` files in `<Atomic agent dir>/prompts` (defaults to `~/.atomic/agent/prompts`, honors `ATOMIC_CODING_AGENT_DIR`)
- Project commands: top-level `*.md` files in `<cwd>/.atomic/prompts`

#### 2) Built-in commands

- `/compact [instructions...]` – run Atomic compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/changelog` – print the installed Atomic changelog (best-effort)
- `/steering` - maps to `atomic` Steering Mode, get/set
- `/follow-up` - maps to `atomic` Follow-up Mode, get/set

Other built-in commands:

- `/model` - maps to model selector in Zed
- `/thinking` - maps to the model-specific thinking selector in Zed (legacy clients use the mode selector)
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in Atomic settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

**Note**: Slash commands provided by Atomic extensions are not currently supported.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches Atomic in a terminal.
Launch Atomic in a terminal for interactive login/setup:

```bash
atomic-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/atomic-rpc/*` – Atomic subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). Atomic reads/writes and executes locally.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to Atomic in this adapter. If you use [Atomic MCP adapter](https://github.com/bastani-inc/atomic) it will be available in the ACP client.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Concurrent ACP prompts are queued client-side and delivered one-at-a-time after Atomic finishes the active prompt.
- ~~ACP clients don't yet suport session history, but ACP sessions from `atomic-acp` can be `/resume`d in Atomic directly~~

## License

MIT (see [LICENSE](LICENSE)).
