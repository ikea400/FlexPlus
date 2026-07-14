/**
 * @domain/ports/notification.port.ts
 *
 * SECONDARY PORT — Driven side.
 * Defines the contract for outbound notification delivery.
 * This interface has ZERO external dependencies.
 */

import type { PlacementAnalysisResult } from "./ai-filter.port.js";

// ─── Notification payload types ──────────────────────────────────────────────

/**
 * A single placement item included in a notification digest.
 */
export interface NotifiablePlacement {
  /** Internal UUID */
  readonly id: string;

  /** Portal-assigned post number (e.g. "2024-A-1234") */
  readonly portalId: string;

  readonly title: string;
  readonly organisation: string;
  readonly location: string;
  readonly detailUrl: string;
  readonly deadlineDate: string | null;

  /** Application mode detected from the portal detail page */
  readonly applicationMode: 'full' | 'external' | 'applied' | 'unknown';

  /** AI-generated analysis result for this placement */
  readonly analysis: PlacementAnalysisResult;
}

/**
 * Options for sending a digest notification.
 */
export interface NotificationOptions {
  /** Verified sender email address (ignored by Discord) */
  readonly fromEmail?: string | undefined;

  /** One or more recipient email addresses (ignored by Discord) */
  readonly toEmails?: readonly string[] | undefined;

  /**
   * Optional subject line or message title override.
   */
  readonly subjectOverride?: string | undefined;
}

/**
 * Result of a notification send attempt.
 */
export interface NotificationResult {
  /** Whether all recipients received the message successfully */
  readonly success: boolean;

  /**
   * Provider-assigned message ID (for audit trail / idempotency).
   * null if the send failed.
   */
  readonly messageId: string | null;

  /** ISO 8601 timestamp of the send attempt */
  readonly sentAt: string;

  /** Error message if success is false */
  readonly errorMessage: string | null;
}

// ─── Port interface ──────────────────────────────────────────────────────────

/**
 * INotification — Port interface.
 *
 * Implementations live in `@infrastructure/notification/`.
 * Designed to send digest-style email summaries (one email per run,
 * listing all newly-relevant placements).
 */
export interface INotification {
  /**
   * Sends a digest containing all newly-relevant placements.
   */
  sendDigest(
    placements: readonly NotifiablePlacement[],
    options: NotificationOptions,
  ): Promise<NotificationResult>;

  /**
   * Sends an interactive MFA prompt asking the user to confirm they are
   * ready to complete MFA. The user clicks a button in the notification channel.
   */
  sendMfaPrompt(): Promise<void>;

  /**
   * Sends the 2-digit Microsoft MFA number to the user so they can approve
   * the sign-in request on their device.
   */
  sendMfaCode(code: string): Promise<void>;

  /**
   * Waits until the user signals they are ready for MFA (e.g., clicks a button).
   * Resolves when ready, rejects on timeout.
   */
  waitForMfaReady(timeoutMs?: number): Promise<void>;

  /**
   * Checks whether the notification service is reachable and configured.
   */
  healthCheck(): Promise<boolean>;

  /**
   * Sends an error alert to the user.
   */
  sendError(message: string): Promise<void>;

  /**
   * Marks the previously sent MFA code message as successfully completed
   * (e.g. by adding a checkmark reaction).
   */
  markMfaSuccess(): Promise<void>;

  /**
   * Updates the internal status of the notification adapter (e.g. for a !status command).
   */
  updateStatus(status: { isRunning?: boolean, lastRunAt?: Date, lastError?: string | null, isAuthenticated?: boolean | null }): void;
}

