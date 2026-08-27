import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import type {
  TerminalTraceThread,
  TraceEvent,
  TraceRun,
  TraceSession,
  TraceThread,
} from "./contracts";

type BeginRunInput = {
  prompt: string;
  model: string;
  reasoning: string;
  browser: boolean;
  desktopSessionId: string;
  continueSessionId?: string;
  submittedAt?: string;
};

export class TraceNotFoundError extends Error {}

function id(prefix: "req" | "run" | "ses" | "thr" | "turn" | "evt"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function titleFromPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 120) || "Untitled request";
}

function boolean(value: unknown): boolean {
  return Number(value) === 1;
}

function runFromRow(row: Record<string, unknown>): TraceRun {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    sessionId: String(row.session_id),
    threadId: String(row.thread_id),
    turnId: String(row.turn_id),
    status: String(row.status) as TraceRun["status"],
    prompt: String(row.prompt),
    model: String(row.model),
    reasoning: String(row.reasoning),
    browser: boolean(row.browser),
    submittedAt: String(row.submitted_at),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    response: row.response ? String(row.response) : undefined,
    error: row.error ? String(row.error) : undefined,
    codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : undefined,
    lastEventAt: row.last_event_at ? String(row.last_event_at) : undefined,
    lastEventSequence: row.last_event_sequence === null || row.last_event_sequence === undefined
      ? undefined
      : Number(row.last_event_sequence),
  };
}

function sessionFromRow(row: Record<string, unknown>): TraceSession {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function threadFromRow(row: Record<string, unknown>): TraceThread {
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    runCount: Number(row.run_count ?? 0),
    lastStatus: row.last_status ? String(row.last_status) as TraceRun["status"] : undefined,
  };
}

export class TraceStore {
  readonly path: string;
  readonly #db: Database;

  private constructor(path: string) {
    this.path = path;
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        desktop_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        thread_id TEXT NOT NULL REFERENCES threads(id),
        turn_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('accepted','running','completed','failed')),
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        browser INTEGER NOT NULL,
        submitted_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        response TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS runs_thread_submitted ON runs(thread_id, submitted_at DESC);
      CREATE INDEX IF NOT EXISTS runs_session_submitted ON runs(session_id, submitted_at DESC);
      CREATE INDEX IF NOT EXISTS runs_submitted ON runs(submitted_at DESC);
      CREATE INDEX IF NOT EXISTS events_run_sequence ON events(run_id, sequence);
    `);
  }

  static create(dataDir: string): TraceStore {
    const path = join(dataDir, "traces.sqlite");
    const store = new TraceStore(path);
    chmodSync(path, 0o600);
    return store;
  }

  close(): void {
    this.#db.close();
  }

  beginRun(input: BeginRunInput): TraceRun {
    const now = input.submittedAt ?? new Date().toISOString();
    let sessionId = input.continueSessionId;
    let threadId: string;
    if (sessionId) {
      const session = this.#db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | null;
      if (!session) throw new TraceNotFoundError(`Session ${sessionId} was not found`);
      threadId = String(session.thread_id);
      this.#db.query("UPDATE sessions SET desktop_session_id = ?, updated_at = ? WHERE id = ?").run(input.desktopSessionId, now, sessionId);
    } else {
      sessionId = id("ses");
      threadId = id("thr");
      this.#db.transaction(() => {
        this.#db.query("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(threadId, titleFromPrompt(input.prompt), now, now);
        this.#db.query("INSERT INTO sessions (id, thread_id, desktop_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(sessionId!, threadId, input.desktopSessionId, now, now);
      })();
    }

    const run: TraceRun = {
      id: id("run"),
      requestId: id("req"),
      sessionId,
      threadId,
      turnId: id("turn"),
      status: "accepted",
      prompt: input.prompt,
      model: input.model,
      reasoning: input.reasoning,
      browser: input.browser,
      submittedAt: now,
    };
    this.#db.transaction(() => {
      this.#db.query(`INSERT INTO runs
        (id, request_id, session_id, thread_id, turn_id, status, prompt, model, reasoning, browser, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(run.id, run.requestId, run.sessionId, run.threadId, run.turnId, run.status, run.prompt, run.model, run.reasoning, run.browser ? 1 : 0, run.submittedAt);
      this.#db.query("UPDATE threads SET updated_at = ? WHERE id = ?").run(now, threadId);
      this.appendEvent(run.id, "request.accepted", { prompt: run.prompt, model: run.model, reasoning: run.reasoning, browser: run.browser }, now);
    })();
    return run;
  }

  appendEvent(runId: string, type: string, data: unknown, createdAt = new Date().toISOString()): TraceEvent {
    const next = this.#db.query("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE run_id = ?").get(runId) as { sequence: number };
    const event: TraceEvent = { id: id("evt"), runId, sequence: Number(next.sequence), type, createdAt, data };
    this.#db.query("INSERT INTO events (id, run_id, sequence, type, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, event.runId, event.sequence, event.type, event.createdAt, JSON.stringify(event.data));
    return event;
  }

  markRunning(runId: string, startedAt = new Date().toISOString()): void {
    this.#db.query("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status IN ('accepted', 'running')").run(startedAt, runId);
  }

  markCompleted(runId: string, response: string, completedAt = new Date().toISOString()): void {
    if (!response.trim()) throw new Error("A completed run must contain a non-empty response");
    this.#db.transaction(() => {
      this.#db.query("UPDATE runs SET status = 'completed', response = ?, error = NULL, completed_at = ? WHERE id = ? AND status IN ('accepted', 'running')").run(response, completedAt, runId);
      this.touchRunParents(runId, completedAt);
    })();
  }

  markFailed(runId: string, error: string, completedAt = new Date().toISOString()): void {
    this.#db.transaction(() => {
      this.#db.query("UPDATE runs SET status = 'failed', error = ?, response = NULL, completed_at = ? WHERE id = ? AND status IN ('accepted', 'running')").run(error, completedAt, runId);
      this.touchRunParents(runId, completedAt);
    })();
  }

  private touchRunParents(runId: string, updatedAt: string): void {
    const run = this.#db.query("SELECT session_id, thread_id FROM runs WHERE id = ?").get(runId) as { session_id: string; thread_id: string } | null;
    if (!run) return;
    this.#db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(updatedAt, run.session_id);
    this.#db.query("UPDATE threads SET updated_at = ? WHERE id = ?").run(updatedAt, run.thread_id);
  }

  getRun(runId: string): TraceRun | undefined {
    const row = this.#db.query(`SELECT runs.*,
      (SELECT json_extract(data_json, '$.codexThreadId') FROM events WHERE events.run_id = runs.id AND json_extract(data_json, '$.codexThreadId') IS NOT NULL ORDER BY sequence DESC LIMIT 1) AS codex_thread_id,
      (SELECT created_at FROM events WHERE events.run_id = runs.id ORDER BY sequence DESC LIMIT 1) AS last_event_at,
      (SELECT sequence FROM events WHERE events.run_id = runs.id ORDER BY sequence DESC LIMIT 1) AS last_event_sequence
      FROM runs WHERE id = ?`).get(runId) as Record<string, unknown> | null;
    return row ? runFromRow(row) : undefined;
  }

  listRuns(options: { limit?: number; offset?: number; threadId?: string; sessionId?: string; status?: string } = {}): TraceRun[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 10_000);
    const offset = Math.max(options.offset ?? 0, 0);
    const filters: string[] = [];
    const values: Array<string | number> = [];
    if (options.threadId) { filters.push("thread_id = ?"); values.push(options.threadId); }
    if (options.sessionId) { filters.push("session_id = ?"); values.push(options.sessionId); }
    if (options.status) { filters.push("status = ?"); values.push(options.status); }
    values.push(limit, offset);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return (this.#db.query(`SELECT runs.*,
      (SELECT json_extract(data_json, '$.codexThreadId') FROM events WHERE events.run_id = runs.id AND json_extract(data_json, '$.codexThreadId') IS NOT NULL ORDER BY sequence DESC LIMIT 1) AS codex_thread_id,
      (SELECT created_at FROM events WHERE events.run_id = runs.id ORDER BY sequence DESC LIMIT 1) AS last_event_at,
      (SELECT sequence FROM events WHERE events.run_id = runs.id ORDER BY sequence DESC LIMIT 1) AS last_event_sequence
      FROM runs ${where} ORDER BY submitted_at DESC LIMIT ? OFFSET ?`).all(...values) as Array<Record<string, unknown>>).map(runFromRow);
  }

  getEvents(runId: string): TraceEvent[] {
    return (this.#db.query("SELECT * FROM events WHERE run_id = ? ORDER BY sequence").all(runId) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), runId: String(row.run_id), sequence: Number(row.sequence), type: String(row.type), createdAt: String(row.created_at), data: JSON.parse(String(row.data_json)),
    }));
  }

  getSession(sessionId: string): (TraceSession & { runs: TraceRun[] }) | undefined {
    const row = this.#db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Record<string, unknown> | null;
    return row ? { ...sessionFromRow(row), runs: this.listRuns({ sessionId, limit: 200 }) } : undefined;
  }

  desktopSessionId(sessionId: string): string | undefined {
    const row = this.#db.query("SELECT desktop_session_id FROM sessions WHERE id = ?").get(sessionId) as { desktop_session_id: string } | null;
    return row?.desktop_session_id;
  }

  listThreads(limit = 50, offset = 0): TraceThread[] {
    const safeLimit = Math.min(Math.max(limit, 1), 10_000);
    const safeOffset = Math.max(offset, 0);
    return (this.#db.query(`SELECT threads.*,
      COUNT(runs.id) AS run_count,
      (SELECT status FROM runs latest WHERE latest.thread_id = threads.id ORDER BY submitted_at DESC LIMIT 1) AS last_status
      FROM threads LEFT JOIN runs ON runs.thread_id = threads.id
      GROUP BY threads.id ORDER BY threads.updated_at DESC LIMIT ? OFFSET ?`).all(safeLimit, safeOffset) as Array<Record<string, unknown>>).map(threadFromRow);
  }

  getThread(threadId: string): (TraceThread & { sessions: TraceSession[]; runs: TraceRun[] }) | undefined {
    const row = this.#db.query(`SELECT threads.*,
      (SELECT COUNT(*) FROM runs WHERE runs.thread_id = threads.id) AS run_count,
      (SELECT status FROM runs WHERE runs.thread_id = threads.id ORDER BY submitted_at DESC LIMIT 1) AS last_status
      FROM threads WHERE id = ?`).get(threadId) as Record<string, unknown> | null;
    if (!row) return undefined;
    const sessions = (this.#db.query("SELECT * FROM sessions WHERE thread_id = ? ORDER BY created_at").all(threadId) as Array<Record<string, unknown>>).map(sessionFromRow);
    return { ...threadFromRow(row), sessions, runs: this.listRuns({ threadId, limit: 200 }) };
  }

  terminalThreads(): TerminalTraceThread[] {
    return this.listThreads(10_000, 0)
      .filter((thread) => thread.lastStatus === "completed" || thread.lastStatus === "failed")
      .map((thread) => {
        const detail = this.getThread(thread.id);
        const desktopThreadIds = detail?.runs
          .map((run) => run.codexThreadId)
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .filter((value, index, values) => values.indexOf(value) === index)
          ?? [];
        return { ...thread, desktopThreadIds };
      });
  }

  deleteTerminalThreads(threadIds: readonly string[]): number {
    const uniqueIds = [...new Set(threadIds)];
    if (uniqueIds.length === 0) return 0;
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const nonTerminal = this.#db.query(`SELECT COUNT(*) AS count FROM runs WHERE thread_id IN (${placeholders}) AND status NOT IN ('completed', 'failed')`)
      .get(...uniqueIds) as { count: number };
    if (Number(nonTerminal.count) > 0) {
      throw new Error("Active or queued threads cannot be deleted.");
    }
    const existing = this.#db.query(`SELECT COUNT(*) AS count FROM threads WHERE id IN (${placeholders})`)
      .get(...uniqueIds) as { count: number };
    this.#db.transaction(() => {
      this.#db.query(`DELETE FROM runs WHERE thread_id IN (${placeholders})`).run(...uniqueIds);
      this.#db.query(`DELETE FROM sessions WHERE thread_id IN (${placeholders})`).run(...uniqueIds);
      this.#db.query(`DELETE FROM threads WHERE id IN (${placeholders})`).run(...uniqueIds);
    })();
    return Number(existing.count);
  }
}
