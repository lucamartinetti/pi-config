/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/, plus the shared .agents/agents/ workspace) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations, plus any installed pi package that declares them (see package-resources.ts).
 */
import type { AgentConfig } from "./types.js";
/** Answers whether a `!` entry in some package manifest excludes this path. */
type Excluder = (path: string) => boolean;
/**
 * Overrides for the package tier. The gate and project-trust state normally come
 * from the session values in package-resources.ts, so these exist for tests and
 * for a caller that has to pin a scan it already performed.
 */
export interface LoadCustomAgentsOptions {
    /** Explicit package directories, bypassing discovery. */
    packageDirs?: string[];
    /** Explicit package files, bypassing discovery. */
    packageFiles?: string[];
    /** Explicit `!` exclusion predicate, bypassing discovery. */
    packageExcluded?: Excluder;
}
/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project:   <cwd>/.pi/agents/*.md (authoritative — also where /agents writes)
 *   2. Workspace: <cwd>/.agents/agents/*.md (shared cross-tool .agents workspace, read-only)
 *   3. Global:    $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *   4. Package:   paths declared by an installed pi package (read-only)
 *
 * Project-level agents override global ones with the same name. On a name clash
 * between the two project locations, .pi/agents wins — .pi stays the project
 * authority; .agents/agents is an additional read location.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 *
 * Package agents load *first*, so everything the user or project wrote outranks
 * them. That is what makes them safe to adopt: a package can offer a `reviewer`,
 * and a `.pi/agents/reviewer.md` silently takes it back. It mirrors pi's own
 * resource precedence, where package-provided skills rank below every user and
 * project one, and Claude Code's, where a plugin agent is the lowest tier.
 *
 * An agent's type comes from its frontmatter `name:`, falling back to the
 * filename — Claude Code's rule, where "the filename doesn't have to match".
 * Because the type is now declared rather than derived from a unique path, two
 * files can claim the same one; the later load wins, as it always has for a
 * filename clash, and `warnSkippedOverride` reports the substitution.
 */
export declare function loadCustomAgents(cwd: string, strict?: boolean, opts?: LoadCustomAgentsOptions): Map<string, AgentConfig>;
/**
 * Read and parse one agent file, or warn and return undefined for the caller to
 * skip. One bad file must not take the whole extension down with it — an
 * unparseable `.md` used to abort activation, so pi exited before the TUI.
 *
 * The path is as much of the fix as the recovery: a bare YAML error ("line 2,
 * column 14") is unactionable when agents come from three directories at once,
 * and the only other symptom is `Unknown agent type`, which reads like a typo.
 *
 * Under `strict` the same failure rethrows, still naming the path, so callers
 * that opted into failing closed stop rather than run a substituted agent.
 */
/**
 * Parse an agent file's frontmatter, tolerating a leading UTF-8 BOM.
 *
 * Editors across the Windows/CJK world write UTF-8 with a BOM by default, and
 * pi's parser did not look past one before 0.84.3: the fence never matched, so
 * the frontmatter came back empty and the *whole file* — YAML and all — became
 * the body. An agent authored that way silently lost every field. `tools: none`
 * going missing is the sharp edge: the agent registers with the default
 * toolset rather than none, which is a wider grant than its author wrote.
 *
 * Stripped here rather than detected per pi version, because this is the only
 * place agent files are read and the BOM is a file-encoding artifact, not
 * content — normalising it at the boundary keeps one behaviour across the whole
 * supported peer range instead of forking on what happens to be installed.
 */
export declare function parseAgentFrontmatter<T extends Record<string, unknown>>(content: string): {
    frontmatter: T;
    body: string;
};
export {};
