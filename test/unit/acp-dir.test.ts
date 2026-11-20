import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AtomicAcpAgent } from "../../src/acp/agent.js";
import { getAtomicAcpDir, getAtomicAcpSessionMapPath } from "../../src/acp/paths.js";
import { SessionStore } from "../../src/acp/session-store.js";
import { asAgentConn, FakeAgentSideConnection } from "../helpers/fakes.js";

// A read-only directory refuses writes only on POSIX, and never for root.
const posixUser = process.platform !== "win32" && process.getuid?.() !== 0;

/** Runs `body` with the given environment variables set (or removed, for undefined), then restores them. */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
	const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return body();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** A home directory nothing may write in, as a sandbox that hides the person's ~/.atomic makes it. */
function readOnlyHome(t: test.TestContext): string {
	const home = mkdtempSync(join(tmpdir(), "atomic-acp-home-"));
	chmodSync(home, 0o500);
	t.after(() => {
		chmodSync(home, 0o700);
		rmSync(home, { recursive: true, force: true });
	});
	return home;
}

test("without ATOMIC_ACP_DIR the session map stays in ~/.atomic/atomic-acp", () => {
	const old = join(homedir(), ".atomic", "atomic-acp");
	assert.equal(getAtomicAcpDir({}), old);
	assert.equal(getAtomicAcpDir({ ATOMIC_ACP_DIR: "  " }), old);
	assert.equal(getAtomicAcpSessionMapPath({}), join(old, "session-map.json"));
});

test("ATOMIC_ACP_DIR names the adapter's own directory, with ~ and relative paths resolved", () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-acp-dir-"));
	assert.equal(getAtomicAcpDir({ ATOMIC_ACP_DIR: dir }), dir);
	assert.equal(getAtomicAcpSessionMapPath({ ATOMIC_ACP_DIR: ` ${dir} ` }), join(dir, "session-map.json"));
	assert.equal(getAtomicAcpDir({ ATOMIC_ACP_DIR: "~/acp-state" }), join(homedir(), "acp-state"));
	assert.equal(getAtomicAcpDir({ ATOMIC_ACP_DIR: "acp-state" }), join(process.cwd(), "acp-state"));
	rmSync(dir, { recursive: true, force: true });
});

test("with a read-only home, sessions are saved under ATOMIC_ACP_DIR, made private on demand, and found again", {
	skip: !posixUser && "a read-only directory refuses writes only on POSIX, as a user other than root",
}, (t) => {
	const home = readOnlyHome(t);
	const root = mkdtempSync(join(tmpdir(), "atomic-acp-state-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "agent", "atomic-acp");

	withEnv({ HOME: home, USERPROFILE: home, ATOMIC_ACP_DIR: dir }, () => {
		new SessionStore().upsert({ sessionId: "s-1", cwd: "/work/project" });
		assert.deepEqual(
			{ sessionId: "s-1", cwd: "/work/project" },
			(({ sessionId, cwd }) => ({ sessionId, cwd }))(new SessionStore().get("s-1")!),
			"a reload reads the session from the same place",
		);
	});

	assert.equal(statSync(dir).mode & 0o777, 0o700);
	assert.equal(statSync(join(dir, "session-map.json")).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(home), [], "nothing is written in the home");
	assert.equal(existsSync(join(home, ".atomic")), false);
});

test("with a read-only home and no ATOMIC_ACP_DIR, saving a session fails as it always did", {
	skip: !posixUser && "a read-only directory refuses writes only on POSIX, as a user other than root",
}, (t) => {
	const home = readOnlyHome(t);
	withEnv({ HOME: home, USERPROFILE: home, ATOMIC_ACP_DIR: undefined }, () => {
		assert.throws(() => new SessionStore().upsert({ sessionId: "s-1", cwd: "/work" }), { code: "EACCES" });
	});
});

test("the agent keeps its sessions under ATOMIC_ACP_DIR", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-acp-agent-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const agent = withEnv(
		{ ATOMIC_ACP_DIR: dir },
		() => new AtomicAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any),
	);
	const store = (agent as any).store as SessionStore;
	store.upsert({ sessionId: "s-agent", cwd: "/work" });
	assert.ok(existsSync(join(dir, "session-map.json")));
	assert.equal(new SessionStore(join(dir, "session-map.json")).get("s-agent")?.cwd, "/work");
});
