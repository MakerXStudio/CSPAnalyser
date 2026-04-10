import type Database from 'better-sqlite3';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  mode TEXT NOT NULL DEFAULT 'local',
  config TEXT,
  report_server_port INTEGER,
  proxy_port INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status_code INTEGER,
  crawled_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, url)
);

CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  document_uri TEXT NOT NULL,
  blocked_uri TEXT NOT NULL,
  violated_directive TEXT NOT NULL,
  effective_directive TEXT NOT NULL,
  source_file TEXT,
  line_number INTEGER,
  column_number INTEGER,
  disposition TEXT DEFAULT 'report',
  sample TEXT,
  captured_via TEXT NOT NULL,
  raw_report TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, document_uri, blocked_uri, effective_directive)
);

CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  policy_header TEXT NOT NULL,
  directives TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'header',
  is_report_only INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permissions_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  directive TEXT NOT NULL,
  allowlist TEXT NOT NULL DEFAULT '[]',
  header_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, page_id, directive, header_type)
);
`;

export function initializeDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
}
