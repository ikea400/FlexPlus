/**
 * src/infrastructure/adapters/DiscordNotificationAdapter.ts
 *
 * SECONDARY ADAPTER — Driven side.
 * Implements INotification using Discord Webhooks.
 *
 * Dependency direction: Infrastructure → Domain (port interfaces only).
 */

import type {
  INotification,
  NotifiablePlacement,
  NotificationOptions,
  NotificationResult,
} from "../../domain/ports/notification.port.js";

export interface DiscordConfig {
  readonly webhookUrl: string;
}

export class DiscordNotificationAdapter implements INotification {
  private readonly webhookUrl: string;

  constructor(config: DiscordConfig) {
    this.webhookUrl = config.webhookUrl;
  }

  /**
   * Sends a digest to the Discord Webhook containing all newly-relevant placements.
   */
  async sendDigest(
    placements: readonly NotifiablePlacement[],
    _options: NotificationOptions,
  ): Promise<NotificationResult> {
    const sentAt = new Date().toISOString();

    if (placements.length === 0) {
      return {
        success: true,
        messageId: null,
        sentAt,
        errorMessage: "No placements to notify about.",
      };
    }

    try {
      const embeds = placements.map((p) => {
        const score = p.analysis.relevanceScore;

        // Color coding for score (Green for >= 80, Yellow/Orange for >= 60, Red for < 60)
        let color = 15136828; // Red (#e74c3c)
        if (score >= 80) {
          color = 3066993; // Green (#2ecc71)
        } else if (score >= 60) {
          color = 15856143; // Yellow/Orange (#f1c40f)
        }

        const skillsValue =
          p.analysis.extractedSkills && p.analysis.extractedSkills.length > 0
            ? p.analysis.extractedSkills.join(", ")
            : "Aucune extraite";

        const fields = [
          {
            name: "🏢 Employeur",
            value: p.organisation || "Non spécifié",
            inline: true,
          },
          {
            name: "📍 Lieu",
            value: p.location || "Non spécifié",
            inline: true,
          },
          {
            name: "📅 Date limite",
            value: p.deadlineDate || "Non spécifiée",
            inline: true,
          },
          {
            name: "🛠️ Compétences clés",
            value: skillsValue,
            inline: false,
          },
        ];

        return {
          title: p.title,
          url: p.detailUrl,
          color,
          description: `**Résumé de pertinence IA:**\n*${p.analysis.summary || "Aucun résumé généré."}*`,
          fields,
          footer: {
            text: `Score de pertinence: ${score}/100`,
          },
        };
      });

      // Split embeds into chunks of 10 (Discord webhook embed limit per message)
      const chunkSize = 10;
      let lastMessageId: string | null = null;

      for (let i = 0; i < embeds.length; i += chunkSize) {
        const chunk = embeds.slice(i, i + chunkSize);
        const batchNum = Math.floor(i / chunkSize) + 1;
        const totalBatches = Math.ceil(embeds.length / chunkSize);

        const content =
          i === 0
            ? `📢 **FlexPlus: ${placements.length} nouvelle(s) opportunité(s) de stage identifiée(s)!**`
            : undefined;

        const payload = {
          username: "FlexPlus Bot",
          avatar_url: "https://see.etsmtl.ca/favicon.ico",
          content,
          embeds: chunk.map((embed, idx) => ({
            ...embed,
            // Add batch indicator to the footer
            footer: {
              text: `${embed.footer.text} • Page ${batchNum}/${totalBatches} [Poste ${i + idx + 1}/${placements.length}]`,
            },
          })),
        };

        const response = await fetch(this.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `Discord Webhook responded with status ${response.status}: ${text}`,
          );
        }

        // Discord webhooks don't return message id by default unless requested with ?wait=true,
        // so we'll just track the status and provide a dummy/placeholder ID.
        lastMessageId = `discord_batch_${batchNum}_${Date.now()}`;
      }

      return {
        success: true,
        messageId: lastMessageId,
        sentAt,
        errorMessage: null,
      };
    } catch (err) {
      return {
        success: false,
        messageId: null,
        sentAt,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Checks whether the Discord webhook is reachable.
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.webhookUrl.startsWith("https://discord.com/api/webhooks/")) {
        console.warn(
          "[DiscordNotificationAdapter] Invalid Discord webhook URL prefix.",
        );
        return false;
      }

      const response = await fetch(this.webhookUrl);
      if (!response.ok) {
        console.warn(
          `[DiscordNotificationAdapter] Webhook URL ping returned status: ${response.status}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      console.warn("[DiscordNotificationAdapter] Health check error:", err);
      return false;
    }
  }

  /** @deprecated Use DiscordBotAdapter. Stub to satisfy INotification. */
  sendMfaPrompt(): Promise<void> { return Promise.resolve(); }

  /** @deprecated Use DiscordBotAdapter. Stub to satisfy INotification. */
  sendMfaCode(_code: string): Promise<void> { return Promise.resolve(); }

  /** @deprecated Use DiscordBotAdapter. Stub to satisfy INotification. */
  waitForMfaReady(_timeoutMs?: number): Promise<void> { return Promise.resolve(); }

  /** @deprecated Use DiscordBotAdapter. Stub to satisfy INotification. */
  sendError(_message: string, _screenshot?: Buffer): Promise<void> { return Promise.resolve(); }

  /** @deprecated Use DiscordBotAdapter. Stub to satisfy INotification. */
  markMfaSuccess(): Promise<void> { return Promise.resolve(); }

  /** @deprecated Use DiscordBotAdapter. Stub to satisfy INotification. */
  updateStatus(_status: {
    isRunning?: boolean;
    lastRunAt?: Date;
    lastError?: string | null;
    isAuthenticated?: boolean | null;
    isSuspended?: boolean;
  }): void {
    // Stub
  }

  /**
   * Factory helper that reads configuration from environment variables.
   */
  static fromEnv(): DiscordNotificationAdapter {
    const webhookUrl = process.env["DISCORD_WEBHOOK_URL"];
    if (!webhookUrl) {
      throw new Error("Missing DISCORD_WEBHOOK_URL environment variable.");
    }
    return new DiscordNotificationAdapter({ webhookUrl });
  }
}
