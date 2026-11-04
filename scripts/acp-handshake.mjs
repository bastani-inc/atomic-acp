export function afterInitialize(stdout, sendNext) {
	let buffer = "";
	const onData = (chunk) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg?.id !== 1) continue;
			stdout.off("data", onData);
			if (msg.result) sendNext();
			else console.error("initialize failed:", JSON.stringify(msg.error));
			return;
		}
	};
	stdout.on("data", onData);
}
