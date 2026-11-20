import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AtomicAcpSession } from "../../src/acp/session.js";
import { AtomicRpcProcess } from "../../src/atomic-rpc/process.js";
import { readFakeAtomicReport, removeTempDir, writeFakeAtomicCli } from "../helpers/fake-atomic-cli.js";
import { asAgentConn, FakeAgentSideConnection } from "../helpers/fakes.js";

test("Atomic dying mid-turn fails the prompt and every open tool call of the turn", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-acp-exit-"));
	let proc: AtomicRpcProcess | undefined;
	try {
		const atomicCommand = writeFakeAtomicCli(root, {
			promptEvents: [
				{ type: "agent_start" },
				{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "subagent", args: { task: "sleep" } },
				{ type: "tool_execution_start", toolCallId: "tool-2", toolName: "read", args: { path: "a.txt" } },
			],
		});
		proc = await AtomicRpcProcess.spawn({ cwd: root, atomicCommand });
		const conn = new FakeAgentSideConnection();
		const session = new AtomicAcpSession({
			sessionId: "s",
			cwd: root,
			mcpServers: [],
			conn: asAgentConn(conn),
			proc,
		});
		const opened = new Set<string>();
		const allOpen = new Promise<void>((resolve) => {
			const poll = setInterval(() => {
				for (const { update } of conn.updates)
					if (update.sessionUpdate === "tool_call") opened.add(update.toolCallId);
				if (opened.has("tool-1") && opened.has("tool-2")) {
					clearInterval(poll);
					resolve();
				}
			}, 5);
		});

		const turn = session.prompt("sleep in a subagent");
		await allOpen;
		// On Windows the kill reaches node behind the atomic.cmd launcher; cmd.exe then exits with a code.
		process.kill(readFakeAtomicReport(root).pid, "SIGKILL");

		await assert.rejects(turn, (error: Error & { code?: number }) => {
			assert.equal(error.code, -32603);
			assert.match(error.message, /Atomic exited \((code=\d+, signal=null|code=null, signal=SIG[A-Z]+)\)/);
			return true;
		});
		for (const toolCallId of opened) {
			const last = conn.updates
				.map(({ update }) => update)
				.filter((update) => "toolCallId" in update && update.toolCallId === toolCallId)
				.at(-1);
			assert.equal(last && "status" in last ? last.status : undefined, "failed", `${toolCallId} must end as failed`);
			assert.match(JSON.stringify(last), /Atomic exited/);
		}
	} finally {
		await proc?.dispose("SIGKILL");
		await removeTempDir(root);
	}
});
