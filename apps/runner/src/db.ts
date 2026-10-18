import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { CodeFix, Issue, Mission, Repair, Run, RepositoryConnection } from '@agentproof/shared';
import { config } from './config';

/**
 * SQLite via the built-in node:sqlite module (Node 24). No native build step.
 * Documents are stored as JSON blobs validated by the shared schemas on read and write;
 * columns exist only for the fields we query on.
 */

let db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.artifactsDir, { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_mission ON runs(mission_id);
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repairs (
      id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codefixes (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS codefixes_run ON codefixes(run_id);
  `);
  return db;
}

// --- missions ------------------------------------------------------------------
export function saveMission(m: Mission): void {
  Mission.parse(m);
  getDb()
    .prepare('INSERT OR REPLACE INTO missions (id, created_at, json) VALUES (?, ?, ?)')
    .run(m.id, m.createdAt, JSON.stringify(m));
}
export function getMission(id: string): Mission | undefined {
  const row = getDb().prepare('SELECT json FROM missions WHERE id = ?').get(id) as
    { json: string } | undefined;
  return row ? Mission.parse(JSON.parse(row.json)) : undefined;
}

// --- runs ----------------------------------------------------------------------
export function saveRun(r: Run): void {
  Run.parse(r);
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO runs (id, mission_id, status, created_at, json) VALUES (?, ?, ?, ?, ?)',
    )
    .run(r.id, r.missionId, r.status, r.createdAt, JSON.stringify(r));
}
export function getRun(id: string): Run | undefined {
  const row = getDb().prepare('SELECT json FROM runs WHERE id = ?').get(id) as
    { json: string } | undefined;
  return row ? Run.parse(JSON.parse(row.json)) : undefined;
}
export function listRuns(missionId?: string): Run[] {
  const rows = (
    missionId
      ? getDb()
          .prepare('SELECT json FROM runs WHERE mission_id = ? ORDER BY created_at')
          .all(missionId)
      : getDb().prepare('SELECT json FROM runs ORDER BY created_at DESC LIMIT 100').all()
  ) as { json: string }[];
  return rows.map((r) => Run.parse(JSON.parse(r.json)));
}

// --- issues / repairs ----------------------------------------------------------
export function saveIssue(i: Issue): void {
  Issue.parse(i);
  getDb()
    .prepare('INSERT OR REPLACE INTO issues (id, run_id, json) VALUES (?, ?, ?)')
    .run(i.id, i.runId, JSON.stringify(i));
}
export function getIssue(id: string): Issue | undefined {
  const row = getDb().prepare('SELECT json FROM issues WHERE id = ?').get(id) as
    { json: string } | undefined;
  return row ? Issue.parse(JSON.parse(row.json)) : undefined;
}
export function listIssues(runId: string): Issue[] {
  const rows = getDb().prepare('SELECT json FROM issues WHERE run_id = ?').all(runId) as {
    json: string;
  }[];
  return rows.map((r) => Issue.parse(JSON.parse(r.json)));
}
export function saveRepair(r: Repair): void {
  Repair.parse(r);
  getDb()
    .prepare('INSERT OR REPLACE INTO repairs (id, issue_id, status, json) VALUES (?, ?, ?, ?)')
    .run(r.id, r.issueId, r.status, JSON.stringify(r));
}
export function getRepair(id: string): Repair | undefined {
  const row = getDb().prepare('SELECT json FROM repairs WHERE id = ?').get(id) as
    { json: string } | undefined;
  return row ? Repair.parse(JSON.parse(row.json)) : undefined;
}
export function listRepairsForRun(runId: string): Repair[] {
  const rows = getDb()
    .prepare('SELECT r.json FROM repairs r JOIN issues i ON i.id = r.issue_id WHERE i.run_id = ?')
    .all(runId) as { json: string }[];
  return rows.map((r) => Repair.parse(JSON.parse(r.json)));
}

// Tokens are omitted by the shared metadata schema before serialization.
export function saveRepository(repository: RepositoryConnection): void {
  const safe = RepositoryConnection.parse(repository);
  getDb()
    .prepare('INSERT INTO repositories (id, run_id, json) VALUES (?, ?, ?)')
    .run(safe.id, safe.runId, JSON.stringify(safe));
}

export function getRepository(runId: string): RepositoryConnection | undefined {
  const row = getDb().prepare('SELECT json FROM repositories WHERE run_id = ?').get(runId) as
    { json: string } | undefined;
  return row ? RepositoryConnection.parse(JSON.parse(row.json)) : undefined;
}

export function deleteRepository(runId: string): void {
  getDb().prepare('DELETE FROM repositories WHERE run_id = ?').run(runId);
}

// --- code fixes (docs/CODEFIX.md) ----------------------------------------------
// The document never holds a token: CodeFix has no field for one, and the request's token stays
// in the orchestrator's memory for the duration of the fix.
export function saveCodeFix(fix: CodeFix): void {
  CodeFix.parse(fix);
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO codefixes (id, run_id, status, created_at, json) VALUES (?, ?, ?, ?, ?)',
    )
    .run(fix.id, fix.runId, fix.status, fix.createdAt, JSON.stringify(fix));
}
export function getCodeFix(id: string): CodeFix | undefined {
  const row = getDb().prepare('SELECT json FROM codefixes WHERE id = ?').get(id) as
    { json: string } | undefined;
  return row ? CodeFix.parse(JSON.parse(row.json)) : undefined;
}
export function listCodeFixesForRun(runId: string): CodeFix[] {
  const rows = getDb()
    .prepare('SELECT json FROM codefixes WHERE run_id = ? ORDER BY created_at')
    .all(runId) as { json: string }[];
  return rows.map((r) => CodeFix.parse(JSON.parse(r.json)));
}
