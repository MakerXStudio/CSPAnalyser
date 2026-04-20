import type Database from 'better-sqlite3';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  mode TEXT NOT NULL DEFAULT 'local',
  config TEXT,
  project TEXT,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_violations_dedup
  ON violations (
    session_id,
    document_uri,
    blocked_uri,
    effective_directive,
    COALESCE(source_file, ''),
    COALESCE(line_number, -1)
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

CREATE TABLE IF NOT EXISTS inline_hashes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  directive TEXT NOT NULL,
  hash TEXT NOT NULL,
  content_length INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, directive, hash)
);

CREATE TABLE IF NOT EXISTS existing_csp_headers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  header_type TEXT NOT NULL,
  header_value TEXT NOT NULL,
  source_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, header_type, source_url)
);
`;

export function initializeDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  // Add project column to existing databases created before this column existed.
  // Safe to call repeatedly: SQLite throws if the column already exists.
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN project TEXT');
  } catch {
    // Column already exists — ignore
  }

  // Migrate the violations table uniqueness constraint.
  // Old databases have a table-level UNIQUE(session_id, document_uri, blocked_uri,
  // effective_directive) that is too coarse. The new schema uses a UNIQUE INDEX with
  // COALESCE on source_file/line_number, but the old table-level constraint remains
  // unless we recreate the table. SQLite cannot drop constraints in-place, so we
  // rebuild the table if the old constraint is still present.
  migrateViolationsUniqueConstraint(db);
}

/**
 * Checks whether the violations table still has the old table-level UNIQUE
 * constraint and, if so, rebuilds it with only the new expression-based index.
 */
function migrateViolationsUniqueConstraint(db: Database.Database): void {
  // Inspect the CREATE TABLE statement for an inline UNIQUE constraint.
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='violations'")
    .get() as { sql: string } | undefined;
  if (!tableInfo) return;

  // If the table DDL doesn't contain a table-level UNIQUE, no migration needed.
  // The new schema creates violations without an inline UNIQUE.
  if (!tableInfo.sql.includes('UNIQUE(session_id, document_uri, blocked_uri, effective_directive)')) {
    return;
  }

  // Rebuild the table without the inline UNIQUE constraint inside a
  // transaction so an interrupted migration cannot leave a half-migrated DB.
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE violations_new (
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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT OR IGNORE INTO violations_new
        SELECT * FROM violations;

      DROP TABLE violations;
      ALTER TABLE violations_new RENAME TO violations;

      CREATE UNIQUE INDEX idx_violations_dedup
        ON violations (
          session_id,
          document_uri,
          blocked_uri,
          effective_directive,
          COALESCE(source_file, ''),
          COALESCE(line_number, -1)
        );
    `);
  });
  migrate();
}
