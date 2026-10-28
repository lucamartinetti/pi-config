/**
 * completion-outbox.ts — When background completions reach the parent.
 *
 * Claude Code queues each completion and, after every tool batch, hands the
 * model everything that queued up in one go: a busy parent sees what finished
 * during the batch before its next model call, and nothing waits for a sibling.
 * pi's steering queue would split those into one model call each under its
 * default `one-at-a-time` mode, so the outbox holds them and sends ONE message
 * at the boundary instead.
 *
 * - Parent busy: held until `turn_end`, which pi emits after the tool batch and
 *   before it reads the steering queue.
 * - Parent idle: sent after a short hold, so near-simultaneous completions
 *   share a turn and `get_subagent_result` still gets a moment to consume one.
 * - Parent turn aborted (Esc) or failed: held through it — pi clears its own
 *   queues on Esc — and sent once the run has ended, starting a turn. Claude
 *   Code keeps an agent's completion queued through Esc the same way and runs
 *   it as soon as the interrupted turn stops.
 */
import type { NotificationDetails } from "./types.js";
/** How long an idle parent's notification is held before it is sent. */
export declare const NOTIFICATION_HOLD_MS = 200;
export interface OutboxMessage {
    content: string;
    details: NotificationDetails;
}
/**
 * A notification for one or more agents, built when they finished: a resume
 * before the send must not rewrite it. Reading an agent's result cancels its
 * id, and an item left with none is dropped; `build` gets the ids still pending.
 */
export interface OutboxItem {
    ids: string[];
    build(ids: readonly string[]): OutboxMessage;
}
export declare class CompletionOutbox {
    /** Delivers one message as a steer that triggers a turn when the parent is idle. */
    private send;
    /** Whether the parent has a run in flight, so a `turn_end` is coming. */
    private parentRunning;
    private items;
    private timer;
    constructor(
    /** Delivers one message as a steer that triggers a turn when the parent is idle. */
    send: (message: OutboxMessage) => void, 
    /** Whether the parent has a run in flight, so a `turn_end` is coming. */
    parentRunning: () => boolean);
    /** A newer completion of the same agent (a resume) replaces its pending one. */
    add(item: OutboxItem): void;
    /** The parent finished a turn: its tool batch is done, the next model call is not. */
    onTurnEnd(stopReason: string | undefined): void;
    /** The agent's result was read: it must not also be notified. */
    cancel(id: string): void;
    /**
     * Completions that landed after the run's last `turn_end` would otherwise wait for the next run.
     * Called at `agent_end` and again at `agent_settled`: one can land while the ending run is still open.
     */
    onAgentEnd(): void;
    dispose(): void;
    /** Not reset by later items: the first completion is never pushed back. */
    private arm;
    private flush;
}
