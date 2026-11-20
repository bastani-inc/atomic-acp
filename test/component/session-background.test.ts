import assert from "node:assert/strict";
import test from "node:test";
import { AtomicAcpSession } from "../../src/acp/session.js";
import type { AtomicRpcProcess } from "../../src/atomic-rpc/process.js";
import { asAgentConn, FakeAgentSideConnection, FakeAtomicRpcProcess } from "../helpers/fakes.js";

function setup() {
	const conn = new FakeAgentSideConnection();
	const proc = new FakeAtomicRpcProcess();
	const session = new AtomicAcpSession({
		sessionId: "s",
		cwd: process.cwd(),
		mcpServers: [],
		conn: asAgentConn(conn),
		proc: proc as unknown as AtomicRpcProcess,
	});
	return { conn, proc, session };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("extension command output, status and widget stream without an active prompt", async () => {
	const { conn, proc } = setup();
	proc.emit({
		type: "message_end",
		message: {
			role: "custom",
			customType: "review:command-output",
			content: "Available reviews: smoke",
			display: true,
		},
	});
	proc.emit({ type: "extension_ui_request", method: "setStatus", statusKey: "review", statusText: "Running smoke" });
	proc.emit({
		type: "extension_ui_request",
		method: "setWidget",
		widgetKey: "review.run",
		widgetLines: ["smoke completed"],
	});
	await tick();
	proc.emit({
		type: "message_end",
		message: { role: "custom", display: false, content: "Internal reconciliation: do not show" },
	});
	await tick();
	assert.deepEqual(
		conn.updates.map((u) => (u.update.sessionUpdate === "agent_message_chunk" ? u.update.content : null)),
		[
			{ type: "text", text: "Available reviews: smoke" },
			{ type: "text", text: "Running smoke" },
			{ type: "text", text: "smoke completed" },
		],
	);
});

test("handled extension commands pass through and finish after output without agent_end", async () => {
	const { conn, proc, session } = setup();
	proc.promptDisposition = "handled";
	const result = session.prompt("/review list");
	proc.emit({ type: "message_end", message: { role: "custom", display: true, content: "Available reviews" } });
	assert.equal(await result, "end_turn");
	assert.equal(proc.prompts[0]?.message, "/review list");
	assert.ok(conn.updates.some((u) => u.update.sessionUpdate === "agent_message_chunk"));
	proc.emit({ type: "agent_start" });
	proc.emit({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Background review finished" },
	});
	proc.emit({ type: "agent_end" });
	await tick();
	assert.ok(
		conn.updates.some(
			(u) =>
				u.update.sessionUpdate === "agent_message_chunk" &&
				u.update.content.type === "text" &&
				u.update.content.text === "Background review finished",
		),
	);
});

test("a prompt submitted during background work waits for its own settlement", async () => {
	const { proc, session } = setup();
	proc.promptDisposition = "handled";
	assert.equal(await session.prompt("/review run"), "end_turn");
	proc.emit({ type: "agent_start" });
	proc.promptDisposition = "queued";
	let finished = false;
	const result = session.prompt("Explain the changes").then((reason) => {
		finished = true;
		return reason;
	});
	await tick();
	assert.equal(proc.prompts.length, 2);
	proc.emit({ type: "agent_end" });
	proc.emit({ type: "agent_settled" });
	await tick();
	assert.equal(finished, false);
	proc.emit({ type: "agent_start" });
	proc.emit({ type: "agent_end" });
	proc.emit({ type: "agent_settled" });
	assert.equal(await result, "end_turn");
});

test("completed out-of-turn background work does not prevent a later prompt from completing", async () => {
	const { conn, proc, session } = setup();
	proc.emit({ type: "agent_start" });
	proc.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Background output" } });
	proc.emit({ type: "agent_end" });
	proc.emit({ type: "agent_settled" });
	const result = session.prompt("Continue chatting");
	proc.emit({ type: "agent_start" });
	proc.emit({ type: "agent_end" });
	proc.emit({ type: "agent_settled" });
	assert.equal(await result, "end_turn");
	assert.ok(
		conn.updates.some(
			(u) =>
				u.update.sessionUpdate === "agent_message_chunk" &&
				u.update.content.type === "text" &&
				u.update.content.text === "Background output",
		),
	);
});

test("a follow-up starting before background settlement completes at the shared settlement", async () => {
	const { proc, session } = setup();
	proc.emit({ type: "agent_start" });
	proc.promptDisposition = "queued";
	const result = session.prompt("Follow up");
	await tick();
	proc.emit({ type: "agent_end" });
	proc.emit({ type: "agent_start" });
	proc.emit({ type: "agent_end" });
	proc.emit({ type: "agent_settled" });
	assert.equal(await result, "end_turn");
});
