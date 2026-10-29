CREATE TABLE booking_projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  project TEXT NOT NULL CHECK (json_valid(project)),
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX booking_projects_published_slug
  ON booking_projects (json_extract(project, '$.service.slug'))
  WHERE json_extract(project, '$.service.published') = 1;

CREATE TABLE booking_ledgers (
  project_id TEXT PRIMARY KEY NOT NULL,
  ledger TEXT NOT NULL CHECK (json_valid(ledger)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES booking_projects(project_id) ON DELETE CASCADE
);

CREATE TABLE admin_magic_links (
  token_hash TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX admin_magic_links_expiry ON admin_magic_links(expires_at);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  scope TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, scope)
);
