/**
 * src/application/use-cases/ScrapeAndFilterUseCase.ts
 *
 * APPLICATION LAYER USE CASE
 * Coordinates the primary (driving) port and secondary (driven) ports to:
 *   1. Scrape the ETS SEE portal.
 *   2. Persist raw scraped postings in SQLite.
 *   3. Identify new postings that need AI relevance scoring.
 *   4. Perform batch AI scoring & summary generation.
 *   5. Retrieve all high-relevance unnotified postings.
 *   6. Send a single aggregated digest email.
 *   7. Mark notified postings in the database.
 */

import type { IEtsScraper, ScraperOptions, RawPlacementListing } from "../../domain/ports/scraper.port.js";
import type { IPlacementRepository } from "../../domain/ports/placement-repository.port.js";
import type { IAIFilter } from "../../domain/ports/ai-filter.port.js";
import type { INotification, NotifiablePlacement } from "../../domain/ports/notification.port.js";

export interface UseCaseConfig {
  readonly candidateProfile: string;
  readonly relevanceThreshold: number;
  readonly fromEmail?: string | undefined;
  readonly toEmails?: readonly string[] | undefined;
  readonly allowedLocations?: readonly string[] | undefined;
  readonly excludedLocations?: readonly string[] | undefined;
  readonly excludedKeywords?: readonly string[] | undefined;
  readonly aiCustomPrompt?: string | undefined;
  readonly autoApply?: boolean | undefined;
}

export interface UseCaseResult {
  readonly scrapedCount: number;
  readonly insertedCount: number;
  readonly aiAnalysedCount: number;
  readonly aiFailedCount: number;
  readonly appliedCount: number;
  readonly notifiedCount: number;
  readonly emailSent: boolean;
  readonly emailMessageId: string | null;
  readonly inputTokensUsed: number;
  readonly outputTokensUsed: number;
}

export class ScrapeAndFilterUseCase {
  constructor(
    private readonly scraper: IEtsScraper,
    private readonly repository: IPlacementRepository,
    private readonly aiFilter: IAIFilter,
    private readonly notification: INotification,
  ) {}

  async execute(
    scraperOptions: ScraperOptions,
    config: UseCaseConfig,
  ): Promise<UseCaseResult> {
    console.log("[UseCase] Starting Scrape and Filter execution...");
    
    let scrapedCount = 0;
    let insertedCount = 0;
    let aiAnalysedCount = 0;
    let aiFailedCount = 0;
    let appliedCount = 0;
    let notifiedCount = 0;
    let emailSent = false;
    let emailMessageId: string | null = null;
    let inputTokensUsed = 0;
    let outputTokensUsed = 0;

    try {
      // Get list of existing portal IDs to avoid scraping their detail pages again
      const existingPlacements = await this.repository.findAll();
      const existingPortalIds = existingPlacements.map((p) => p.portalId);

      // 1. Scrape the ETS SEE portal
      console.log("[UseCase] Scraping placements from ETS SEE portal...");
      const scrapeResult = await this.scraper.scrape({
        ...scraperOptions,
        excludePortalIds: existingPortalIds,
      });
      scrapedCount = scrapeResult.nouveauxAffichages.length;
      console.log(`[UseCase] Scraped ${scrapedCount} placements.`);

      // 2. Map & Persist raw scraped postings
      console.log("[UseCase] Persisting raw postings to database...");
      const rawListings: RawPlacementListing[] = scrapeResult.nouveauxAffichages.map((posting) => {
        // Map PosteDetail to RawPlacementListing
        const find = (label: string): string | null => {
          const normalise = (s: string): string => s.toLowerCase().trim();
          return (
            posting.informations.find((i) =>
              normalise(i.label).includes(normalise(label)),
            )?.value ?? null
          );
        };

        const title =
          posting.titrePoste ??
          find("Titre du poste") ??
          find("Titre") ??
          find("titre") ??
          find("intitulé") ??
          posting.numeroPosto;
        const location = find("lieu de travail") ?? find("lieu") ?? find("ville") ?? "";
        const deadlineDate = find("date limite") ?? find("date de clôture");
        
        const infoTableHtml =
          "<dl>" +
          posting.informations
            .map((pair) => `<dt>${pair.label}</dt><dd>${pair.value}</dd>`)
            .join("") +
          "</dl>";

        const descriptionHtml = `
          <div>
            <h4>Informations générales</h4>
            ${infoTableHtml}
            <h4>Description du stage & Mission</h4>
            <div>${posting.descriptionHtml}</div>
          </div>
        `;

        return {
          portalId: posting.numeroPosto,
          title: title.trim(),
          organisation: posting.nomEmployeur,
          location,
          deadlineDate,
          descriptionHtml,
          detailUrl: posting.detailUrl,
          scrapedAt: new Date().toISOString(),
          applicationMode: posting.applicationMode,
        };
      });

      insertedCount = await this.repository.upsertMany(rawListings);
      console.log(`[UseCase] Persisted raw postings. ${insertedCount} new placements inserted.`);

      // 3. Find postings that need AI scoring (relevanceScore IS NULL)
      console.log("[UseCase] Finding placements awaiting AI analysis...");
      const allPlacements = await this.repository.findAll();
      const pendingPlacements = allPlacements.filter((p) => p.relevanceScore === null);
      console.log(`[UseCase] Found ${pendingPlacements.length} placements awaiting AI analysis.`);

      // 3.5 Local Deterministic Pre-Filtering (Step 1)
      const placementsForAi: typeof pendingPlacements = [];
      let locallyRejectedCount = 0;

      for (const p of pendingPlacements) {
        let failsFilter = false;
        let reason = "";

        const locationLower = (p.location || "").toLowerCase().trim();
        const titleLower = (p.title || "").toLowerCase().trim();

        // 1. Allowed locations check
        if (config.allowedLocations && config.allowedLocations.length > 0) {
          const isAllowed = config.allowedLocations.some((loc) =>
            locationLower.includes(loc.toLowerCase().trim()),
          );
          if (!isAllowed) {
            failsFilter = true;
            reason = `Location '${p.location}' is not in the allowed list`;
          }
        }

        // 2. Excluded locations check
        if (!failsFilter && config.excludedLocations && config.excludedLocations.length > 0) {
          const isExcluded = config.excludedLocations.some((loc) =>
            locationLower.includes(loc.toLowerCase().trim()),
          );
          if (isExcluded) {
            failsFilter = true;
            reason = `Location '${p.location}' is explicitly excluded`;
          }
        }

        // 3. Excluded keywords check
        if (!failsFilter && config.excludedKeywords && config.excludedKeywords.length > 0) {
          const matchesExcludedKeyword = config.excludedKeywords.some((word) =>
            titleLower.includes(word.toLowerCase().trim()),
          );
          if (matchesExcludedKeyword) {
            failsFilter = true;
            reason = `Title '${p.title}' contains excluded keyword`;
          }
        }

        if (failsFilter) {
          console.log(`[UseCase] Local pre-filter rejected placement ${p.portalId}: ${reason}`);
          await this.repository.updateAiMetadata(p.id, {
            relevanceScore: 0,
            aiSummary: `Pre-filtered locally: ${reason}.`,
          });
          locallyRejectedCount++;
        } else {
          placementsForAi.push(p);
        }
      }

      if (locallyRejectedCount > 0) {
        console.log(`[UseCase] Local pre-filter rejected ${locallyRejectedCount} placements.`);
      }

      // 4. Batch AI scoring (Step 2)
      if (placementsForAi.length > 0) {
        console.log(`[UseCase] Running batch AI analysis for ${placementsForAi.length} placements...`);
        const analysisInputs = placementsForAi.map((p) => this.aiFilter.toAnalysisInput(p));
        
        const aiResult = await this.aiFilter.analyseBatch(analysisInputs, {
          candidateProfile: config.candidateProfile,
          relevanceThreshold: config.relevanceThreshold,
          customPrompt: config.aiCustomPrompt,
        });

        inputTokensUsed = aiResult.totalInputTokens;
        outputTokensUsed = aiResult.totalOutputTokens;
        aiAnalysedCount = aiResult.results.length;
        aiFailedCount = aiResult.failed.length;

        // Update database with AI analysis results
        console.log("[UseCase] Updating database with AI analysis metadata...");
        for (const item of aiResult.results) {
          await this.repository.updateAiMetadata(item.placementId, {
            relevanceScore: item.relevanceScore,
            aiSummary: item.summary,
            extractedSkills: [...item.extractedSkills],
          });
        }

        if (aiResult.failed.length > 0) {
          console.warn(`[UseCase] AI analysis failed for ${aiResult.failed.length} placements:`);
          for (const fail of aiResult.failed) {
            console.warn(`  - ID ${fail.placementId}: ${fail.reason}`);
          }
        }
      }

      // 4.5 Auto-postulation for newly found high-relevance unapplied listings (Step 3 - optional)
      if (config.autoApply === true) {
        console.log("[UseCase] Checking for new high-relevance unapplied placements to auto-apply...");
        const unappliedPlacements = await this.repository.findAll({
          unappliedOnly: true,
          minRelevanceScore: config.relevanceThreshold,
        });

        if (unappliedPlacements.length > 0) {
          console.log(`[UseCase] Found ${unappliedPlacements.length} high-relevance unapplied placements. Initiating auto-postulation...`);
          for (const p of unappliedPlacements) {
            try {
              console.log(`[UseCase] Attempting auto-postulation for: ${p.portalId} - ${p.title}`);
              await this.scraper.postuler(p.detailUrl, scraperOptions.credentials.password);
              await this.repository.markApplied(p.id);
              appliedCount++;
              console.log(`[UseCase] Auto-postulation successful for ${p.portalId}.`);
            } catch (err) {
              console.error(`[UseCase] Auto-postulation failed for ${p.portalId}:`, err);
            }
          }
        }
      } else {
        console.log("[UseCase] Auto-postulation is disabled. Skipping auto-apply.");
      }

      // 5. Retrieve high-relevance unnotified postings
      console.log("[UseCase] Querying high-relevance unnotified placements...");
      const matches = await this.repository.findAll({
        unnotifiedOnly: true,
        minRelevanceScore: config.relevanceThreshold,
      });
      console.log(`[UseCase] Found ${matches.length} high-relevance unnotified placements.`);

      // 6. Send digest notification
      if (matches.length > 0) {
        console.log(`[UseCase] Sending digest notification for ${matches.length} placements...`);
        
        const notifiablePlacements: NotifiablePlacement[] = matches.map((p) => ({
          id: p.id,
          portalId: p.portalId,
          title: p.title,
          organisation: p.organisation,
          location: p.location,
          detailUrl: p.detailUrl,
          deadlineDate: p.deadlineDate,
          applicationMode: p.applicationMode,
          analysis: {
            placementId: p.id,
            relevanceScore: p.relevanceScore ?? 0,
            summary: p.aiSummary ?? "",
            extractedSkills: p.extractedSkills ?? [],
          },
        }));

        const notificationResult = await this.notification.sendDigest(notifiablePlacements, {
          fromEmail: config.fromEmail,
          toEmails: config.toEmails,
        });

        emailSent = notificationResult.success;
        emailMessageId = notificationResult.messageId;

        if (notificationResult.success) {
          console.log(`[UseCase] Digest sent successfully. Message ID: ${emailMessageId}`);
          
          // 7. Mark notified postings in database
          for (const match of matches) {
            await this.repository.markNotificationSent(match.id);
          }
          notifiedCount = matches.length;
        } else {
          console.error(`[UseCase] Failed to send digest email: ${notificationResult.errorMessage}`);
        }
      }

      console.log("[UseCase] Execution finished successfully.");
    } catch (err) {
      console.error("[UseCase] Error during execution:", err);
      throw err;
    }

    return {
      scrapedCount,
      insertedCount,
      aiAnalysedCount,
      aiFailedCount,
      appliedCount,
      notifiedCount,
      emailSent,
      emailMessageId,
      inputTokensUsed,
      outputTokensUsed,
    };
  }
}
