import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAtomicPath } from "./atomic-settings.js";

/**
 * Storage owned by the ACP adapter: `ATOMIC_ACP_DIR` when it is set, else ~/.atomic/atomic-acp.
 *
 * We intentionally keep this separate from Atomic's own ~/.atomic/agent/* directory. A host that
 * runs Atomic on a private agent directory, with the person's ~/.atomic read-only, points this
 * at a directory of its own too.
 */
export function getAtomicAcpDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.ATOMIC_ACP_DIR?.trim();
	return override ? resolveAtomicPath(override) : join(homedir(), ".atomic", "atomic-acp");
}

export function getAtomicAcpSessionMapPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAtomicAcpDir(env), "session-map.json");
}
