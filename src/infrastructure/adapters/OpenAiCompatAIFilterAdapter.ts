/**
 * src/infrastructure/adapters/OpenAiCompatAIFilterAdapter.ts
 *
 * SECONDARY ADAPTER — Driven side.
 * Implements IAIFilter using any OpenAI-compatible chat completion API.
 *
 * Works out-of-the-box with:
 *   • Google Gemini  → baseURL=https://generativelanguage.googleapis.com/v1beta/openai/
 *   • OpenAI         → baseURL=https://api.openai.com/v1  (default openai SDK)
 *   • Groq           → baseURL=https://api.groq.com/openai/v1
 *   • Mistral        → baseURL=https://api.mistral.ai/v1
 *   • OpenRouter     → baseURL=https://openrouter.ai/api/v1
 *   • Ollama (local) → baseURL=http://localhost:11434/v1  apiKey="ollama"
 *
 * All configuration is via environment variables — no code change needed
 * to switch providers.
 *
 * Dependency direction: Infrastructure → Domain (port interfaces only).
 */

import OpenAI from "openai";

import type {
  BatchAnalysisOptions,
  BatchAnalysisResult,
  IAIFilter,
  PlacementAnalysisResult,
  PlacementForAnalysis,
} from "../../domain/ports/ai-filter.port.js";
import type { StoredPlacement } from "../../domain/ports/placement-repository.port.js";

// ─── Provider presets ─────────────────────────────────────────────────────────

/**
 * Predefined base URLs for common providers.
 * Used as the default when AI_BASE_URL is not set but AI_PROVIDER matches.
 */
const PROVIDER_BASE_URLS: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  gemini: "gemini-3.5-flash",
  openai: "gpt-4o-mini",
  groq: "llama-3.1-8b-instant",
  mistral: "mistral-small-latest",
  openrouter: "google/gemini-flash-1.5",
  ollama: "llama3.2",
};

// ─── Structured output schema ─────────────────────────────────────────────────

/**
 * JSON Schema for the AI's response.
 * We use JSON mode (response_format: json_object) + explicit schema in the
 * system prompt to get reliable structured output from any provider.
 */
const RESPONSE_SCHEMA = `
{
  "analyses": [
    {
      "placementId": "string (echo back the id field exactly)",
      "relevanceScore": "integer 0-100",
      "summary": "1-3 sentences in French or English explaining the score",
      "extractedSkills": ["string", "..."]
    }
  ]
}
`;

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildSystemPrompt(
  candidateProfile: string,
  customPrompt?: string,
): string {
  const customInstructionsBlock = customPrompt
    ? `\nCRITICAL ACCEPTANCE/REJECTION CRITERIA:\n${customPrompt}\n`
    : "";

  return `You are a placement opportunity analyser for an engineering student at ETS (École de technologie supérieure) in Montréal.

Your task is to score each internship/job posting for relevance to the candidate and extract key skills.

CANDIDATE PROFILE:
${candidateProfile}
${customInstructionsBlock}
SCORING RUBRIC:
• 80-100: Excellent match — aligns strongly with skills, location preference, and career goals
• 60-79:  Good match — partial skill overlap or minor mismatches
• 40-59:  Possible match — some tangential relevance
• 20-39:  Poor match — few relevant aspects
• 0-19:   Not relevant — completely mismatched

OUTPUT FORMAT — respond ONLY with valid JSON matching this schema exactly:
${RESPONSE_SCHEMA}

RULES:
- Echo back each placementId exactly as given — do NOT modify it
- relevanceScore must be an integer between 0 and 100
- summary must be 3–4 sentences (max 600 characters) describing the position as a neutral job-description snippet: (1) what the role does and its main tasks, (2) the required prerequisites / qualifications, (3) the primary tech stack or domain. Do NOT comment on the candidate's fit or say "this is a great match".
- extractedSkills: list only concrete technical skills / tools (e.g. "Python", "React", "AWS"); empty array if none
- Do NOT wrap in markdown code fences — raw JSON only`;
}

function buildUserMessage(placements: readonly PlacementForAnalysis[]): string {
  const items = placements
    .map(
      (p, i) =>
        `--- Posting ${i + 1} ---
id: ${p.id}
title: ${p.title}
organisation: ${p.organisation}
location: ${p.location}
description:
${stripHtml(p.descriptionHtml)}`,
    )
    .join("\n\n");

  return `Analyse the following ${placements.length} internship/job posting(s) and return your JSON response:\n\n${items}`;
}

// ─── HTML stripper ────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<dt>/gi, "\n• ")
    .replace(/<\/dt>/gi, ": ")
    .replace(/<dd>/gi, "")
    .replace(/<\/dd>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Response parser ──────────────────────────────────────────────────────────

interface RawAnalysis {
  placementId: string;
  relevanceScore: number;
  summary: string;
  extractedSkills: string[];
}

interface RawResponse {
  analyses: RawAnalysis[];
}

function parseAiResponse(
  content: string,
  expectedIds: Set<string>,
): {
  results: PlacementAnalysisResult[];
  failed: { placementId: string; reason: string }[];
} {
  // Strip markdown fences if a provider wraps despite instructions
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: RawResponse;
  try {
    parsed = JSON.parse(cleaned) as RawResponse;
  } catch {
    // Return everything as failed
    return {
      results: [],
      failed: Array.from(expectedIds).map((id) => ({
        placementId: id,
        reason: `JSON parse error: ${cleaned.slice(0, 200)}`,
      })),
    };
  }

  if (!Array.isArray(parsed?.analyses)) {
    return {
      results: [],
      failed: Array.from(expectedIds).map((id) => ({
        placementId: id,
        reason: 'Response missing "analyses" array',
      })),
    };
  }

  const results: PlacementAnalysisResult[] = [];
  const failed: { placementId: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const item of parsed.analyses) {
    if (!item.placementId || !expectedIds.has(item.placementId)) {
      failed.push({
        placementId: item.placementId ?? "unknown",
        reason: `Unknown or missing placementId in response: ${item.placementId}`,
      });
      continue;
    }

    const score = Number(item.relevanceScore);
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      failed.push({
        placementId: item.placementId,
        reason: `Invalid relevanceScore: ${item.relevanceScore}`,
      });
      continue;
    }

    results.push({
      placementId: item.placementId,
      relevanceScore: score,
      summary: String(item.summary ?? "").trim(),
      extractedSkills: Array.isArray(item.extractedSkills)
        ? item.extractedSkills.map(String)
        : [],
    });

    seen.add(item.placementId);
  }

  // Any expected IDs the AI didn't include in its response
  for (const id of expectedIds) {
    if (!seen.has(id)) {
      failed.push({
        placementId: id,
        reason: "AI did not return an analysis for this placement",
      });
    }
  }

  return { results, failed };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AIFilterConfig {
  /**
   * Base URL of the OpenAI-compatible endpoint.
   * Env var: AI_BASE_URL
   */
  readonly baseUrl: string;

  /**
   * API key.
   * Env var: AI_API_KEY  (or GEMINI_API_KEY for backwards compat)
   */
  readonly apiKey: string;

  /**
   * Model identifier understood by the provider.
   * Env var: AI_MODEL
   * Default: gemini-3.5-flash  (when provider=gemini)
   */
  readonly model: string;

  /**
   * Max placements per single API call.
   * Larger batches = fewer calls but higher risk of truncation.
   * Env var: AI_BATCH_SIZE  (default: 10)
   */
  readonly batchSize: number;

  /**
   * Temperature for generation (0 = deterministic).
   * Env var: AI_TEMPERATURE  (default: 0)
   */
  readonly temperature: number;

  /**
   * Optional backup API configuration.
   */
  readonly backup?: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
  } | undefined;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/**
 * OpenAiCompatAIFilterAdapter
 *
 * Uses the `openai` npm package pointed at any OpenAI-compatible endpoint.
 * Batches placements into chunks, sends one request per chunk, and merges
 * results. Uses JSON mode + schema in the system prompt for reliable output.
 */
export class OpenAiCompatAIFilterAdapter implements IAIFilter {
  private readonly client: OpenAI;
  private readonly backupClient?: OpenAI;

  constructor(private readonly config: AIFilterConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      timeout: 90_000,
      maxRetries: 1,
    });
    
    if (config.backup) {
      this.backupClient = new OpenAI({
        baseURL: config.backup.baseUrl,
        apiKey: config.backup.apiKey,
        timeout: 90_000,
        maxRetries: 1,
      });
    }
  }

  // ─── IAIFilter: analyseBatch ───────────────────────────────────────────────

  async analyseBatch(
    placements: readonly PlacementForAnalysis[],
    options: BatchAnalysisOptions,
  ): Promise<BatchAnalysisResult> {
    if (placements.length === 0) {
      return {
        results: [],
        failed: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
      };
    }

    const allResults: PlacementAnalysisResult[] = [];
    const allFailed: { placementId: string; reason: string }[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Split into chunks of batchSize
    const chunks = chunkArray([...placements], this.config.batchSize);

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      if (!chunk) continue;
      const expectedIds = new Set(chunk.map((p) => p.id));

      console.log(`[AIFilter] Batch ${ci + 1}/${chunks.length} — analysing ${chunk.length} placements...`);
      
      let attempt = 0;
      let success = false;
      let lastError: unknown = null;
      let usingBackup = false;

      while (attempt < 4 && !success) { // Up to 4 attempts total
        const startTime = Date.now();
        try {
          const activeClient = usingBackup && this.backupClient ? this.backupClient : this.client;
          const activeModel = usingBackup && this.config.backup ? this.config.backup.model : this.config.model;

          const response = await activeClient.chat.completions.create({
            model: activeModel,
            temperature: this.config.temperature,
            // Request JSON output (supported by all major providers)
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: buildSystemPrompt(
                  options.candidateProfile,
                  options.customPrompt,
                ),
              },
              {
                role: "user",
                content: buildUserMessage(chunk),
              },
            ],
          });
          console.log(`[AIFilter] Batch ${ci + 1}/${chunks.length} — done (attempt ${attempt + 1}${usingBackup ? ' using backup' : ''}).`);

          totalInputTokens += response.usage?.prompt_tokens ?? 0;
          totalOutputTokens += response.usage?.completion_tokens ?? 0;

          const content = response.choices[0]?.message?.content ?? "";
          const { results, failed } = parseAiResponse(content, expectedIds);

          allResults.push(...results);
          allFailed.push(...failed);
          success = true;
        } catch (err) {
          const elapsed = Date.now() - startTime;
          attempt++;
          lastError = err;
          console.warn(`[AIFilter] Batch ${ci + 1} attempt ${attempt} failed (took ${Math.round(elapsed / 1000)}s): ${err instanceof Error ? err.message : String(err)}`);
          
          if (attempt < 4) {
            if (this.backupClient) {
              if (attempt === 1) {
                // First attempt failed. If it took >30s, immediately switch to backup.
                if (elapsed > 30000) {
                  console.log(`[AIFilter] First attempt took over 30s. Switching to backup model immediately.`);
                  usingBackup = true;
                }
              } else {
                // Subsequent failures: bounce back and forth between primary and backup
                usingBackup = !usingBackup;
                const nextModel = usingBackup ? (this.config.backup?.model ?? "backup") : this.config.model;
                console.log(`[AIFilter] Alternating API for next attempt. Switching to: ${nextModel}`);
              }
            } else {
              // No backup client configured, always use primary
              usingBackup = false;
            }

            // Wait briefly before retrying
            await new Promise(res => setTimeout(res, 2000));
          }
        }
      }

      if (!success) {
        // API call failed for all attempts — mark all as failed
        const reason = lastError instanceof Error ? lastError.message : String(lastError);
        for (const id of expectedIds) {
          allFailed.push({ placementId: id, reason: `Max retries reached: ${reason}` });
        }
      }
    }

    return {
      results: allResults,
      failed: allFailed,
      totalInputTokens,
      totalOutputTokens,
    };
  }

  // ─── IAIFilter: toAnalysisInput ────────────────────────────────────────────

  toAnalysisInput(placement: StoredPlacement): PlacementForAnalysis {
    return {
      id: placement.id,
      title: placement.title,
      organisation: placement.organisation,
      location: placement.location,
      descriptionHtml: placement.descriptionHtml,
    };
  }

  // ─── Static factory ────────────────────────────────────────────────────────

  /**
   * Builds an adapter from environment variables.
   *
   * Provider selection:
   *   Set AI_PROVIDER to one of: gemini | openai | groq | mistral | openrouter | ollama
   *   OR set AI_BASE_URL + AI_API_KEY + AI_MODEL explicitly.
   *
   * Environment variables:
   *   AI_PROVIDER      — shorthand provider name (optional, default: gemini)
   *   AI_BASE_URL      — full base URL (overrides AI_PROVIDER)
   *   AI_API_KEY       — API key (also accepts GEMINI_API_KEY as fallback)
   *   AI_MODEL         — model name (overrides provider default)
   *   AI_BATCH_SIZE    — placements per API call (default: 10)
   *   AI_TEMPERATURE   — generation temperature (default: 0)
   */
  static fromEnv(): OpenAiCompatAIFilterAdapter {
    const provider = (process.env["AI_PROVIDER"] ?? "gemini").toLowerCase();

    const baseUrl =
      process.env["AI_BASE_URL"] ??
      PROVIDER_BASE_URLS[provider] ??
      PROVIDER_BASE_URLS["gemini"] ??
      "https://generativelanguage.googleapis.com/v1beta/openai/";

    // Accept GEMINI_API_KEY for backwards compat with .env.example
    const apiKey =
      process.env["AI_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "";

    if (!apiKey && provider !== "ollama") {
      throw new Error(
        "Missing AI API key. Set AI_API_KEY (or GEMINI_API_KEY for Gemini).",
      );
    }

    const model =
      process.env["AI_MODEL"] ??
      DEFAULT_PROVIDER_MODELS[provider] ??
      "gemini-3.5-flash";

    const batchSize = parseInt(process.env["AI_BATCH_SIZE"] ?? "10", 10);
    const temperature = parseFloat(process.env["AI_TEMPERATURE"] ?? "0");

    let backup: AIFilterConfig["backup"] = undefined;
    const backupApiKey = process.env["AI_BACKUP_API_KEY"];
    if (backupApiKey) {
      const backupProvider = (process.env["AI_BACKUP_PROVIDER"] ?? "openai").toLowerCase();
      const backupBaseUrl =
        process.env["AI_BACKUP_BASE_URL"] ??
        PROVIDER_BASE_URLS[backupProvider] ??
        PROVIDER_BASE_URLS["openai"] ??
        "https://api.openai.com/v1";
      const backupModel =
        process.env["AI_BACKUP_MODEL"] ??
        DEFAULT_PROVIDER_MODELS[backupProvider] ??
        "gpt-4o-mini";

      backup = {
        baseUrl: backupBaseUrl,
        apiKey: backupApiKey,
        model: backupModel,
      };
    }

    return new OpenAiCompatAIFilterAdapter({
      baseUrl,
      apiKey: apiKey || "ollama", // ollama doesn't need a real key
      model,
      batchSize,
      temperature,
      backup,
    });
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
