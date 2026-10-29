import pg from "pg";

const { Pool } = pg;

export class BookingDatabase {
  constructor(connectionString, { ssl = false } = {}) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      ssl: ssl ? { rejectUnauthorized: true } : undefined,
    });
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS booking_projects (
        project_id UUID PRIMARY KEY,
        project JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS booking_projects_published_slug
        ON booking_projects ((project->'service'->>'slug'))
        WHERE project->'service'->>'published' = 'true';
      CREATE TABLE IF NOT EXISTS booking_ledgers (
        project_id UUID PRIMARY KEY REFERENCES booking_projects(project_id) ON DELETE CASCADE,
        ledger JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS admin_magic_links (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS admin_magic_links_expiry ON admin_magic_links(expires_at);
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
    `);
  }

  async withWriteLock(operation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('booking-studio-writes', 0))");
      const result = await operation();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadProject(id) {
    const { rows } = await this.pool.query(
      "SELECT project FROM booking_projects WHERE project_id = $1",
      [id],
    );
    return rows[0]?.project || null;
  }

  async saveProject(id, project) {
    try {
      await this.pool.query(
        `INSERT INTO booking_projects (project_id, project, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (project_id) DO UPDATE SET project = EXCLUDED.project, updated_at = NOW()`,
        [id, JSON.stringify(project)],
      );
    } catch (error) {
      if (error.code === "23505") {
        throw Object.assign(new Error("That public page URL is already in use."), { status: 409 });
      }
      throw error;
    }
    return project;
  }

  async listProjects() {
    const { rows } = await this.pool.query(
      "SELECT project FROM booking_projects ORDER BY updated_at DESC",
    );
    return rows.map(({ project }) => project);
  }

  async findPublishedProject(slug) {
    const { rows } = await this.pool.query(
      "SELECT project FROM booking_projects WHERE project->'service'->>'slug' = $1 AND project->'service'->>'published' = 'true' LIMIT 1",
      [slug],
    );
    return rows[0]?.project || null;
  }

  async loadLedger(id) {
    const { rows } = await this.pool.query(
      "SELECT ledger FROM booking_ledgers WHERE project_id = $1",
      [id],
    );
    return rows[0]?.ledger || { holds: [], bookings: [], holdKeys: {}, confirmKeys: {}, emailOutbox: [] };
  }

  async saveLedger(id, ledger) {
    await this.pool.query(
      `INSERT INTO booking_ledgers (project_id, ledger, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (project_id) DO UPDATE SET ledger = EXCLUDED.ledger, updated_at = NOW()`,
      [id, JSON.stringify(ledger)],
    );
  }

  async createMagicLink(email, tokenHash, expiresAt) {
    await this.pool.query(
      "INSERT INTO admin_magic_links (token_hash, email, expires_at) VALUES ($1, $2, $3)",
      [tokenHash, email, expiresAt],
    );
  }

  async consumeMagicLink(tokenHash) {
    const { rows } = await this.pool.query(
      `UPDATE admin_magic_links
       SET consumed_at = NOW()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING email`,
      [tokenHash],
    );
    return rows[0]?.email || null;
  }

  async createSession(tokenHash, email, expiresAt) {
    await this.pool.query(
      "INSERT INTO admin_sessions (token_hash, email, expires_at) VALUES ($1, $2, $3)",
      [tokenHash, email, expiresAt],
    );
  }

  async getSession(tokenHash) {
    const { rows } = await this.pool.query(
      "SELECT email FROM admin_sessions WHERE token_hash = $1 AND expires_at > NOW()",
      [tokenHash],
    );
    return rows[0]?.email || null;
  }

  async deleteSession(tokenHash) {
    await this.pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [tokenHash]);
  }

  async cleanExpiredAuthRecords() {
    await this.pool.query("DELETE FROM admin_magic_links WHERE expires_at <= NOW() OR consumed_at IS NOT NULL");
    await this.pool.query("DELETE FROM admin_sessions WHERE expires_at <= NOW()");
  }

  async close() {
    await this.pool.end();
  }
}
