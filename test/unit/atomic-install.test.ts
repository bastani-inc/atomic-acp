import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { atomicChangelogCandidates, atomicInstallKind, atomicUpdateCommand } from "../../src/atomic-rpc/install.js";

const archiveBinary = join("/home/me/.local/share/atomic/versions/0.10.16", "atomic");
const npmCli = join("/usr/lib/node_modules/@bastani/atomic/dist", "cli.js");
const windowsLauncher = join("C:/Users/me/AppData/Local/atomic/bin", "atomic.cmd");

test("atomicInstallKind: npm only for executables inside the @bastani/atomic package", () => {
	assert.equal(atomicInstallKind(npmCli), "npm");
	assert.equal(
		atomicInstallKind("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@bastani\\atomic\\dist\\cli.js"),
		"npm",
	);
	assert.equal(atomicInstallKind(archiveBinary), "archive");
	assert.equal(atomicInstallKind(windowsLauncher), "archive");
});

test("atomicChangelogCandidates: covers the archive, Windows launcher and npm layouts", () => {
	assert.equal(
		atomicChangelogCandidates(archiveBinary)[0],
		join("/home/me/.local/share/atomic/versions/0.10.16", "CHANGELOG.md"),
	);
	assert.ok(
		atomicChangelogCandidates(windowsLauncher).includes(
			join("C:/Users/me/AppData/Local/atomic", "current", "CHANGELOG.md"),
		),
	);
	assert.ok(atomicChangelogCandidates(npmCli).includes(join("/usr/lib/node_modules/@bastani/atomic", "CHANGELOG.md")));
});

test("atomicUpdateCommand: reruns the installer for archives and uses npm for npm installs", () => {
	assert.equal(atomicUpdateCommand("npm", "darwin"), "npm i -g @bastani/atomic");
	assert.match(atomicUpdateCommand("archive", "linux"), /install\.sh \| sh$/);
	assert.match(atomicUpdateCommand("archive", "win32"), /^irm .*install\.ps1 \| iex$/);
});
