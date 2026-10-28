/**
 * mention-clone.ts — start a mentioned agent through a clone of this
 * conversation, without putting anything in the chat.
 *
 * Claude Code routes `@agent-<type>` through the main model: the mention
 * becomes a `<system-reminder>` appended to the prompt and the model makes the
 * tool call (see `agentMentionReminder`). That buys the spawned agent a prompt
 * written with conversation context, and costs a visible turn — the model's
 * reasoning and its tool block land in the transcript, for a decision the user
 * already made when they typed the handle.
 *
 * So the turn happens somewhere else. The conversation is cloned into a
 * throwaway in-memory session — same messages, same system prompt, same model —
 * and that copy takes the turn off-screen. A literal clone: the session's own
 * entries, not `inherit_context`'s text rendering of them.
 *
 * Pi builds every request from the session manager, so that is where the
 * clone's history goes: the parent's root-to-leaf entries, handed to
 * `SessionManager.inMemory`. The clone projects them itself, compaction and
 * branch summaries included, so a long conversation clones as what the main
 * model is actually working from. A conversation with nothing in it yet clones
 * to nothing in it yet, which is the correct answer rather than a failure.
 *
 * Cloned from memory rather than from the session file, which cannot be relied
 * on: `SessionManager._persist` withholds every write until the first assistant
 * message lands, so a fork taken before then reads an empty file and throws.
 *
 * The system prompt cannot ride along in those entries. Pi rebuilds it from the
 * session's own options on every request and patches the difference over the
 * transcript, so the parent's prompt would be replaced by the clone's. It goes
 * in through the resource loader's prompt override instead.
 *
 * Three details make the spawn belong to the real session rather than the
 * clone:
 *
 *   - the clone is handed the *registered* `Agent` tool, whose handler closes
 *     over the main activation, so it spawns top-level: widget, fleet row,
 *     handle, completion notification, all as if the main model had called it;
 *   - that tool is re-bound to the main `ExtensionContext`, because the handler
 *     reads `cwd`, `model` and `sessionManager.getSessionId()` off it to place
 *     the transcript and the `rootSessionId`. The clone's own context would
 *     file both under the throwaway fork;
 *   - it is called with no tool-call id. The clone's turn produces one, but the
 *     real session never issued it, and a `<tool-use-id>` pointing at nothing
 *     is exactly the bug the mention-resume path had to fix;
 *   - and it is forced into the background. A foreground agent returns its
 *     answer as the tool result and is marked `resultConsumed` so no completion
 *     notification is sent — correct when the caller is the real conversation,
 *     silent loss when the caller is a fork about to be discarded. Background
 *     delivery is the only route from a mention back to the main model.
 *
 * The clone gets one tool and one job. It cannot read, write or run anything —
 * an invisible turn with the full toolset could do invisible work.
 */
import { type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentType } from "./types.js";
export interface MentionCloneOptions {
    /** The MAIN session's context — what the spawn is attributed to, and the
     * source of both the conversation and the live system prompt. */
    ctx: ExtensionContext;
    /** Agent type the handle resolved to. */
    type: SubagentType;
    /** What the user typed after the handle. */
    message: string;
    /** The registered `Agent` tool, reused so the spawn is an ordinary one. */
    agentTool: ToolDefinition;
}
export interface MentionCloneResult {
    /** True once the clone actually called `Agent`. */
    spawned: boolean;
    /** Why not, when it didn't. Absent on success. */
    error?: string;
}
/**
 * Fork the conversation, let the copy make the tool call, throw the copy away.
 * Never rejects: a clone that cannot run is reported so the caller can fall
 * back to starting the agent directly.
 */
export declare function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult>;
