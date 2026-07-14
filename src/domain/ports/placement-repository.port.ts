/**
 * @domain/ports/placement-repository.port.ts
 *
 * SECONDARY PORT — Driven side.
 * Defines the persistence contract for Placement aggregates.
 * This interface has ZERO external dependencies.
 */

import type { RawPlacementListing } from "./scraper.port.js";

// ─── Stored Placement ────────────────────────────────────────────────────────

/**
 * A placement record as stored in the database.
 * Combines raw scraped data with AI-enriched metadata.
 */
export interface StoredPlacement {
  /** Auto-generated UUID primary key */
  readonly id: string;

  /** The portal's own identifier (used for deduplication) */
  readonly portalId: string;

  readonly title: string;
  readonly organisation: string;
  readonly location: string;
  readonly deadlineDate: string | null;
  readonly descriptionHtml: string;
  readonly detailUrl: string;

  /** ISO 8601 timestamp when this record was first persisted */
  readonly firstSeenAt: string;

  /** ISO 8601 timestamp of the most recent scrape that saw this listing */
  readonly lastSeenAt: string;

  /**
   * AI-generated relevance score (0–100).
   * null if not yet processed by the AI filter.
   */
  readonly relevanceScore: number | null;

  /**
   * AI-generated summary of why this placement is (or isn't) relevant.
   * null if not yet processed by the AI filter.
   */
  readonly aiSummary: string | null;

  /**
   * Technical skills / tools extracted by the AI from the job description.
   * Empty array if not yet processed or none found.
   */
  readonly extractedSkills: string[];

  /**
   * How the application is handled for this posting.
   * 'full' = apply on Flex, 'external' = apply on employer site,
   * 'applied' = already submitted, 'unknown' = undetermined.
   */
  readonly applicationMode: 'full' | 'external' | 'applied' | 'unknown';

  /** Whether a notification has been sent for this placement */
  readonly notificationSent: boolean;

  /** Whether we have auto-postulated to this placement */
  readonly applied: boolean;
}

// ─── Query options ───────────────────────────────────────────────────────────

export interface PlacementQueryOptions {
  /** Filter to placements not yet sent as notifications */
  readonly unnotifiedOnly?: boolean;

  /** Filter to placements we have not auto-applied to yet */
  readonly unappliedOnly?: boolean;

  /** Filter to placements with a score at or above this threshold */
  readonly minRelevanceScore?: number;

  /** Maximum number of results to return */
  readonly limit?: number;
}

// ─── Repository port ─────────────────────────────────────────────────────────

/**
 * IPlacementRepository — Port interface.
 *
 * Implementations live in `@infrastructure/db/`.
 * Uses synchronous-style methods because `better-sqlite3` is synchronous;
 * the interface deliberately returns Promises so an async adapter could
 * be swapped in without changing callers.
 */
export interface IPlacementRepository {
  /**
   * Persists a batch of raw listings from a scraping run.
   * Uses upsert semantics: inserts new records, updates `lastSeenAt` for
   * existing ones (matched by `portalId`).
   *
   * @returns The number of NEW placements inserted (not existing updates).
   */
  upsertMany(listings: readonly RawPlacementListing[]): Promise<number>;

  /**
   * Retrieves placements matching the given query options.
   */
  findAll(options?: PlacementQueryOptions): Promise<readonly StoredPlacement[]>;

  /**
   * Retrieves a single placement by its internal UUID.
   * Returns null if not found.
   */
  findById(id: string): Promise<StoredPlacement | null>;

  /**
   * Updates AI-generated fields for a single placement.
   */
  updateAiMetadata(
    id: string,
    metadata: { relevanceScore: number; aiSummary: string; extractedSkills?: string[] },
  ): Promise<void>;

  /**
   * Marks a placement as having had its notification sent.
   */
  markNotificationSent(id: string): Promise<void>;

  /**
   * Marks a placement as having been auto-postulated to.
   */
  markApplied(id: string): Promise<void>;
}
