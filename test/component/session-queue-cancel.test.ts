import assert from "node:assert/strict";
import test from "node:test";
import { AtomicAcpSession } from "../../src/acp/session.js";
import type { AtomicRpcProcess, AtomicSessionStats } from "../../src/atomic-rpc/process.js";
import { asAgentConn, FakeAgentSideConnection, FakeAtomicRpcProcess } from "../helpers/fakes.js";

test("AtomicAcpSession: cancel clears queued prompts", async () => {
	const conn = new FakeAgentSideConnection();
	const proc = new FakeAtomicRpcProcess();

	const session = new AtomicAcpSession({
		sessionId: "s1",
		cwd: process.cwd(),
		mcpServers: [],
		proc: proc as any,
		conn: asAgentConn(conn),
		fileCommands: [],
	});

	const first = session.prompt("one");
	const second = session.prompt("two");
	const third = session.prompt("three");

	// first started, second+third queued
	assert.equal(proc.prompts.length, 1);

	await session.cancel();

	assert.equal(proc.abortCount, 1);

	// queued prompts should resolve as cancelled
	assert.equal(await second, "cancelled");
	assert.equal(await third, "cancelled");

	// Finish first prompt as cancelled after settlement.
	proc.emit({ type: "agent_start" });
	proc.emit({ type: "turn_end" });
	proc.emit({ type: "agent_end" });
	proc.emit({ type: "agent_settled" });
	assert.equal(await first, "cancelled");

	// queue should have been cleared, so no further prompt started
	assert.equal(proc.prompts.length, 1);
});

test("AtomicAcpSession: Atomic exit fails active and queued prompts", async () => {
	const conn = new FakeAgentSideConnection();
	const proc = new FakeAtomicRpcProcess();

	const session = new AtomicAcpSession({
		sessionId: "s1",
		cwd: process.cwd(),
		mcpServers: [],
		proc: proc as any,
		conn: asAgentConn(conn),
		fileCommands: [],
	});

	const first = session.prompt("one");
	const second = session.prompt("two");

	assert.equal(proc.prompts.length, 1);
	proc.exit(new Error("crash after prompt accepted"));

	await assert.rejects(first, /Atomic exited/);
	await assert.rejects(second, /Atomic exited/);
	assert.equal(proc.prompts.length, 1);
});

test("AtomicAcpSession: cancellation during settlement waits for usage and returns cancelled", async () => {
	const conn = new FakeAgentSideConnection();
	let releaseStats!: (stats: AtomicSessionStats) => void;
	let statsStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		statsStarted = resolve;
	});
	const stats = new Promise<AtomicSessionStats>((resolve) => {
		releaseStats = resolve;
	});
	const proc = Object.assign(new FakeAtomicRpcProcess(), {
		getSessionStats: async () => {
			statsStarted();
			return stats;
		},
	});
	const session = new AtomicAcpSession({
		sessionId: "s1",
		cwd: process.cwd(),
		mcpServers: [],
		proc: proc as unknown as AtomicRpcProcess,
		conn: asAgentConn(conn),
		fileCommands: [],
	});
	let finished = false;
	const prompt = session.prompt("one").then((reason) => {
		finished = true;
		return reason;
	});
	const queued = session.prompt("two");
	proc.emit({ type: "agent_settled" });
	await started;
	await session.cancel();
	assert.equal(await queued, "cancelled");
	assert.equal(finished, false);
	releaseStats({ contextUsage: { tokens: 12, contextWindow: 100 } });
	assert.equal(await prompt, "cancelled");
	assert.equal(proc.prompts.length, 1);
	assert.ok(conn.updates.some(({ update }) => update.sessionUpdate === "usage_update" && update.used === 12));
});

function setup() {
	const conn = new FakeAgentSideConnection();
	const proc = new FakeAtomicRpcProcess();
	const session = new AtomicAcpSession({
		sessionId: "s1",
		cwd: process.cwd(),
		mcpServers: [],
		proc: proc as unknown as AtomicRpcProcess,
		conn: asAgentConn(conn),
	});
	return { conn, proc, session };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("cancelling a prompt queued behind a background run takes it back from Atomic and ends it", async () => {
	const { proc, session } = setup();
	// A subagent's completion notice started a run; the prompt waits in Atomic's queue behind it.
	proc.emit({ type: "agent_start" });
	proc.promptDisposition = "queued";
	const turn = session.prompt("Next step");
	await tick();
	// abort answers once Atomic is idle: the background run's last events come first.
	proc.onAbort = () => {
		proc.emit({ type: "agent_end" });
		proc.emit({ type: "agent_settled", aborted: true });
	};
	await session.cancel();
	assert.deepEqual(proc.calls, ["clear_queue", "abort"]);
	assert.equal(await turn, "cancelled");
});

test("cancelling a prompt that joined a background run ends it at that run's settlement", async () => {
	const { proc, session } = setup();
	proc.emit({ type: "agent_start" });
	proc.promptDisposition = "queued";
	const turn = session.prompt("Next step");
	await tick();
	proc.emit({ type: "message_start", message: { role: "user", content: "Next step" } });
	proc.onAbort = () => {
		proc.emit({ type: "agent_end" });
		proc.emit({ type: "agent_settled", aborted: true });
	};
	await session.cancel();
	assert.equal(await turn, "cancelled");
});

test("a cancel whose prompt ended while Atomic accepted it leaves the next prompt alone", async () => {
	const { proc, session } = setup();
	let accept!: () => void;
	proc.promptPromise = new Promise<void>((resolve) => {
		accept = resolve;
	});
	const first = session.prompt("one");
	const cancelled = session.cancel();
	const second = session.prompt("two");
	// The first prompt's run ends before its request is answered; the second one starts.
	proc.emit({ type: "agent_start" });
	proc.emit({ type: "agent_end" });
	proc.emit({ type: "agent_settled", aborted: true });
	assert.equal(await first, "cancelled");
	await tick();
	assert.equal(proc.prompts.length, 2);
	accept();
	await cancelled;
	assert.deepEqual(proc.calls, [], "the stale cancel must not clear or abort the second prompt");
	proc.emit({ type: "agent_start" });
	proc.emit({ type: "agent_end" });
	proc.emit({ type: "agent_settled" });
	assert.equal(await second, "end_turn");
});

test("Atomic exiting during a cancel ends the cancelled prompt and fails the one sent after it", async () => {
	const { proc, session } = setup();
	const first = session.prompt("one");
	const cancelled = session.cancel();
	const second = session.prompt("two");
	proc.onAbort = () => proc.exit(new Error("crash during abort"));
	await cancelled;
	assert.equal(await first, "cancelled");
	await assert.rejects(second, /Atomic exited/);
});

test("closing a session ends its prompts as cancelled and sends nothing more for it", async () => {
	const { conn, proc, session } = setup();
	const first = session.prompt("one");
	const second = session.prompt("two");
	proc.emit({ type: "agent_start" });
	await tick();
	session.close();
	assert.equal(await first, "cancelled");
	assert.equal(await second, "cancelled");
	const sent = conn.updates.length;
	proc.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late" } });
	proc.emit({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {} });
	proc.exit(new Error("killed"));
	await tick();
	assert.equal(conn.updates.length, sent);
	assert.equal(proc.prompts.length, 1);
});
