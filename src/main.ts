/**
 * src/main.ts — Entrypoint for FlexPlus Microservice
 *
 * Configures the Dependency Injection container by parsing environment variables,
 * instantiating adapters, and passing them to the application use cases.
 *
 * Commands supported:
 *   • scrape (one-shot): `node --experimental-sqlite dist/main.js scrape`
 *   • daemon (cron-based): `node --experimental-sqlite dist/main.js daemon`
 */

import "dotenv/config";
import cron from "node-cron";

import { PlaywrightEtsAdapter } from "./infrastructure/adapters/PlaywrightEtsAdapter.js";
import { SqlitePlacementRepository } from "./infrastructure/adapters/SqlitePlacementRepository.js";
import { OpenAiCompatAIFilterAdapter } from "./infrastructure/adapters/OpenAiCompatAIFilterAdapter.js";
import { DiscordBotAdapter } from "./infrastructure/adapters/DiscordBotAdapter.js";
import { ScrapeAndFilterUseCase } from "./application/use-cases/ScrapeAndFilterUseCase.js";

import type { IEtsScraper } from "./domain/ports/scraper.port.js";

// ─── Environment & Config Retrieval ──────────────────────────────────────────

const candidateProfile =
  process.env["AI_CANDIDATE_PROFILE"] ??
  "Étudiant en génie logiciel à l'ÉTS, intéressé par les stages en développement backend et architecture logicielle.";

const relevanceThreshold = parseInt(
  process.env["AI_RELEVANCE_THRESHOLD"] ?? "60",
  10,
);

const etsPassword = process.env["ETS_PASSWORD"] ?? "";

const allowedLocationsRaw = process.env["FILTER_ALLOWED_LOCATIONS"] ?? "";
const allowedLocations = allowedLocationsRaw
  ? allowedLocationsRaw
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
  : undefined;

const excludedLocationsRaw = process.env["FILTER_EXCLUDED_LOCATIONS"] ?? "";
const excludedLocations = excludedLocationsRaw
  ? excludedLocationsRaw
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
  : undefined;

const excludedKeywordsRaw = process.env["FILTER_EXCLUDED_KEYWORDS"] ?? "";
const excludedKeywords = excludedKeywordsRaw
  ? excludedKeywordsRaw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
  : undefined;

const aiCustomPrompt = process.env["AI_CUSTOM_PROMPT"] ?? undefined;

const autoApply = process.env["AUTO_APPLY"] === "true";

const scraperCron = process.env["SCRAPER_CRON"] ?? "0 */6 * * *";

const jitterMinSec = Math.max(
  0,
  parseInt(process.env["SCRAPER_JITTER_MIN_SEC"] ?? "0", 10) || 0,
);
const jitterMaxSec = Math.max(
  0,
  parseInt(process.env["SCRAPER_JITTER_MAX_SEC"] ?? "300", 10) || 0,
);

// ─── Execution Logic ──────────────────────────────────────────────────────────

async function runScrapeJob(
  useCase: ScrapeAndFilterUseCase,
  bot: DiscordBotAdapter,
  runOptions: { forceAuth?: boolean; skipScrape?: boolean; retryCount?: number } = {},
): Promise<void> {
  const retryCount = runOptions.retryCount ?? 0;
  const now = new Date();
  console.log(
    `\n=== Starting FlexPlus Scraping Job [${now.toISOString()}] ===`,
  );

  bot.updateStatus({ isRunning: true, lastRunAt: now, lastError: null });

  let scraperAdapter: PlaywrightEtsAdapter | null = null;

  try {
    const { adapter, options } = PlaywrightEtsAdapter.fromEnv();
    scraperAdapter = adapter;

    // Inject the instantiated scraper adapter directly into the use case
    const targetWithScraper = useCase as unknown as {
      scraper: PlaywrightEtsAdapter;
    };
    targetWithScraper.scraper = scraperAdapter;

    if (runOptions.forceAuth) {
      console.log(
        "[FlexPlus] forceAuth requested: clearing session cookies...",
      );
      await scraperAdapter.clearSession();
    }

    // ── MFA flow: check if session is expired ─────────────────────────────
    const loggedOut = await scraperAdapter.isLoggedOut();
    bot.updateStatus({ isAuthenticated: !loggedOut });

    if (loggedOut) {
      console.log(
        "[FlexPlus] Session expired — initiating MFA flow via Discord...",
      );
      await bot.sendMfaPrompt();
      console.log(
        "[FlexPlus] Waiting for user to click 'Prêt pour le MFA' in Discord...",
      );

      // Wait up to 24 hours for user to click the button
      await bot.waitForMfaReady(24 * 60 * 60 * 1000);

      console.log("[FlexPlus] User is ready. Submitting credentials...");

      try {
        await scraperAdapter.authenticate(options.credentials);
        const mfaCode = await scraperAdapter.extractMfaCode(30_000);
        if (mfaCode) {
          console.log(
            `[FlexPlus] MFA code detected: ${mfaCode}. Sending to Discord...`,
          );
          await bot.sendMfaCode(mfaCode);
        } else {
          await bot.sendError(
            "❓ Code non détecté automatiquement — vérifiez votre appli Microsoft Authenticator",
          );
        }

        // Wait for the user to approve the MFA on their phone and the redirect to complete
        await scraperAdapter.waitForLoginComplete();
        await bot.markMfaSuccess();
        bot.updateStatus({ isAuthenticated: true });
      } catch (authErr) {
        const msg =
          authErr instanceof Error ? authErr.message : String(authErr);
        await bot.sendError(`❌ Échec de la connexion ETS: ${msg}`);
        throw authErr;
      }
    }

    if (runOptions.skipScrape) {
      console.log(
        "[FlexPlus] skipScrape requested: aborting scrape job early.",
      );
      bot.updateStatus({
        isRunning: false,
        lastRunAt: now,
        lastError: null,
        isAuthenticated: !loggedOut,
      });
      return;
    }

    if (!scraperAdapter) {
      throw new Error("Scraper adapter not initialized");
    }


    const result = await useCase.execute(options, {
      candidateProfile,
      relevanceThreshold,
      allowedLocations,
      excludedLocations,
      excludedKeywords,
      aiCustomPrompt,
      autoApply,
    });

    console.log("=== Job Results ===");
    console.log(`- Scraped postings from portal: ${result.scrapedCount}`);
    console.log(`- New postings inserted into DB: ${result.insertedCount}`);
    console.log(`- Placements analysed by AI: ${result.aiAnalysedCount}`);
    console.log(`- Placements failed AI analysis: ${result.aiFailedCount}`);
    console.log(`- Auto-applications submitted: ${result.appliedCount}`);
    console.log(
      `- AI Tokens used: Input = ${result.inputTokensUsed}, Output = ${result.outputTokensUsed}`,
    );
    console.log(
      `- Discord notification sent: ${result.emailSent ? "Yes" : "No"}`,
    );
    if (result.emailSent) {
      console.log(`  Message ID: ${result.emailMessageId}`);
      console.log(`  Count of placements notified: ${result.notifiedCount}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "TokenExpiredError") {
      console.warn(`[FlexPlus] Token expired mid-scrape (retry ${retryCount}). Restarting job with forced auth...`);
      bot.updateStatus({ lastError: "Token expired mid-scrape. Restarting authentication." });
      
      // Cleanup previous browser instance
      if (scraperAdapter) {
        await scraperAdapter.dispose().catch(() => {});
        scraperAdapter = null;
      }
      bot.updateStatus({ isRunning: false });

      if (retryCount < 3) {
        return runScrapeJob(useCase, bot, { ...runOptions, forceAuth: true, retryCount: retryCount + 1 });
      } else {
        console.error("[FlexPlus] Max retries reached for token expiration. Aborting.");
      }
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[FlexPlus] Scraper job encountered a fatal error:", err);
    bot.updateStatus({ lastError: errorMsg });

    // Only send error if it wasn't already sent by the MFA catch block
    if (
      !(err instanceof Error) ||
      !err.message.includes("Authentication failed")
    ) {
      let siteIsDown = false;
      let screenshot: Buffer | null = null;
      if (scraperAdapter) {
        try {
          siteIsDown = await scraperAdapter.isSiteDown();
          if (!siteIsDown) {
            screenshot = await scraperAdapter.takeScreenshot();
          }
        } catch (checkErr) {
          console.error(
            "[FlexPlus] Failed to check status/take screenshot:",
            checkErr,
          );
        }
      }

      if (siteIsDown) {
        await bot
          .sendError(
            `⚠️ **Portail ÉTS inaccessible**\nLe portail de placement de l'ÉTS est actuellement hors service (page "Site inaccessible" détectée).`,
          )
          .catch(() => {});
      } else {
        await bot
          .sendError(
            `🚨 **Erreur critique du scraper:**\n\`\`\`text\n${errorMsg}\n\`\`\``,
            screenshot || undefined,
          )
          .catch(() => {});
      }
    }
  } finally {
    if (scraperAdapter) {
      console.log("[FlexPlus] Disposing scraper adapter browser instances...");
      await scraperAdapter
        .dispose()
        .catch((err) =>
          console.error("[FlexPlus] Error disposing scraper adapter:", err),
        );
    }
    bot.updateStatus({ isRunning: false });
    console.log(
      `=== Finished FlexPlus Scraping Job [${new Date().toISOString()}] ===\n`,
    );
  }
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "scrape"; // default to one-shot scrape

  console.log(`[FlexPlus] Initialising adapters (Command: "${command}")...`);

  // Initialize DB, AI, and Notification adapters
  const repository = SqlitePlacementRepository.fromEnv();
  const aiFilter = OpenAiCompatAIFilterAdapter.fromEnv();
  const bot = DiscordBotAdapter.fromEnv();
  await bot.start();

  // Inject a one-off postuler function for quick-apply button handling
  bot.setPostuler(
    async (detailUrl, password) => {
      const { adapter } = PlaywrightEtsAdapter.fromEnv();
      try {
        await adapter.postuler(detailUrl, password);
      } finally {
        await adapter.dispose();
      }
    },
    etsPassword,
  );

  // Wire dependencies into application use case
  const useCase = new ScrapeAndFilterUseCase(
    null as unknown as IEtsScraper,
    repository,
    aiFilter,
    bot,
  );

  // Removed dynamic scraper DI proxy to prevent spawning multiple concurrent browser instances
  // which caused locked user data directories and lost cookies during MFA flows.

  // Graceful shutdown registration
  const shutdown = async (signal: string) => {
    console.log(
      `\n[FlexPlus] Received ${signal}. Starting graceful shutdown...`,
    );
    try {
      console.log("[FlexPlus] Closing SQLite database connection...");
      repository.close();
    } catch (err) {
      console.error("[FlexPlus] Error during DB close:", err);
    }
    await bot.destroy();
    console.log("[FlexPlus] Graceful shutdown complete. Exiting.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (command === "scrape") {
    await runScrapeJob(useCase, bot);
    repository.close();
    await bot.destroy();
    process.exit(0);
  } else if (command === "daemon") {
    console.log(
      `[FlexPlus] Daemon mode active. Scheduling cron with expression: "${scraperCron}"`,
    );
    if (jitterMaxSec > jitterMinSec) {
      console.log(
        `[FlexPlus] Humanisation active: cron runs will be delayed randomly between ${jitterMinSec}s and ${jitterMaxSec}s.`,
      );
    }

    console.log("[FlexPlus] Running startup integration checks...");
    const discordHealth = await bot.healthCheck();
    console.log(
      `- Discord bot health check: ${discordHealth ? "OK" : "FAILED"}`,
    );

    // Register Discord !auth command listener
    bot.onAuthCommand((forceAuth: boolean, skipScrape: boolean) => {
      void runScrapeJob(useCase, bot, { forceAuth, skipScrape }).catch(
        (err) => {
          console.error("[FlexPlus] Error in manual auth run:", err);
        },
      );
    });

    const task = cron.schedule(scraperCron, async () => {
      if (jitterMaxSec > jitterMinSec) {
        const delaySeconds = Math.floor(
          jitterMinSec + Math.random() * (jitterMaxSec - jitterMinSec + 1),
        );
        console.log(
          `[FlexPlus] Cron triggered. Delaying run by ${delaySeconds} seconds for humanisation...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
      }
      await runScrapeJob(useCase, bot);
    });

    bot.onStopCommand(() => {
      console.log("[FlexPlus] Received stop command. Suspending cron task...");
      task.stop();
      bot.updateStatus({ isSuspended: true });
    });

    bot.onStartCommand(() => {
      console.log("[FlexPlus] Received start command. Resuming cron task...");
      task.start();
      bot.updateStatus({ isSuspended: false });
    });

    await runScrapeJob(useCase, bot);

    task.start();
  } else {
    console.error(`[FlexPlus] Unknown command: "${command}"`);
    console.log("Usage:");
    console.log("  node dist/main.js scrape      Run scraper once immediately");
    console.log(
      "  node dist/main.js daemon      Run as a background daemon using SCRAPER_CRON",
    );
    repository.close();
    process.exit(1);
  }
}

// Avoid double-execution when Docker requires this file during HEALTHCHECK
if (process.env.IS_HEALTHCHECK !== "1") {
  main().catch((err) => {
    console.error("[FlexPlus] Startup failure:", err);
    process.exit(1);
  });
}
