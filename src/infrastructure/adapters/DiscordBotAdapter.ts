/**
 * src/infrastructure/adapters/DiscordBotAdapter.ts
 *
 * SECONDARY ADAPTER — Driven side.
 * Implements INotification using a discord.js v14 bot (not a webhook).
 * Supports button interactions for:
 *   - MFA login flow (user confirms readiness, bot shows 2-digit code)
 *   - Quick Apply per offer (triggers postuler() on the scraper)
 *
 * Dependency direction: Infrastructure → Domain (port interfaces only).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  type ButtonInteraction,
  type TextChannel,
  type Message,
  MessageFlags,
} from "discord.js";

import type {
  INotification,
  NotifiablePlacement,
  NotificationOptions,
  NotificationResult,
} from "../../domain/ports/notification.port.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiscordBotConfig {
  readonly botToken: string;
  readonly channelId: string;
  readonly allowedUsers: string[];
  readonly importantTag?: string;
}

/** Injected at runtime so the bot can call postuler() on button click. */
export type PostulerFn = (detailUrl: string, password: string) => Promise<void>;

// ─── Custom ID helpers ────────────────────────────────────────────────────────

const APPLY_PREFIX = "apply:";
const MFA_READY_ID = "mfa_ready";

function makeApplyId(placementId: string): string {
  // Discord custom_id max length is 100 chars
  return `${APPLY_PREFIX}${placementId}`.slice(0, 100);
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class DiscordBotAdapter implements INotification {
  private readonly client: Client;
  private readonly config: DiscordBotConfig;

  /** Resolvers for pending waitForMfaReady() calls */
  private mfaReadyResolvers: Array<() => void> = [];

  /** Injected scraper postuler function + password for quick-apply */
  private postulerFn: PostulerFn | null = null;
  private etsPassword = "";

  /** Internal bot state for the !status command */
  private botStatus = {
    isRunning: false,
    lastRunAt: undefined as Date | undefined,
    lastError: null as string | null,
    isAuthenticated: null as boolean | null,
  };

  /** Callback and cooldown for manual !auth command */
  private authCommandCallback?: (forceAuth: boolean, skipScrape: boolean) => void;
  private lastAuthTime = 0;
  
  /** Stores the last MFA code message sent to react to it upon success */
  private lastMfaMessage: Message | null = null;

  constructor(config: DiscordBotConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on("interactionCreate", (interaction) => {
      if (!interaction.isButton()) return;
      
      if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(interaction.user.id)) {
        void interaction.reply({
          content: "❌ Vous n'êtes pas autorisé à interagir avec ce bot.",
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      void this.handleButtonInteraction(interaction);
    });

    this.client.on("messageCreate", (message) => {
      if (message.author.bot) return;

      if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(message.author.id)) {
        return; // Ignore silently to prevent spam
      }

      const content = message.content.trim();
      if (content === "!status") {
        void this.handleStatusCommand(message);
      } else if (content === "!auth" || content === "!run") {
        void this.handleAuthCommand(message);
      } else if (content === "!help") {
        void this.handleHelpCommand(message);
      }
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.client.login(this.config.botToken);
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) { resolve(); return; }
      this.client.once("ready", () => resolve());
    });
    console.log("[DiscordBotAdapter] Bot logged in and ready.");
  }

  async destroy(): Promise<void> {
    await this.client.destroy();
    console.log("[DiscordBotAdapter] Bot destroyed.");
  }

  /**
   * Register a callback to be invoked when the !auth or !run command is received.
   */
  onAuthCommand(callback: (forceAuth: boolean, skipScrape: boolean) => void): void {
    this.authCommandCallback = callback;
  }

  /**
   * Inject the scraper postuler function so the Apply button can trigger it.
   */
  setPostuler(fn: PostulerFn, etsPassword: string): void {
    this.postulerFn = fn;
    this.etsPassword = etsPassword;
  }

  // ─── INotification: sendDigest ─────────────────────────────────────────────

  async sendDigest(
    placements: readonly NotifiablePlacement[],
    _options: NotificationOptions,
  ): Promise<NotificationResult> {
    const sentAt = new Date().toISOString();

    if (placements.length === 0) {
      return { success: true, messageId: null, sentAt, errorMessage: "No placements." };
    }

    try {
      const channel = await this.getChannel();
      const ping = this.config.importantTag ? `${this.config.importantTag} ` : "";

      await channel.send({
        content: `${ping}📢 **FlexPlus: ${placements.length} nouvelle(s) opportunité(s) de stage identifiée(s)!**`,
      });

      let lastMessageId: string | null = null;

      for (const p of placements) {
        const score = p.analysis.relevanceScore;

        let color: number;
        if (score >= 80) color = 0x2ecc71;
        else if (score >= 60) color = 0xf1c40f;
        else color = 0xe74c3c;

        const skillsValue =
          p.analysis.extractedSkills && p.analysis.extractedSkills.length > 0
            ? p.analysis.extractedSkills.join(", ")
            : "Aucune extraite";

        const modeBadge: Record<string, string> = {
          full: "✅ Postulation directe (Flex)",
          external: "🔗 Postulation externe (site employeur)",
          applied: "☑️ Déjà postulé",
          unknown: "❓ Mode inconnu",
        };

        const embed = new EmbedBuilder()
          .setTitle(`[${p.portalId}] ${p.title}`)
          .setURL(p.detailUrl)
          .setColor(color)
          .setDescription(
            `*${p.analysis.summary || "Aucun résumé généré."}*\n\n` +
            `**Mode:** ${modeBadge[p.applicationMode] ?? modeBadge["unknown"]}`,
          )
          .addFields(
            { name: "🏢 Employeur", value: p.organisation || "Non spécifié", inline: true },
            { name: "📍 Lieu", value: p.location || "Non spécifié", inline: true },
            { name: "📅 Date limite", value: p.deadlineDate || "Non spécifiée", inline: true },
            { name: "🛠️ Compétences clés", value: skillsValue, inline: false },
          )
          .setFooter({ text: `Score de pertinence: ${score}/100` });

        const row = new ActionRowBuilder<ButtonBuilder>();

        if (p.applicationMode === "full") {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(makeApplyId(p.id))
              .setLabel("⚡ Postuler")
              .setStyle(ButtonStyle.Success),
          );
        }

        // Always add a link to view the offer
        if (p.applicationMode === "external" || p.applicationMode === "unknown") {
          row.addComponents(
            new ButtonBuilder()
              .setLabel("🔗 Voir / Postuler sur le site")
              .setStyle(ButtonStyle.Link)
              .setURL(p.detailUrl),
          );
        } else {
          row.addComponents(
            new ButtonBuilder()
              .setLabel("👁️ Voir l'offre")
              .setStyle(ButtonStyle.Link)
              .setURL(p.detailUrl),
          );
        }

        const msg = await channel.send({
          embeds: [embed],
          components: row.components.length > 0 ? [row] : [],
        });

        lastMessageId = msg.id;
      }

      return { success: true, messageId: lastMessageId, sentAt, errorMessage: null };
    } catch (err) {
      return {
        success: false,
        messageId: null,
        sentAt,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ─── INotification: sendMfaPrompt ──────────────────────────────────────────

  async sendMfaPrompt(): Promise<void> {
    const channel = await this.getChannel();
    const ping = this.config.importantTag ? `${this.config.importantTag} ` : "";
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(MFA_READY_ID)
        .setLabel("✅ Prêt pour le MFA")
        .setStyle(ButtonStyle.Primary),
    );
    await channel.send({
      content:
        `${ping}⚠️ **Session ETS expirée!**\n` +
        "Cliquez sur le bouton ci-dessous quand vous êtes prêt à approuver le MFA sur votre téléphone.",
      components: [row],
    });
  }

  // ─── INotification: sendMfaCode ────────────────────────────────────────────

  async sendMfaCode(code: string): Promise<void> {
    const channel = await this.getChannel();
    this.lastMfaMessage = await channel.send({
      content:
        `🔐 **Code MFA Microsoft: \`${code}\`**\n` +
        `Approuvez le chiffre **${code}** dans l'application Microsoft Authenticator.`,
    });
  }

  // ─── INotification: markMfaSuccess ─────────────────────────────────────────

  async markMfaSuccess(): Promise<void> {
    if (this.lastMfaMessage) {
      await this.lastMfaMessage.react('✅').catch(() => {});
      this.lastMfaMessage = null;
    }
  }

  // ─── INotification: waitForMfaReady ────────────────────────────────────────

  waitForMfaReady(timeoutMs = 300_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.mfaReadyResolvers = this.mfaReadyResolvers.filter((r) => r !== resolve);
        reject(new Error("MFA ready timeout: user did not respond in time."));
      }, timeoutMs);

      const resolver = () => {
        clearTimeout(timer);
        resolve();
      };

      this.mfaReadyResolvers.push(resolver);
    });
  }

  // ─── INotification: updateStatus ───────────────────────────────────────────

  updateStatus(status: { isRunning?: boolean, lastRunAt?: Date, lastError?: string | null, isAuthenticated?: boolean | null }): void {
    if (status.isRunning !== undefined) this.botStatus.isRunning = status.isRunning;
    if (status.lastRunAt !== undefined) this.botStatus.lastRunAt = status.lastRunAt;
    if (status.lastError !== undefined) this.botStatus.lastError = status.lastError;
    if (status.isAuthenticated !== undefined) this.botStatus.isAuthenticated = status.isAuthenticated;
  }

  // ─── INotification: sendError ──────────────────────────────────────────────

  async sendError(message: string): Promise<void> {
    try {
      const channel = await this.getChannel();
      const ping = this.config.importantTag ? `${this.config.importantTag} ` : "";
      await channel.send({
        content: `${ping}🚨 **Alerte FlexPlus:**\n${message}`,
      });
    } catch (err) {
      console.error("[DiscordBotAdapter] Failed to send error message to Discord:", err);
    }
  }

  // ─── INotification: healthCheck ────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const channel = await this.getChannel();
      return channel !== null;
    } catch {
      return false;
    }
  }

  // ─── Private: message command handler ──────────────────────────────────────

  private async handleStatusCommand(message: { reply: (content: string) => Promise<unknown> }): Promise<void> {
    const statusText = this.botStatus.isRunning ? "🟢 En cours d'exécution (Scraping...)" : "💤 En veille (Attente du prochain run ou MFA)";
    const lastRunText = this.botStatus.lastRunAt ? this.botStatus.lastRunAt.toLocaleString("fr-CA") : "Jamais";
    
    let authText = "⚪ Inconnu";
    if (this.botStatus.isAuthenticated === true) authText = "✅ Connecté (Cookie valide)";
    else if (this.botStatus.isAuthenticated === false) authText = "❌ Déconnecté (MFA requis)";
    
    const errorText = this.botStatus.lastError ? `\n⚠️ **Dernière erreur:** ${this.botStatus.lastError}` : "";

    await message.reply(
      `**Status FlexPlus Scraper:**\n` +
      `**État:** ${statusText}\n` +
      `**Authentification:** ${authText}\n` +
      `**Dernier run:** ${lastRunText}` +
      errorText
    ).catch(() => {});
  }

  private async handleHelpCommand(message: { reply: (content: string) => Promise<unknown> }): Promise<void> {
    const helpText = 
      "**🛠️ Commandes FlexPlus Scraper:**\n" +
      "• `!status` : Affiche l'état actuel du scraper (en cours, en veille, dernière erreur) et l'état de la connexion ETS.\n" +
      "• `!run` : Démarre manuellement un cycle de scraping sans attendre le prochain déclenchement.\n" +
      "• `!auth` : Force la ré-authentification (efface les cookies et relance le processus MFA).\n" +
      "• `!help` : Affiche ce message d'aide.";
    
    await message.reply(helpText).catch(() => {});
  }

  private async handleAuthCommand(message: { reply: (content: string) => Promise<unknown>, content: string }): Promise<void> {
    if (!this.authCommandCallback) {
      await message.reply("⚠️ La commande n'est pas configurée dans ce mode.").catch(() => {});
      return;
    }

    if (this.botStatus.isRunning) {
      await message.reply("⏳ Une exécution est déjà en cours. Veuillez patienter.").catch(() => {});
      return;
    }

    const now = Date.now();
    const cooldownMs = 60_000; // 1 minute cooldown
    if (now - this.lastAuthTime < cooldownMs) {
      const remainingSec = Math.ceil((cooldownMs - (now - this.lastAuthTime)) / 1000);
      await message.reply(`🛑 Veuillez patienter **${remainingSec} secondes** avant de relancer une commande.`).catch(() => {});
      return;
    }

    this.lastAuthTime = now;
    const isAuth = message.content.trim() === "!auth";

    if (isAuth) {
      await message.reply("🚀 Démarrage d'une ré-authentification forcée (Effacement des cookies et MFA)...").catch(() => {});
    } else {
      await message.reply("🚀 Démarrage manuel d'une vérification de session / scraping...").catch(() => {});
    }
    
    // Invoke the callback asynchronously so it doesn't block
    setImmediate(() => {
      if (this.authCommandCallback) this.authCommandCallback(isAuth, isAuth);
    });
  }

  // ─── Private: button interaction handler ───────────────────────────────────

  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const { customId } = interaction;

    if (customId === MFA_READY_ID) {
      await interaction.reply({
        content: "✅ Reçu! Le scraper va maintenant tenter de se connecter...",
        flags: [MessageFlags.Ephemeral],
      });
      for (const resolve of this.mfaReadyResolvers) resolve();
      this.mfaReadyResolvers = [];
      return;
    }

    if (customId.startsWith(APPLY_PREFIX)) {
      if (!this.postulerFn) {
        await interaction.reply({
          content: "❌ Postulation non disponible: le scraper n'est pas initialisé.",
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      const detailUrl = interaction.message.embeds[0]?.url ?? "";

      if (!detailUrl) {
        await interaction.editReply("❌ Impossible de trouver l'URL du poste.");
        return;
      }

      try {
        await this.postulerFn(detailUrl, this.etsPassword);
        await interaction.editReply(`✅ **Postulation soumise avec succès!**\n${detailUrl}`);
        await interaction.message.react("✅").catch(() => {});

        // Disable the Apply button on the original message
        const originalRow = interaction.message.components[0];
        if (originalRow) {
          // Cast the raw component data to work around discord.js TopLevelComponent type limitations
          const rawComponents = (originalRow as unknown as { components: { type: number; customId?: string; label?: string; style: number; url?: string; disabled?: boolean }[] }).components;
          const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            rawComponents.map((c) => {
              const btn = new ButtonBuilder().setStyle(c.style);
              if (c.url) {
                btn.setURL(c.url).setLabel(c.label ?? "Link");
              } else {
                btn.setCustomId(c.customId ?? "unknown").setLabel(c.label ?? "Button");
                if (c.customId === customId) {
                  btn.setLabel("☑️ Postulé").setDisabled(true).setStyle(ButtonStyle.Secondary);
                }
              }
              return btn;
            }),
          );
          await interaction.message.edit({ components: [disabledRow] }).catch(() => {});
        }
      } catch (err) {
        await interaction.editReply(
          `❌ Échec de la postulation: ${err instanceof Error ? err.message : String(err)}`,
        );
        await interaction.message.react("❌").catch(() => {});
      }
    }
  }

  // ─── Private: channel getter ───────────────────────────────────────────────

  private async getChannel(): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(this.config.channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel ${this.config.channelId} not found or is not a text channel.`);
    }
    return channel as TextChannel;
  }

  // ─── Static factory ────────────────────────────────────────────────────────

  static fromEnv(): DiscordBotAdapter {
    const botToken = process.env["DISCORD_BOT_TOKEN"];
    if (!botToken) throw new Error("Missing DISCORD_BOT_TOKEN environment variable.");
    const channelId = process.env["DISCORD_CHANNEL_ID"];
    if (!channelId) throw new Error("Missing DISCORD_CHANNEL_ID environment variable.");
    
    const allowedUsersRaw = process.env["DISCORD_ALLOWED_USERS"] ?? "";
    const allowedUsers = allowedUsersRaw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    const importantTagRaw = process.env["DISCORD_IMPORTANT_TAG"];
    const importantTag = importantTagRaw ? importantTagRaw.trim() : undefined;

    return new DiscordBotAdapter({
      botToken,
      channelId,
      allowedUsers,
      ...(importantTag ? { importantTag } : {})
    });
  }
}
