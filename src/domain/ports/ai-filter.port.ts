/**
 * @domain/ports/ai-filter.port.ts
 *
 * SECONDARY PORT — Driven side.
 * Defines the contract for AI-based placement filtering and scoring.
 * This interface has ZERO external dependencies.
 */

import type { StoredPlacement } from "./placement-repository.port.js";

// ─── Input / Output types ────────────────────────────────────────────────────

/**
 * A single placement submitted to the AI for analysis.
 * Contains only the fields the AI needs — no DB internals.
 */
export interface PlacementForAnalysis {
  readonly id: string;
  readonly title: string;
  readonly organisation: string;
  readonly location: string;
  readonly descriptionHtml: string;
}

/**
 * The AI's analysis result for a single placement.
 */
export interface PlacementAnalysisResult {
  /** The placement's internal ID (echoed back for correlation) */
  readonly placementId: string;

  /**
   * Integer relevance score from 0 to 100.
   *   0–29   → Not relevant
   *   30–59  → Possibly relevant
   *   60–100 → Highly relevant
   */
  readonly relevanceScore: number;

  /**
   * 1–3 sentence plain-text explanation of the score.
   * Must be suitable for inclusion in a notification email.
   */
  readonly summary: string;

  /**
   * Extracted key skills / technologies mentioned in the posting.
   * Empty array if none detected.
   */
  readonly extractedSkills: readonly string[];
}

/**
 * Configuration for a batch analysis request.
 */
export interface BatchAnalysisOptions {
  /**
   * Minimum relevance score (0–100) a placement must receive
   * to be considered worth notifying about.
   */
  readonly relevanceThreshold: number;

  /**
   * Free-text description of the candidate's profile / preferences,
   * injected into the AI prompt to personalise scoring.
   * Example: "Computer science student interested in backend, data engineering."
   */
  readonly candidateProfile: string;

  /**
   * Optional custom instructions/prompt describing what to accept/reject.
   */
  readonly customPrompt?: string | undefined;
}

/**
 * Result of a batch analysis run.
 */
export interface BatchAnalysisResult {
  /** Results for each submitted placement */
  readonly results: readonly PlacementAnalysisResult[];

  /** Placements that failed analysis (AI error or invalid response) */
  readonly failed: ReadonlyArray<{ readonly placementId: string; readonly reason: string }>;

  /** Total input tokens consumed across all API calls */
  readonly totalInputTokens: number;

  /** Total output tokens consumed across all API calls */
  readonly totalOutputTokens: number;
}

// ─── Port interface ──────────────────────────────────────────────────────────

/**
 * IAIFilter — Port interface.
 *
 * Implementations live in `@infrastructure/ai/`.
 * Supports batch processing to minimise API round-trips.
 */
export interface IAIFilter {
  /**
   * Analyses a batch of placements and returns a relevance score + summary
   * for each one.
   *
   * @param placements - 1 to N placements to analyse.
   * @param options    - Scoring configuration and candidate profile.
   */
  analyseBatch(
    placements: readonly PlacementForAnalysis[],
    options: BatchAnalysisOptions,
  ): Promise<BatchAnalysisResult>;

  /**
   * Convenience helper: converts a StoredPlacement into a PlacementForAnalysis.
   * Strips HTML tags from the description before sending to the AI.
   */
  toAnalysisInput(placement: StoredPlacement): PlacementForAnalysis;
}
