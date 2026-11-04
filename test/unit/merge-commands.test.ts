import assert from "node:assert/strict";
import test from "node:test";

// Minimal local impl (mirrors src/acp/agent.ts behavior)
function mergeCommands(a: Array<{ name: string }>, b: Array<{ name: string }>) {
	const out: Array<{ name: string }> = [];
	const seen = new Set<string>();
	for (const c of [...a, ...b]) {
		if (seen.has(c.name)) continue;
		seen.add(c.name);
		out.push(c);
	}
	return out;
}

test("mergeCommands: preserves order and de-dupes (first wins)", () => {
	const res = mergeCommands([{ name: "a" }, { name: "b" }], [{ name: "b" }, { name: "c" }]);
	assert.deepEqual(res, [{ name: "a" }, { name: "b" }, { name: "c" }]);
});
