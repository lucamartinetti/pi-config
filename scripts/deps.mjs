#!/usr/bin/env node
// Vendored pi packages: pin, verify, patch, rebase.
//
// agent/vendor/package.json          exact upstream pins (Dependabot edits this)
// agent/vendor/package-lock.json     resolved tree + sha512 integrity
// agent/vendor/vendored.json         upstream version each committed tree is built from
// agent/vendor/patches/<pkg>/*.patch local changes, as a `git format-patch` series
// agent/vendor/<pkg>/                committed tree = upstream tarball + patches
// agent/vendor/node_modules/         installed dependencies (gitignored)
//
// Run `node scripts/deps.mjs help` for the commands.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = path.join(ROOT, "agent");
const VENDOR = path.join(AGENT, "vendor");
const PATCHES = path.join(VENDOR, "patches");
const RECORD = path.join(VENDOR, "vendored.json");
const SETTINGS = path.join(AGENT, "settings.json");
const META = "deps-meta.json"; // stored in a rebase repo's .git/

// The temp repos must not pick up the user's hooks, signing or templates.
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "deps",
	GIT_AUTHOR_EMAIL: "deps@localhost",
	GIT_COMMITTER_NAME: "deps",
	GIT_COMMITTER_EMAIL: "deps@localhost",
	GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

class DepsError extends Error {}
const fail = (msg) => {
	throw new DepsError(msg);
};

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
	if (r.error) fail(`${cmd}: ${r.error.message}`);
	if (r.status !== 0 && !opts.allowFail) {
		fail(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stderr || r.stdout}`);
	}
	return r;
}

const git = (cwd, args, opts = {}) => run("git", args, { cwd, env: GIT_ENV, ...opts });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
// Temp dirs are removed on exit, except a rebase repo left for conflict resolution.
const temps = new Set();
process.on("exit", () => {
	for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDir(tag) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-deps-${tag}-`));
	temps.add(dir);
	return dir;
}
const pkgDir = (name) => path.join(VENDOR, name);
const patchDir = (name) => path.join(PATCHES, name);
const settingsSource = (name) => `./vendor/${name}`;

// ---- pins -------------------------------------------------------------------

function pins() {
	const manifest = readJson(path.join(VENDOR, "package.json"));
	const lock = readJson(path.join(VENDOR, "package-lock.json"));
	const out = new Map();
	for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
		const entry = lock.packages?.[`node_modules/${name}`];
		if (!entry) fail(`${name} is in package.json but not in package-lock.json; run npm install in agent/vendor`);
		out.set(name, { name, spec, version: entry.version, integrity: entry.integrity, resolved: entry.resolved });
	}
	return out;
}

const readRecord = () => (fs.existsSync(RECORD) ? readJson(RECORD) : {});

function writeRecord(record) {
	const sorted = Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
	writeJson(RECORD, sorted);
}

function patchFiles(name) {
	const dir = patchDir(name);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".patch"))
		.sort()
		.map((f) => path.join(dir, f));
}

// ---- upstream tarballs ------------------------------------------------------

// Download name@version through npm's cache and check it against the lockfile's
// sha512 before anything is extracted.
function fetchUpstream(name, version, integrity) {
	const dest = tmpDir("pack");
	const r = run("npm", ["pack", `${name}@${version}`, "--pack-destination", dest, "--prefer-offline", "--silent", "--json"], {
		cwd: dest, // keep agent/vendor/.npmrc out of it
	});
	const parsed = JSON.parse(r.stdout); // npm <12: [info], npm 12: { [name]: info }
	const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	const tarball = path.join(dest, info.filename);
	const actual = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
	if (actual !== integrity) fail(`${name}@${version}: tarball integrity ${actual} does not match ${integrity}`);
	const out = path.join(dest, "x");
	fs.mkdirSync(out);
	run("tar", ["-xzf", tarball, "-C", out, "--no-same-owner", "--no-same-permissions"]);
	const top = fs.readdirSync(out);
	if (top.length !== 1) fail(`${name}@${version}: expected one top-level directory in the tarball, got ${top.join(", ")}`);
	return path.join(out, top[0]);
}

// ---- tree helpers -----------------------------------------------------------

// The committed tree never contains node_modules (a gitignored symlink) or .git.
const skip = (rel) => rel === "node_modules" || rel === ".git";

function listTree(dir, rel = "") {
	const files = [];
	for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		const r = rel ? `${rel}/${entry.name}` : entry.name;
		if (!rel && skip(entry.name)) continue;
		if (entry.isDirectory()) files.push(...listTree(dir, r));
		else files.push(r);
	}
	return files.sort();
}

function clearTree(dir) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir)) {
		if (skip(entry)) continue;
		fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
	}
}

function copyTree(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const rel of listTree(src)) {
		const to = path.join(dest, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(path.join(src, rel), to);
		fs.chmodSync(to, fs.statSync(path.join(src, rel)).mode & 0o777);
	}
}

function diffTrees(a, b) {
	const fa = listTree(a);
	const fb = listTree(b);
	const sb = new Set(fb);
	const sa = new Set(fa);
	const out = [];
	for (const f of fa) if (!sb.has(f)) out.push(`only in expected: ${f}`);
	for (const f of fb) if (!sa.has(f)) out.push(`only in committed: ${f}`);
	for (const f of fa) {
		if (!sb.has(f)) continue;
		if (!fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))) out.push(`differs: ${f}`);
	}
	return out;
}

// ---- patch repos ------------------------------------------------------------

function initRepo(upstreamDir, label) {
	const repo = tmpDir("repo");
	git(repo, ["init", "-q", "-b", "upstream"]);
	git(repo, ["config", "user.name", "deps"]);
	git(repo, ["config", "user.email", "deps@localhost"]);
	git(repo, ["config", "core.autocrlf", "false"]);
	copyTree(upstreamDir, repo);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-q", "--allow-empty", "-m", `upstream ${label}`]);
	git(repo, ["tag", "base"]);
	git(repo, ["checkout", "-q", "-b", "fork"]);
	return repo;
}

function applyPatches(repo, name, files) {
	if (files.length === 0) return;
	const r = git(repo, ["am", "-q", "--3way", "--keep-cr", ...files], { allowFail: true });
	if (r.status !== 0) {
		git(repo, ["am", "--abort"], { allowFail: true });
		fail(`patches for ${name} no longer apply to their recorded upstream base:\n${r.stderr || r.stdout}`);
	}
}

function exportPatches(repo, name, range) {
	const dir = patchDir(name);
	fs.rmSync(dir, { recursive: true, force: true });
	const count = Number(git(repo, ["rev-list", "--count", range]).stdout.trim());
	if (count === 0) return 0;
	fs.mkdirSync(dir, { recursive: true });
	git(repo, ["format-patch", "-q", "--zero-commit", "--no-signature", "--full-index", "-o", dir, range]);
	return count;
}

// Build upstream + patches for one package, returning the repo (HEAD = result).
function build(name, record) {
	const upstream = fetchUpstream(name, record.version, record.integrity);
	const repo = initRepo(upstream, `${name}@${record.version}`);
	applyPatches(repo, name, patchFiles(name));
	return repo;
}

// Replay the fork onto a new upstream. Returns { repo, conflict }.
function rebase(name, from, to) {
	const repo = build(name, from);
	const next = fetchUpstream(name, to.version, to.integrity);
	git(repo, ["checkout", "-q", "-b", "next", "base"]);
	clearTree(repo);
	copyTree(next, repo);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-q", "--allow-empty", "-m", `upstream ${name}@${to.version}`]);
	git(repo, ["checkout", "-q", "fork"]);
	fs.writeFileSync(path.join(repo, ".git", META), JSON.stringify({ name, to }));
	const r = git(repo, ["rebase", "-q", "--onto", "next", "base"], { allowFail: true });
	return { repo, conflict: r.status !== 0 ? r.stdout + r.stderr : null };
}

function install(name, repo, record, store) {
	const dest = pkgDir(name);
	clearTree(dest);
	copyTree(repo, dest);
	store[name] = { version: record.version, integrity: record.integrity };
	linkNodeModules(name);
}

// Packages resolve their nested dependencies exactly as npm laid them out:
// agent/vendor/<pkg>/node_modules -> agent/vendor/node_modules/<pkg>/node_modules,
// then Node's normal upward lookup reaches the hoisted agent/vendor/node_modules.
function linkNodeModules(name) {
	const link = path.join(pkgDir(name), "node_modules");
	const target = path.join(VENDOR, "node_modules", name, "node_modules");
	try {
		fs.rmSync(link, { recursive: true, force: true });
	} catch {}
	if (!fs.existsSync(target)) return;
	fs.symlinkSync(path.relative(path.dirname(link), target), link, "dir");
}

// ---- commands ---------------------------------------------------------------

function cmdInstall() {
	run("npm", ["ci"], { cwd: VENDOR, stdio: "inherit" });
	run("npm", ["audit", "signatures"], { cwd: VENDOR, stdio: "inherit" });
	for (const name of pins().keys()) if (fs.existsSync(pkgDir(name))) linkNodeModules(name);
	console.log("deps: installed; run `node scripts/deps.mjs check` to verify the vendored trees");
}

function cmdSync(args) {
	const force = args.includes("--force");
	const only = args.filter((a) => !a.startsWith("--"));
	const store = readRecord();
	const want = pins();
	let changed = 0;
	for (const [name, pin] of want) {
		if (only.length && !only.includes(name)) continue;
		const have = store[name];
		const same = have && have.version === pin.version && have.integrity === pin.integrity;
		if (same && !force && fs.existsSync(pkgDir(name))) continue;
		if (have && !same && patchFiles(name).length > 0) {
			const { repo, conflict } = rebase(name, have, pin);
			if (conflict) {
				temps.delete(repo);
				writeRecord(store);
				fail(
					`${name}: patches conflict when moving ${have.version} -> ${pin.version}.\n` +
						`Resolve them in ${repo}:\n` +
						`  cd ${repo} && git status   # fix, git add, then: git rebase --continue\n` +
						`then finish with:\n  node scripts/deps.mjs resume ${repo}\n\n${conflict}`,
				);
			}
			const n = exportPatches(repo, name, "next..fork");
			install(name, repo, pin, store);
			console.log(`deps: ${name} ${have.version} -> ${pin.version}, ${n} patch(es) rebased`);
		} else {
			install(name, build(name, pin), pin, store);
			console.log(`deps: ${name}@${pin.version} vendored`);
		}
		changed++;
	}
	for (const name of Object.keys(store)) {
		if (want.has(name)) continue;
		fs.rmSync(pkgDir(name), { recursive: true, force: true });
		fs.rmSync(patchDir(name), { recursive: true, force: true });
		delete store[name];
		console.log(`deps: ${name} removed`);
		changed++;
	}
	writeRecord(store);
	if (!changed) console.log("deps: vendored trees already match the lockfile");
}

function cmdResume([repo]) {
	if (!repo) fail("usage: deps resume <repo>");
	const meta = path.join(repo, ".git", META);
	if (!fs.existsSync(meta)) fail(`${repo} is not a deps rebase repo`);
	for (const d of ["rebase-merge", "rebase-apply"]) {
		if (fs.existsSync(path.join(repo, ".git", d))) fail(`rebase in ${repo} is still in progress; finish it with git rebase --continue`);
	}
	const { name, to } = readJson(meta);
	if (git(repo, ["status", "--porcelain"]).stdout.trim()) fail(`${repo} has uncommitted changes`);
	const store = readRecord();
	const n = exportPatches(repo, name, "next..fork");
	install(name, repo, to, store);
	writeRecord(store);
	console.log(`deps: ${name}@${to.version} vendored with ${n} patch(es)`);
}

// Record edits made directly in agent/vendor/<pkg>/ as a new patch.
function cmdPatch([name, ...words]) {
	const message = words.join(" ").trim();
	if (!name || !message) fail('usage: deps patch <pkg> "<commit message>"');
	const record = readRecord()[name];
	if (!record) fail(`${name} is not vendored`);
	const repo = build(name, record);
	clearTree(repo);
	copyTree(pkgDir(name), repo);
	git(repo, ["add", "-A"]);
	if (!git(repo, ["status", "--porcelain"]).stdout.trim()) fail(`${name}: no changes against upstream + existing patches`);
	const author = (key) => run("git", ["config", key], { cwd: ROOT, allowFail: true }).stdout.trim();
	const env = {
		...GIT_ENV,
		GIT_AUTHOR_NAME: author("user.name") || "deps",
		GIT_AUTHOR_EMAIL: author("user.email") || "deps@localhost",
		GIT_AUTHOR_DATE: new Date().toISOString(),
	};
	git(repo, ["commit", "-q", "-m", message], { env });
	const n = exportPatches(repo, name, "base..fork");
	console.log(`deps: ${name} now carries ${n} patch(es)`);
}

function cmdCheck() {
	const problems = [];
	const want = pins();
	const store = readRecord();
	const manifest = readJson(path.join(VENDOR, "package.json"));

	for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
		if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec)) problems.push(`${name}: pin "${spec}" is not an exact version`);
	}
	for (const [name, pin] of want) {
		if (pin.version !== pin.spec) problems.push(`${name}: lockfile has ${pin.version}, package.json pins ${pin.spec}`);
		if (!pin.resolved?.startsWith("https://registry.npmjs.org/")) problems.push(`${name}: resolved from ${pin.resolved}`);
		const have = store[name];
		if (!have) problems.push(`${name}: not vendored yet (run deps sync)`);
		else if (have.version !== pin.version || have.integrity !== pin.integrity) {
			problems.push(`${name}: vendored ${have.version} but pinned ${pin.version} (run deps sync)`);
		}
	}
	for (const name of Object.keys(store)) if (!want.has(name)) problems.push(`${name}: vendored but no longer pinned`);

	// Anything under agent/vendor that is neither tooling nor a vendored package.
	const known = new Set(["package.json", "package-lock.json", ".npmrc", "vendored.json", "patches", "node_modules"]);
	for (const entry of fs.readdirSync(VENDOR)) {
		if (known.has(entry)) continue;
		const names = entry.startsWith("@") ? fs.readdirSync(path.join(VENDOR, entry)).map((n) => `${entry}/${n}`) : [entry];
		for (const n of names) if (!store[n]) problems.push(`agent/vendor/${n}: not a vendored package`);
	}

	// settings.json must load every vendored package and nothing from a registry.
	const settings = readJson(SETTINGS);
	const sources = (settings.packages ?? []).map((p) => (typeof p === "string" ? p : p.source));
	for (const s of sources) {
		if (/^(npm:|git:|https?:|ssh:)/.test(s)) problems.push(`settings.json: "${s}" bypasses the vendored pins`);
	}
	for (const name of want.keys()) {
		if (!sources.includes(settingsSource(name))) problems.push(`settings.json: missing "${settingsSource(name)}"`);
	}

	// Rebuild every tree from its verified tarball + patches and compare.
	for (const [name, have] of Object.entries(store)) {
		if (!fs.existsSync(pkgDir(name))) {
			problems.push(`${name}: agent/vendor/${name} is missing`);
			continue;
		}
		const repo = build(name, have);
		for (const d of diffTrees(repo, pkgDir(name))) problems.push(`${name}: ${d}`);
	}

	if (problems.length) {
		fail(
			`deps check found ${problems.length} problem(s):\n  ${problems.join("\n  ")}\n\n` +
				"Edited a vendored file? Record it with: node scripts/deps.mjs patch <pkg> \"<message>\"",
		);
	}
	console.log(`deps: ${Object.keys(store).length} vendored package(s) match their pins and patches`);
}

function cmdStatus() {
	const store = readRecord();
	for (const [name, pin] of pins()) {
		const have = store[name]?.version ?? "-";
		const n = patchFiles(name).length;
		console.log(`${name.padEnd(40)} ${pin.version.padEnd(10)} vendored ${have.padEnd(10)} ${n ? `${n} patch(es)` : "pristine"}`);
	}
}

const HELP = `usage: node scripts/deps.mjs <command>

  install              npm ci + signature audit in agent/vendor, link node_modules
  sync [pkg] [--force] re-vendor packages whose pin changed, rebasing their patches
  resume <repo>        finish a sync after resolving patch conflicts in <repo>
  patch <pkg> "<msg>"  record edits made in agent/vendor/<pkg>/ as a new patch
  check                verify pins, settings.json and every vendored tree
  status               list pins, vendored versions and patch counts
`;

const [cmd, ...args] = process.argv.slice(2);
const commands = { install: cmdInstall, sync: cmdSync, resume: cmdResume, patch: cmdPatch, check: cmdCheck, status: cmdStatus };
try {
	if (!commands[cmd]) {
		process.stdout.write(HELP);
		process.exit(cmd && cmd !== "help" ? 2 : 0);
	}
	commands[cmd](args);
} catch (err) {
	if (!(err instanceof DepsError)) throw err;
	console.error(`deps: ${err.message}`);
	process.exit(1);
}
