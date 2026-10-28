/**
 * package-resources.ts — Discover agent and workflow files that installed pi
 * packages declare in their `package.json`.
 *
 * ## Why this exists
 *
 * Pi already ships four resource types inside packages — `extensions`, `skills`,
 * `prompts`, `themes` — resolved from a `pi` manifest key or, when there is no
 * `pi` key at all, from convention directories. Subagents are *our* concept, so
 * pi knows nothing about them and a package author's only option was to copy
 * `.md` files into `.pi/agents/` on every container start (#109).
 *
 * ## The contract
 *
 * Two-sided, deliberately:
 *
 *   1. The package author opts in by naming the paths in `package.json`.
 *   2. The user opts in by running `pi install`, which is already the trust
 *      decision for that package — pi executes its `extensions/` and injects its
 *      `skills/` into the system prompt with no further prompt. A declared `.md`
 *      agent is strictly less privileged than either, so it rides the boundary
 *      the user already crossed rather than inventing a second one.
 *
 * There is deliberately **no convention-directory fallback**. Pi scans `skills/`
 * only when a package has no `pi` key whatsoever; we never scan an undeclared
 * `agents/`. A package that happens to carry an `agents/` folder for some other
 * tool must not start contributing subagents to pi because it was installed for
 * an unrelated reason.
 *
 * ## Which packages are visible
 *
 * Only what pi itself has configured — `settings.json -> packages[]`, global and
 * project — read through pi's own `DefaultPackageManager.listConfiguredPackages()`.
 * That call is synchronous, pure, and never installs anything; it also resolves
 * npm / git / local install roots, pnpm global roots and legacy fallbacks, which
 * is why it is worth borrowing rather than reimplementing.
 *
 * `node_modules` is never scanned. Being a transitive dependency of the user's
 * project means nothing here — the same rule pi applies to itself.
 *
 * ## Accepted manifest spellings
 *
 * All four mean the same thing. The `pi-subagents` top-level key exists for
 * cross-compatibility with `nicobailon/pi-subagents`, which reads the same two
 * shapes, so a package author writes one manifest that works on either extension.
 *
 *   "pi":            { "subagents": { "agents": ["./agents"], "workflows": ["./flows"] } }
 *   "pi":            { "subagents": ["./agents"] }            // shorthand for { agents }
 *   "pi-subagents":  { "agents": ["./agents"] }
 *   "pi-subagents":  ["./agents"]                             // shorthand for { agents }
 *
 * Adding `pi.subagents` is safe for pi itself: its `readPiManifest` reads only
 * `extensions`/`skills`/`prompts`/`themes` and ignores every other key.
 */
/** Resource kinds a package may declare. Agents are `.md`, workflows are `.js`. */
export type PackageResourceKind = "agents" | "workflows";
/**
 * Per-file size ceiling for package-provided resources, matching Claude Code's
 * plugin-agent limit. These files come from third-party packages and are read
 * eagerly on every agent load; a pathological one should be skipped, not
 * `readFileSync`'d into the session.
 */
export declare const MAX_PACKAGE_RESOURCE_BYTES = 1048576;
/** One installed pi package that declared something we understand. */
export interface PiPackage {
    /** The settings source string, e.g. `npm:@foo/bar@1.0.0` or an absolute path. */
    source: string;
    /** `package.json` `name`, when the manifest could be read. */
    name?: string;
    /** Unscoped, lowercased short name (`@scope/foo` becomes `foo`) for allowlist matching. */
    shortName?: string;
    /** Which settings scope configured it. */
    scope: "user" | "project";
    /** Absolute path of the installed package root. */
    root: string;
    /**
     * What its manifest declared. Carried here rather than re-read downstream:
     * `listPiPackages` has to parse the manifest anyway to know whether the
     * package declares anything at all, and reading it twice would leave two
     * places that could disagree about what a package said.
     */
    declared: DeclaredEntries;
}
/**
 * The gate for one resource kind, as persisted in our settings:
 * `true` (default) = every declaring package, `false` = none, `string[]` =
 * only packages whose short name, full name, or source matches an entry.
 */
export type PackageGate = boolean | string[] | undefined;
export interface PackageDiscoveryOptions {
    /**
     * Pi's project-trust state for `cwd`, from `ctx.isProjectTrusted()`. When
     * false, `.pi/settings.json` is not read — so a package configured only by an
     * untrusted project is invisible to us, exactly as it is to pi. Omitted falls
     * back to the session state set by {@link setProjectTrusted}.
     */
    projectTrusted?: boolean;
    /** Gate override. Omitted falls back to the session state for the kind. */
    gate?: PackageGate;
}
/** Apply the `packageAgents` setting. Drops the cache, since roots may change. */
export declare function setPackageAgentsGate(gate: PackageGate): void;
/** Apply the `packageWorkflows` setting. Drops the cache, since roots may change. */
export declare function setPackageWorkflowsGate(gate: PackageGate): void;
export declare function getPackageAgentsGate(): PackageGate;
export declare function getPackageWorkflowsGate(): PackageGate;
/**
 * Seed the trust state from pi's *saved* decision, before any session exists.
 *
 * The correction on `session_start` is too late for one thing that matters: the
 * `Agent` tool's description — the list of agent types the model is told about —
 * is built once at activation, so an agent registered after it never reaches the
 * model even though dispatch would accept it. That is exactly the shape a team
 * ships agents in: a package named in a committed `.pi/settings.json`, which is
 * invisible until the project is trusted.
 *
 * Pi keeps that decision in `<agentDir>/trust.json`, keyed by canonical path
 * with the nearest ancestor winning, so on the second and every later session in
 * a trusted repo the answer is already on disk. No saved decision falls back to
 * the global `defaultProjectTrust`, which is what pi does; `"ask"` resolves to
 * untrusted here, because the prompt has not been answered yet and guessing yes
 * would be the wrong direction to guess.
 *
 * Best-effort by design: any failure leaves the state untrusted, and
 * `session_start` still delivers pi's real answer either way.
 */
export declare function seedProjectTrust(cwd: string): void;
/**
 * Record pi's project-trust answer. Drops the cache when the answer changes,
 * since a project's `packages[]` becomes visible or invisible with it. A repeat
 * of the same answer is a no-op — `session_start` fires on every new, resumed
 * and forked session, and it has its own reason to invalidate.
 */
export declare function setProjectTrusted(trusted: boolean): void;
/** Reset every session-scoped value. Tests only — the extension never un-loads. */
export declare function resetPackageState(): void;
/** What a package declared, after normalising the accepted spellings. */
export interface DeclaredEntries {
    agents?: string[];
    workflows?: string[];
}
/** Absolute paths a declaration resolved to, split by what the loader needs. */
export interface ResolvedResourcePaths {
    dirs: string[];
    files: string[];
    /**
     * Canonical paths of `!` entries. Kept separate from `dirs`/`files` rather
     * than subtracted from them because an exclusion usually names a file *inside*
     * an included directory, which is not enumerated until load time.
     */
    excluded: ReadonlySet<string>;
}
/**
 * Read the subagent declaration out of a parsed `package.json`.
 *
 * `pi.subagents` wins over the top-level `pi-subagents` when a package carries
 * both — the pi-namespaced key is the primary spelling here, and a package that
 * writes both almost certainly means them to be identical anyway.
 */
export declare function readSubagentManifest(pkg: unknown): DeclaredEntries | undefined;
/** `@scope/foo` becomes `foo`, lowercased. The name a user types in an allowlist. */
export declare function unscopedShortName(name: string): string;
/**
 * Resolve one kind's declared entries into concrete absolute paths inside the
 * package: directories to scan, and individual files.
 *
 * Split into `{ dirs, files }` rather than a flat list because the agent loader
 * takes directories (it does its own `readdirSync` and frontmatter handling),
 * while a manifest entry naming a single file has to be surfaced on its own.
 *
 * `!entry` marks an exclusion. Exact paths only — pi's own `!` is gitignore-style
 * glob negation, and globs are not supported here for the reason above.
 */
export declare function resolveDeclaredPaths(root: string, entries: string[] | undefined, kind: PackageResourceKind): ResolvedResourcePaths;
/**
 * Every installed pi package that declares subagent resources, in pi's own
 * order (global entries first, then project). Duplicates by root are collapsed —
 * a package listed in both scopes is one package on disk.
 */
export declare function listPiPackages(cwd: string, projectTrusted?: boolean): PiPackage[];
/**
 * Whether `pkg` passes the gate. `true`/omitted admits everything; an array
 * matches case-insensitively against the unscoped short name, the full package
 * name, or the settings source string — users reach for whichever of the three
 * they happen to have in front of them.
 */
export declare function packageAllowed(pkg: PiPackage, gate: PackageGate): boolean;
/** Drop the memoized package scan. Called on `/reload` and after settings changes. */
export declare function invalidatePackageCache(): void;
/**
 * Name of the installed package that provided `path`, or undefined when no
 * admitted package owns it. What `/agents` shows so a package agent can name its
 * origin, and what a user needs in order to write a `packageAgents` allowlist.
 *
 * `kind` selects which gate to consult, because the two are configured
 * separately: a package may be admitted for agents but not for workflows.
 *
 * A plain prefix test is enough. `resolveDeclaredPaths` builds every declared
 * path as `resolve(root, entry)` without canonicalizing it — only the
 * containment check and the exclusion set go through `realOrSelf` — so a
 * `sourcePath` the loader derived from one is textually inside the root it came
 * from. The `sep` anchor keeps `…/node_modules/foo` from claiming
 * `…/node_modules/foo-bar`.
 */
export declare function packageNameForPath(path: string, cwd: string, kind?: PackageResourceKind, opts?: PackageDiscoveryOptions): string | undefined;
/**
 * Directories of package-declared agent files, lowest-precedence first.
 * Fed to `loadCustomAgents` ahead of the global and project roots.
 */
export declare function packageAgentDirs(cwd: string, opts?: PackageDiscoveryOptions): string[];
/** Individually declared agent `.md` files (a manifest entry naming a file, not a directory). */
export declare function packageAgentFiles(cwd: string, opts?: PackageDiscoveryOptions): string[];
/**
 * Whether a `!` entry in some package manifest excludes this path.
 *
 * Checked at load time rather than subtracted during resolution, because the
 * common exclusion — `["./agents", "!./agents/wip.md"]` — names a file inside a
 * directory that is not enumerated until the loader reads it.
 */
export declare function isPackageResourceExcluded(path: string, cwd: string, kind: PackageResourceKind, opts?: PackageDiscoveryOptions): boolean;
/**
 * Directories of package-declared workflow scripts, appended to
 * `savedWorkflowRoots` so a name resolves there last.
 */
export declare function packageWorkflowDirs(cwd: string, opts?: PackageDiscoveryOptions): string[];
/**
 * Individually declared workflow scripts, as `name -> absolute path`.
 *
 * A name lookup wants a directory, and a declared *file* has none — but standing
 * its parent directory in as a root would make every sibling `.js` resolvable,
 * so `workflows: ["./one.js"]` would quietly offer the package's other scripts
 * too, and `["./index.js"]` would offer everything at the package root. That is
 * the opposite of the rule the whole feature rests on, that a package only
 * contributes what it names. An exact map keeps the declaration honest, and
 * matches how a declared agent file is already handled.
 *
 * Later entries lose a name clash, so a package's own directory-sourced script
 * is not displaced by a file entry from a package resolved after it.
 */
export declare function packageWorkflowFiles(cwd: string, opts?: PackageDiscoveryOptions): Map<string, string>;
