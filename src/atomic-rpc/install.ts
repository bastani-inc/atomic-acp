import { basename, dirname, join } from "node:path";

export type AtomicInstallKind = "npm" | "archive";

export const ATOMIC_INSTALL_HINT =
	"Install it with `curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh` (Windows: `install.ps1`) or `npm install -g @bastani/atomic`, or ensure `atomic` is on your PATH";

function isNpmInstall(realPath: string): boolean {
	return /[\\/]node_modules[\\/]@bastani[\\/]atomic[\\/]/.test(realPath);
}

export function atomicInstallKind(realPath: string): AtomicInstallKind {
	return isNpmInstall(realPath) ? "npm" : "archive";
}

/**
 * Where CHANGELOG.md may sit for the resolved executable: beside it in a release archive
 * (`<root>/versions/<v>/atomic`), under `<root>/current` for the Windows `<root>/bin/atomic.cmd`
 * launcher, and at the package root for an npm install (`.../@bastani/atomic/dist/cli.js`).
 */
export function atomicChangelogCandidates(realPath: string): string[] {
	const dir = dirname(realPath);
	const parent = dirname(dir);
	const candidates = [join(dir, "CHANGELOG.md")];
	if (basename(dir).toLowerCase() === "bin") candidates.push(join(parent, "current", "CHANGELOG.md"));
	candidates.push(join(parent, "CHANGELOG.md"));
	return candidates;
}

export function atomicUpdateCommand(kind: AtomicInstallKind, platform: NodeJS.Platform): string {
	if (kind === "npm") return "npm i -g @bastani/atomic";
	return platform === "win32"
		? "irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex"
		: "curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh";
}
