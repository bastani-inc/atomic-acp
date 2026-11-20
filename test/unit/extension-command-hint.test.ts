import assert from "node:assert/strict";
import test from "node:test";
import { toAvailableCommandsFromAtomicGetCommands } from "../../src/acp/atomic-commands.js";

test("an extension command is advertised with its usage argument hint", () => {
	const { commands } = toAvailableCommandsFromAtomicGetCommands({
		commands: [
			{
				name: "review",
				source: "extension",
				hasArgumentCompletions: true,
				description: "Review a change. Usage: /review <path> [focus=…] | /review list",
			},
		],
	});
	assert.deepEqual(commands, [
		{
			name: "review",
			description: "Review a change. Usage: /review <path> [focus=…] | /review list",
			input: { hint: "<path> [focus=…] | /review list" },
		},
	]);
});
