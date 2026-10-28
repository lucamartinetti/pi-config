/**
 * schedule.ts — `SubagentScheduler`: timer-driven dispatcher of scheduled subagents.
 *
 * Mirrors the engine shape of pi-cron-schedule/src/scheduler.ts:
 *   - two-Map split (jobs = croner Cron, intervals = setInterval/setTimeout)
 *   - addJob/removeJob/updateJob/scheduleJob/unscheduleJob/executeJob
 *   - static parsers for cron / "+10m" / "5m" / ISO formats
 *
 * Differences vs pi-cron-schedule:
 *   - Persistence is via ScheduleStore (PID-locked, session-scoped, atomic).
 *   - `executeJob` calls `manager.spawn(..., { bypassQueue: true })` instead
 *     of dispatching a user message — schedule fires bypass maxConcurrent so
 *     a 5-minute interval can't be deferred behind 4 long-running agents.
 *   - Result delivery is implicit: spawn → background completion → existing
 *     `subagent-notification` path. No new delivery code.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { nanoid } from "nanoid";
import type { AgentManager } from "./agent-manager.js";
import { normalizeMaxTurns } from "./agent-runner.js";
import { resolveSpawnType } from "./agent-types.js";
import { resolveModel } from "./model-resolver.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { IsolationMode, ScheduledSubagent, SubagentType, ThinkingLevel } from "./types.js";

/** Event emitted on `pi.events` for cross-extension consumers. */
export type ScheduleChangeEvent =
  | { type: "added"; job: ScheduledSubagent }
  /**
   * A job left the store. `reason` distinguishes an explicit cancellation from
   * the scheduler's own auto-cancel policies: "manual", "self" (the run
   * emitted the completion marker), "cancel-on" (matched `cancelOn`),
   * "max-runs", or "one-shot" (a one-shot fire is removed once it settles).
   */
  | { type: "removed"; jobId: string; reason: string }
  | { type: "updated"; job: ScheduledSubagent }
  | { type: "fired"; jobId: string; agentId: string; name: string }
  | { type: "error"; jobId: string; error: string };

/**
 * Exact line a scheduled run can end with to cancel its own job. Injected into
 * every recurring fire's prompt (see `buildFireDirective`), so an agent that
 * sees the monitored condition resolved can stop the schedule without anyone
 * calling a tool. Chosen to be inert in ordinary prose so it cannot trip by
 * accident.
 */
export const SCHEDULE_SELF_CANCEL_MARKER = "[schedule-complete]";

/** Params accepted at job creation — ID, timestamps, and state are derived. */
export interface NewJobInput {
  name: string;
  description: string;
  schedule: string;
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;
  /** Auto-cancel after this many runs. */
  max_runs?: number;
  /** Auto-cancel when a run's result contains this substring. */
  cancel_on?: string;
}

export class SubagentScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private store: ScheduleStore | undefined;
  private pi: ExtensionAPI | undefined;
  private ctx: ExtensionContext | undefined;
  private manager: AgentManager | undefined;

  /** Start the scheduler: bind to a session's store and arm enabled jobs. */
  start(pi: ExtensionAPI, ctx: ExtensionContext, manager: AgentManager, store: ScheduleStore): void {
    this.pi = pi;
    this.ctx = ctx;
    this.manager = manager;
    this.store = store;

    for (const job of store.list()) {
      if (job.enabled) this.scheduleJob(job);
    }
  }

  /** Stop all timers; drop refs. Safe to call repeatedly. */
  stop(): void {
    for (const cron of this.jobs.values()) cron.stop();
    this.jobs.clear();
    for (const t of this.intervals.values()) clearTimeout(t);
    this.intervals.clear();
    this.store = undefined;
    this.pi = undefined;
    this.ctx = undefined;
    this.manager = undefined;
  }

  /** True if start() has bound a store and the scheduler is active. */
  isActive(): boolean {
    return this.store !== undefined;
  }

  list(): ScheduledSubagent[] {
    return this.store?.list() ?? [];
  }

  /**
   * Build a `ScheduledSubagent` from user input. Validates the schedule
   * format and tags `scheduleType`. Throws on invalid input.
   */
  buildJob(input: NewJobInput): ScheduledSubagent {
    const detected = SubagentScheduler.detectSchedule(input.schedule);
    return {
      id: nanoid(10),
      name: input.name,
      description: input.description,
      schedule: detected.normalized,
      scheduleType: detected.type,
      intervalMs: detected.intervalMs,
      subagent_type: input.subagent_type,
      prompt: input.prompt,
      model: input.model,
      thinking: input.thinking,
      max_turns: input.max_turns,
      isolated: input.isolated,
      isolation: input.isolation,
      maxRuns: input.max_runs,
      cancelOn: input.cancel_on,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
  }

  /** Add a job, persist, and arm if enabled. Returns the stored job. */
  addJob(input: NewJobInput): ScheduledSubagent {
    const store = this.requireStore();
    if (store.hasName(input.name)) {
      throw new Error(`A scheduled job named "${input.name}" already exists.`);
    }
    const job = this.buildJob(input);
    store.add(job);
    if (job.enabled) this.scheduleJob(job);
    this.emit({ type: "added", job });
    return job;
  }

  removeJob(id: string, reason = "manual"): boolean {
    const store = this.requireStore();
    if (!store.get(id)) return false;
    this.unscheduleJob(id);
    const ok = store.remove(id);
    if (ok) this.emit({ type: "removed", jobId: id, reason });
    return ok;
  }

  /**
   * Resolve a job by id, or by an unambiguous name. Returns undefined when the
   * ref matches nothing, or when several jobs share the name (a name is only
   * unique among *existing* jobs at creation time, so a rename could collide).
   * An `id` always wins over a same-string name.
   */
  resolveJob(ref: string): ScheduledSubagent | undefined {
    const store = this.store;
    if (!store) return undefined;
    const byId = store.get(ref);
    if (byId) return byId;
    const byName = store.list().filter(job => job.name === ref);
    return byName.length === 1 ? byName[0] : undefined;
  }

  /**
   * Cancel a job programmatically: resolve the ref, stop any in-flight run it
   * spawned, then remove it from the store. Returns a discriminated result so
   * tool and RPC callers can report an honest failure instead of silently
   * no-opping.
   */
  cancelJob(ref: string): { ok: true; job: ScheduledSubagent } | { ok: false; error: string } {
    const job = this.resolveJob(ref);
    if (!job) {
      const names = this.list().map(j => j.name);
      return {
        ok: false,
        error: names.length
          ? `No scheduled job matches "${ref}". Known jobs: ${names.join(", ")}.`
          : `No scheduled job matches "${ref}". There are no scheduled jobs in this session.`,
      };
    }
    if (job.activeAgentId) {
      const record = this.manager?.getRecord(job.activeAgentId);
      if (record?.status === "running" || record?.status === "queued") {
        this.manager?.abort(job.activeAgentId);
      }
    }
    this.removeJob(job.id, "manual");
    return { ok: true, job };
  }

  /** Pause (enabled=false) or resume (enabled=true) a job by id or name. */
  setJobEnabled(ref: string, enabled: boolean): { ok: true; job: ScheduledSubagent } | { ok: false; error: string } {
    const job = this.resolveJob(ref);
    if (!job) return { ok: false, error: `No scheduled job matches "${ref}".` };
    const updated = this.updateJob(job.id, { enabled });
    if (!updated) return { ok: false, error: `Scheduled job "${ref}" disappeared.` };
    return { ok: true, job: updated };
  }

  /** Toggle / mutate a job. Re-arms based on the new `enabled` state. */
  updateJob(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    const store = this.requireStore();
    const updated = store.update(id, patch);
    if (!updated) return undefined;
    this.unscheduleJob(id);
    if (updated.enabled) this.scheduleJob(updated);
    this.emit({ type: "updated", job: updated });
    return updated;
  }

  /** Next-run time as ISO, or undefined if not currently armed. */
  getNextRun(jobId: string): string | undefined {
    const cron = this.jobs.get(jobId);
    if (cron) return cron.nextRun()?.toISOString();
    const job = this.store?.get(jobId);
    if (!job?.enabled) return undefined;
    if (job.scheduleType === "once") return job.schedule;
    if (job.scheduleType === "interval" && job.intervalMs) {
      // Before the first fire there's no `lastRun`, so fall back to "now" —
      // accurate at create time (setInterval was just armed) and within
      // intervalMs of correct in any pre-first-fire view.
      const base = job.lastRun ? new Date(job.lastRun).getTime() : Date.now();
      return new Date(base + job.intervalMs).toISOString();
    }
    return undefined;
  }

  // ── Scheduling primitives ────────────────────────────────────────────

  private scheduleJob(job: ScheduledSubagent): void {
    const store = this.store;
    if (!store) return;
    try {
      if (job.scheduleType === "interval" && job.intervalMs) {
        const t = setInterval(() => this.executeJob(job.id), job.intervalMs);
        this.intervals.set(job.id, t);
      } else if (job.scheduleType === "once") {
        const target = new Date(job.schedule).getTime();
        const delay = target - Date.now();
        if (delay > 0) {
          // One-shots are removed by executeJob once the run settles (reason
          // "one-shot") — a fire that is disabled but stays in the store reads
          // as an active job in every list surface. Nothing to re-arm here.
          const t = setTimeout(() => this.executeJob(job.id), delay);
          this.intervals.set(job.id, t);
        } else {
          // Past timestamp — disable, mark error, never fire
          store.update(job.id, { enabled: false, lastStatus: "error" });
          this.emit({ type: "error", jobId: job.id, error: `Scheduled time ${job.schedule} is in the past` });
        }
      } else {
        const cron = new Cron(job.schedule, () => this.executeJob(job.id));
        this.jobs.set(job.id, cron);
      }
    } catch (err) {
      this.emit({ type: "error", jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }
    const t = this.intervals.get(id);
    if (t) {
      clearTimeout(t);
      clearInterval(t);
      this.intervals.delete(id);
    }
  }

  /**
   * Fire a job: persist running state, spawn (bypassing the concurrency
   * queue), persist completion. Fire-and-forget: the timer tick returns
   * immediately so other jobs keep firing.
   */
  private executeJob(id: string): void {
    const store = this.store;
    const pi = this.pi;
    const ctx = this.ctx;
    const manager = this.manager;
    if (!store || !pi || !ctx || !manager) return;
    const job = store.get(id);
    if (!job?.enabled) return;

    store.update(id, { lastStatus: "running" });

    // Resolve model at fire time — registry contents may have changed since the
    // job was created (auth added/removed). Fall back silently to spawn-default
    // if resolution fails; the spawn path handles undefined model gracefully.
    let resolvedModel: any | undefined;
    if (job.model) {
      const r = resolveModel(job.model, ctx.modelRegistry);
      if (typeof r !== "string") resolvedModel = r;
    }

    let agentId: string;
    try {
      // Re-resolve at fire time against the registry as it stands. This does not
      // reload from disk (the scheduler has no reason to rebuild process-global
      // state from a timer), so it catches changes that went through /agents or
      // an Agent call — not a file deleted directly from a shell. The catch below turns
      // this into lastStatus: "error" plus an error event, like any other
      // fire-time failure.
      const dispatch = resolveSpawnType(job.subagent_type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      agentId = manager.spawn(pi, ctx, dispatch.type, this.promptForFire(job), {
        description: job.description,
        isBackground: true,
        bypassQueue: true,
        model: resolvedModel,
        maxTurns: job.max_turns,
        isolated: job.isolated,
        thinkingLevel: job.thinking,
        isolation: job.isolation,
        // A scheduled run has no tool call to build this, so without it the
        // conversation viewer shows nothing about how the job was configured.
        // The model is left out on purpose: agent-manager fills in the effective
        // one when the session reports it, and naming the pre-session pick here
        // would only be right until then.
        invocation: {
          thinking: job.thinking,
          // Normalized like the Agent tool's own snapshot: `0` means unlimited,
          // and rendering it as "max turns: 0" would read as a limit of none.
          maxTurns: normalizeMaxTurns(job.max_turns),
          isolated: job.isolated,
          runInBackground: true,
          isolation: job.isolation,
        },
      });
      // Remember what this fire spawned so a programmatic cancel can abort an
      // in-flight run, not just stop future ticks.
      store.update(id, { activeAgentId: agentId });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", jobId: id, error });
      // A fire that never spawned still counts, so a one-shot is cleaned up
      // and `max_runs` still reaches its ceiling on repeated failures.
      this.finishRun(id, "error", "");
      return;
    }

    this.emit({ type: "fired", jobId: id, agentId, name: job.name });

    // AgentManager's promise resolves either way (its .catch returns ""), so we
    // can't infer success/failure from the promise — read record.status instead.
    // Terminal states: completed/steered = success; error/aborted/stopped = error.
    // awaitStartup first: with isolation: "worktree" the run promise only exists
    // once the repo copy is made, and a failed copy rejects here.
    manager.awaitStartup(agentId)
      .then(() => manager.getRecord(agentId)?.promise)
      .then(() => {
        const r = manager.getRecord(agentId);
        const failed = r?.status === "error" || r?.status === "aborted" || r?.status === "stopped";
        this.finishRun(id, failed ? "error" : "success", r?.result ?? "");
      })
      .catch(() => this.finishRun(id, "error", ""));
  }

  /**
   * The prompt a fire runs with: the author's prompt plus the self-cancel
   * contract. Recurring jobs learn their id and how to stop future runs; a
   * one-shot is left untouched (it is removed after the single run anyway).
   */
  private promptForFire(job: ScheduledSubagent): string {
    if (job.scheduleType === "once") return job.prompt;
    const lines = [
      "",
      "---",
      `[scheduler] This is run #${(job.runCount ?? 0) + 1} of scheduled job "${job.name}" (id: ${job.id}); it will fire again on its schedule unless cancelled.`,
      `If this run has achieved the schedule's purpose and no further runs are needed, end your final reply with the exact line ${SCHEDULE_SELF_CANCEL_MARKER} on its own line — the scheduler will then cancel the job automatically.`,
      "Otherwise omit that line.",
    ];
    if (job.cancelOn) lines.push(`The job also cancels itself when a run's output contains: ${job.cancelOn}`);
    if (job.maxRuns != null) {
      lines.push(`It auto-cancels after ${job.maxRuns} run${job.maxRuns === 1 ? "" : "s"}.`);
    }
    return `${job.prompt}\n${lines.join("\n")}`;
  }

  /**
   * Record a run's outcome, then apply the auto-cancel policies. Returns with
   * the store updated — or with the job removed entirely, in which case the
   * `runCount`/`lastStatus` write is skipped (removal is the terminal state).
   */
  private finishRun(jobId: string, status: "success" | "error", resultText: string): void {
    const store = this.store;
    if (!store) return;
    const current = store.get(jobId);
    if (!current) return; // cancelled while the run was in flight — nothing to record

    const runCount = (current.runCount ?? 0) + 1;
    const reason = this.autoCancelReason(current, runCount, status, resultText);
    if (reason) {
      this.removeJob(jobId, reason);
      return;
    }
    store.update(jobId, {
      lastRun: new Date().toISOString(),
      lastStatus: status,
      runCount,
      activeAgentId: undefined,
    });
    // Computed after the write above so an interval job's next run is counted
    // from this fire, not from the previous one.
    store.update(jobId, { nextRun: this.getNextRun(jobId) });
  }

  /** Which auto-cancel policy, if any, this run tripped. Most specific wins. */
  private autoCancelReason(
    job: ScheduledSubagent,
    runCount: number,
    status: "success" | "error",
    resultText: string,
  ): string | undefined {
    if (status === "success" && resultText.includes(SCHEDULE_SELF_CANCEL_MARKER)) return "self";
    if (job.cancelOn && resultText.includes(job.cancelOn)) return "cancel-on";
    if (job.maxRuns != null && runCount >= job.maxRuns) return "max-runs";
    if (job.scheduleType === "once") return "one-shot";
    return undefined;
  }

  private emit(event: ScheduleChangeEvent): void {
    if (this.pi) this.pi.events.emit("subagents:scheduled", event);
  }

  private requireStore(): ScheduleStore {
    if (!this.store) throw new Error("Scheduler not started — no active session.");
    return this.store;
  }

  // ── Format detection / parsers (statics — pure) ──────────────────────

  /**
   * Sniff a schedule string and tag its type. Throws on invalid input.
   * Order matters: relative ("+10m") and interval ("5m") both match digit+unit;
   * relative requires the leading "+" to disambiguate.
   */
  static detectSchedule(s: string): { type: "cron" | "once" | "interval"; intervalMs?: number; normalized: string } {
    const trimmed = s.trim();
    // "+10m" — relative one-shot
    const rel = SubagentScheduler.parseRelativeTime(trimmed);
    if (rel !== null) return { type: "once", normalized: rel };
    // "5m" — interval
    const ivl = SubagentScheduler.parseInterval(trimmed);
    if (ivl !== null) return { type: "interval", intervalMs: ivl, normalized: trimmed };
    // ISO timestamp — one-shot. Reject past timestamps upfront so we never
    // create a dead-on-arrival record (scheduleJob's safety net still catches
    // micro-races from `+0s`-style relatives).
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        if (d.getTime() <= Date.now()) {
          throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
        }
        return { type: "once", normalized: d.toISOString() };
      }
    }
    // Cron — 6-field
    const cronCheck = SubagentScheduler.validateCronExpression(trimmed);
    if (cronCheck.valid) return { type: "cron", normalized: trimmed };
    throw new Error(
      `Invalid schedule "${s}". Use 6-field cron (e.g. "0 0 9 * * 1" — 9am every Monday), interval ("5m"/"1h"), or one-shot ("+10m" / ISO).`
    );
  }

  /** 6-field cron — 'second minute hour dom month dow'. */
  static validateCronExpression(expr: string): { valid: boolean; error?: string } {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 0 9 * * 1" for 9am every Monday.`,
      };
    }
    try {
      // Croner validates by construction.
      new Cron(expr, () => {});
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : "Invalid cron expression" };
    }
  }

  /** "+10s"/"+5m"/"+1h"/"+2d" → ISO timestamp. */
  static parseRelativeTime(s: string): string | null {
    const m = s.match(/^\+(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const ms = parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
    return new Date(Date.now() + ms).toISOString();
  }

  /** "10s"/"5m"/"1h"/"2d" → milliseconds. */
  static parseInterval(s: string): number | null {
    const m = s.match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    return parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  }
}
