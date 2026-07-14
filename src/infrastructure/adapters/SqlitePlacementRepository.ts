/**
 * src/infrastructure/adapters/SqlitePlacementRepository.ts
 *
 * SECONDARY ADAPTER — Driven side.
 * Implements IPlacementRepository using the built-in node:sqlite module.
 *
 * node:sqlite is stable in Node >= 23 and available behind the
 * --experimental-sqlite flag in Node 22.5+.
 * No native addon compilation required.
 *
 * Dependency direction: Infrastructure → Domain (port interfaces only).
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type {
  IPlacementRepository,
  PlacementQueryOptions,
  StoredPlacement,
} from "../../domain/ports/placement-repository.port.js";
import type { RawPlacementListing } from "../../domain/ports/scraper.port.js";

// ─── DDL ─────────────────────────────────────────────────────────────────────

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS placements (
  id                TEXT    PRIMARY KEY NOT NULL,
  portal_id         TEXT    NOT NULL UNIQUE,
  title             TEXT    NOT NULL,
  organisation      TEXT    NOT NULL DEFAULT '',
  location          TEXT    NOT NULL DEFAULT '',
  deadline_date     TEXT,
  description_html  TEXT    NOT NULL DEFAULT '',
  detail_url        TEXT    NOT NULL DEFAULT '',
  first_seen_at     TEXT    NOT NULL,
  last_seen_at      TEXT    NOT NULL,
  relevance_score   INTEGER,
  ai_summary        TEXT,
  extracted_skills  TEXT,
  application_mode  TEXT    NOT NULL DEFAULT 'unknown',
  notification_sent INTEGER NOT NULL DEFAULT 0,
  applied           INTEGER NOT NULL DEFAULT 0
);


CREATE INDEX IF NOT EXISTS idx_placements_portal_id
  ON placements (portal_id);

CREATE INDEX IF NOT EXISTS idx_placements_relevance
  ON placements (relevance_score)
  WHERE relevance_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_placements_notified
  ON placements (notification_sent);

CREATE INDEX IF NOT EXISTS idx_placements_applied
  ON placements (applied);
`;

// ─── Internal row shape ───────────────────────────────────────────────────────

interface PlacementRow {
  id: string;
  portal_id: string;
  title: string;
  organisation: string;
  location: string;
  deadline_date: string | null;
  description_html: string;
  detail_url: string;
  first_seen_at: string;
  last_seen_at: string;
  relevance_score: number | null;
  ai_summary: string | null;
  extracted_skills: string | null;
  application_mode: string;
  notification_sent: number;
  applied: number;
}

// ─── Row → domain mapper ──────────────────────────────────────────────────────

function rowToStoredPlacement(row: PlacementRow): StoredPlacement {
  let extractedSkills: string[] = [];
  try {
    if (row.extracted_skills) {
      extractedSkills = JSON.parse(row.extracted_skills) as string[];
    }
  } catch {
    // ignore parse errors
  }
  return {
    id: row.id,
    portalId: row.portal_id,
    title: row.title,
    organisation: row.organisation,
    location: row.location,
    deadlineDate: row.deadline_date,
    descriptionHtml: row.description_html,
    detailUrl: row.detail_url,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    relevanceScore: row.relevance_score,
    aiSummary: row.ai_summary,
    extractedSkills,
    applicationMode: (row.application_mode ?? 'unknown') as 'full' | 'external' | 'applied' | 'unknown',
    notificationSent: row.notification_sent === 1,
    applied: row.applied === 1,
  };
}

// ─── Result shape returned by StatementSync.run() ────────────────────────────

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/**
 * SqlitePlacementRepository
 *
 * Lifecycle:
 *   const repo = new SqlitePlacementRepository('/app/data/flexplus.db');
 *   // schema is applied immediately in the constructor
 *   await repo.upsertMany(listings);
 *
 * All node:sqlite calls are synchronous; they are wrapped in Promise.resolve()
 * so the class satisfies the async IPlacementRepository contract and callers
 * can later swap to a genuinely async driver without any changes.
 */
export class SqlitePlacementRepository implements IPlacementRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // Schema is idempotent — safe to run on every startup
    this.db.exec(DDL);
    // Migrations for columns added after initial release
    for (const migration of [
      "ALTER TABLE placements ADD COLUMN extracted_skills TEXT",
      "ALTER TABLE placements ADD COLUMN application_mode TEXT NOT NULL DEFAULT 'unknown'",
    ]) {
      try { this.db.exec(migration); } catch { /* column already exists */ }
    }
  }

  // ─── IPlacementRepository: upsertMany ─────────────────────────────────────

  /**
   * Inserts new placements and updates mutable fields for existing ones.
   * Deduplication key: portal_id.
   *
   * Strategy: INSERT OR IGNORE to catch new rows (changes = 1), then
   * UPDATE on conflict rows (changes = 0 from INSERT). This two-statement
   * pattern correctly counts genuine new inserts without needing
   * ON CONFLICT DO UPDATE's opaque change count.
   */
  upsertMany(listings: readonly RawPlacementListing[]): Promise<number> {
    if (listings.length === 0) return Promise.resolve(0);

    const now = new Date().toISOString();

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO placements (
        id, portal_id, title, organisation, location,
        deadline_date, description_html, detail_url,
        first_seen_at, last_seen_at,
        application_mode, relevance_score, ai_summary, notification_sent, applied
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, NULL, NULL, 0, 0
      )
    `);

    const updateStmt = this.db.prepare(`
      UPDATE placements SET
        last_seen_at     = ?,
        title            = ?,
        organisation     = ?,
        location         = ?,
        deadline_date    = ?,
        description_html = ?,
        detail_url       = ?,
        application_mode = ?
      WHERE portal_id = ?
    `);

    let newCount = 0;

    this.db.exec("BEGIN");
    try {
      for (const listing of listings) {
        const result = insertStmt.run(
          randomUUID(),
          listing.portalId,
          listing.title,
          listing.organisation,
          listing.location,
          listing.deadlineDate ?? null,
          listing.descriptionHtml,
          listing.detailUrl,
          now,
          now,
          listing.applicationMode ?? 'unknown',
        ) as unknown as RunResult;

        if (result.changes > 0) {
          newCount++;
        } else {
          // Row already existed — update time-sensitive fields
          updateStmt.run(
            now,
            listing.title,
            listing.organisation,
            listing.location,
            listing.deadlineDate ?? null,
            listing.descriptionHtml,
            listing.detailUrl,
            listing.applicationMode ?? 'unknown',
            listing.portalId,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return Promise.resolve(newCount);
  }

  // ─── IPlacementRepository: findAll ────────────────────────────────────────

  findAll(options?: PlacementQueryOptions): Promise<readonly StoredPlacement[]> {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options?.unnotifiedOnly === true) {
      conditions.push("notification_sent = 0");
    }

    if (options?.unappliedOnly === true) {
      conditions.push("applied = 0");
    }

    if (options?.minRelevanceScore !== undefined) {
      conditions.push("relevance_score >= ?");
      params.push(options.minRelevanceScore);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const limitClause =
      options?.limit !== undefined ? `LIMIT ${Number(options.limit)}` : "";

    const stmt = this.db.prepare(`
      SELECT * FROM placements
      ${where}
      ORDER BY relevance_score DESC NULLS LAST, last_seen_at DESC
      ${limitClause}
    `);

    const rows = stmt.all(...params) as unknown as PlacementRow[];
    return Promise.resolve(rows.map(rowToStoredPlacement));
  }

  // ─── IPlacementRepository: findById ───────────────────────────────────────

  findById(id: string): Promise<StoredPlacement | null> {
    const stmt = this.db.prepare(
      "SELECT * FROM placements WHERE id = ? LIMIT 1",
    );
    const row = stmt.get(id) as unknown as PlacementRow | undefined;
    return Promise.resolve(row ? rowToStoredPlacement(row) : null);
  }

  // ─── IPlacementRepository: updateAiMetadata ───────────────────────────────

  updateAiMetadata(
    id: string,
    metadata: { relevanceScore: number; aiSummary: string; extractedSkills?: string[] },
  ): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE placements
      SET relevance_score  = ?,
          ai_summary       = ?,
          extracted_skills = ?
      WHERE id = ?
    `);
    const skillsJson = metadata.extractedSkills && metadata.extractedSkills.length > 0
      ? JSON.stringify(metadata.extractedSkills)
      : null;
    stmt.run(metadata.relevanceScore, metadata.aiSummary, skillsJson, id);
    return Promise.resolve();
  }

  // ─── IPlacementRepository: markNotificationSent ───────────────────────────

  markNotificationSent(id: string): Promise<void> {
    const stmt = this.db.prepare(
      "UPDATE placements SET notification_sent = 1 WHERE id = ?",
    );
    stmt.run(id);
    return Promise.resolve();
  }

  // ─── IPlacementRepository: markApplied ────────────────────────────────────

  markApplied(id: string): Promise<void> {
    const stmt = this.db.prepare(
      "UPDATE placements SET applied = 1 WHERE id = ?",
    );
    stmt.run(id);
    return Promise.resolve();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Closes the SQLite connection.
   * Call during graceful shutdown (SIGTERM handler).
   */
  close(): void {
    this.db.close();
  }

  // ─── Static factory ────────────────────────────────────────────────────────

  /**
   * Creates the repository from the DATABASE_PATH environment variable.
   * Falls back to ./data/flexplus.db.
   */
  static fromEnv(): SqlitePlacementRepository {
    const dbPath = process.env["DATABASE_PATH"] ?? "./data/flexplus.db";
    return new SqlitePlacementRepository(dbPath);
  }
}
