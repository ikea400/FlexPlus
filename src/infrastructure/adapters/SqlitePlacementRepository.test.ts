/**
 * src/infrastructure/adapters/SqlitePlacementRepository.test.ts
 *
 * Integration tests for SqlitePlacementRepository.
 * Uses an in-memory database instance to test persistence, deduplication,
 * query filtering, and metadata updates.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SqlitePlacementRepository } from "./SqlitePlacementRepository.js";
import type { RawPlacementListing } from "../../domain/ports/scraper.port.js";

describe("SqlitePlacementRepository", () => {
  let repository: SqlitePlacementRepository;

  beforeEach(() => {
    // ":memory:" creates a fresh, isolated database in RAM for each test.
    repository = new SqlitePlacementRepository(":memory:");
  });

  const sampleListings: RawPlacementListing[] = [
    {
      portalId: "2026-A-0001",
      title: "Backend Engineer Intern",
      organisation: "Acme Corp",
      location: "Montréal, QC",
      deadlineDate: "2026-08-31",
      descriptionHtml: "<dl><dt>Requirements</dt><dd>Node.js, TypeScript</dd></dl>",
      detailUrl: "https://see.etsmtl.ca/Details/1",
      scrapedAt: new Date().toISOString(),
      applicationMode: 'full',
    },
    {
      portalId: "2026-A-0002",
      title: "Data Analyst Intern",
      organisation: "Stark Industries",
      location: "Remote",
      deadlineDate: null,
      descriptionHtml: "<dl><dt>Requirements</dt><dd>Python, SQL</dd></dl>",
      detailUrl: "https://see.etsmtl.ca/Details/2",
      scrapedAt: new Date().toISOString(),
      applicationMode: 'unknown',
    },
  ];

  it("should successfully insert a batch of new listings", async () => {
    const insertedCount = await repository.upsertMany(sampleListings);
    expect(insertedCount).toBe(2);

    const all = await repository.findAll();
    expect(all).toHaveLength(2);

    // Verify fields were preserved correctly
    const first = all.find((p) => p.portalId === "2026-A-0001");
    expect(first).toBeDefined();
    if (first) {
      expect(first.title).toBe("Backend Engineer Intern");
      expect(first.organisation).toBe("Acme Corp");
      expect(first.location).toBe("Montréal, QC");
      expect(first.deadlineDate).toBe("2026-08-31");
      expect(first.descriptionHtml).toBe("<dl><dt>Requirements</dt><dd>Node.js, TypeScript</dd></dl>");
      expect(first.detailUrl).toBe("https://see.etsmtl.ca/Details/1");
      expect(first.relevanceScore).toBeNull(); // default
      expect(first.aiSummary).toBeNull(); // default
      expect(first.notificationSent).toBe(false); // default
      expect(first.applied).toBe(false); // default
    }
  });

  it("should support upsert deduplication logic", async () => {
    const sample = sampleListings[0];
    if (!sample) throw new Error("Missing test fixture");

    // 1. Initial insert
    let inserted = await repository.upsertMany([sample]);
    expect(inserted).toBe(1);

    // 2. Insert same listing with updated title
    const updatedListing: RawPlacementListing = {
      ...sample,
      title: "Senior Backend Engineer Intern",
    };

    inserted = await repository.upsertMany([updatedListing]);
    expect(inserted).toBe(0); // 0 new rows inserted, just an update

    const all = await repository.findAll();
    expect(all).toHaveLength(1);
    
    const first = all[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.title).toBe("Senior Backend Engineer Intern");
    }
  });

  it("should filter placements by query options", async () => {
    await repository.upsertMany(sampleListings);
    const all = await repository.findAll();

    // Setup AI scores for querying
    const acme = all.find((p) => p.portalId === "2026-A-0001");
    const stark = all.find((p) => p.portalId === "2026-A-0002");

    expect(acme).toBeDefined();
    expect(stark).toBeDefined();

    if (acme && stark) {
      await repository.updateAiMetadata(acme.id, {
        relevanceScore: 85,
        aiSummary: "Fits candidate backend interest.",
      });
      await repository.updateAiMetadata(stark.id, {
        relevanceScore: 45,
        aiSummary: "Requires Python and data analysis skills.",
      });

      // Query 1: Filter by min relevance score >= 60
      const highMatch = await repository.findAll({ minRelevanceScore: 60 });
      expect(highMatch).toHaveLength(1);
      const firstHigh = highMatch[0];
      expect(firstHigh).toBeDefined();
      if (firstHigh) {
        expect(firstHigh.portalId).toBe("2026-A-0001");
      }

      // Query 2: Filter by unnotifiedOnly
      let unnotified = await repository.findAll({ unnotifiedOnly: true });
      expect(unnotified).toHaveLength(2);

      // Mark one as notified and query again
      await repository.markNotificationSent(acme.id);
      unnotified = await repository.findAll({ unnotifiedOnly: true });
      expect(unnotified).toHaveLength(1);
      const firstUnnotified = unnotified[0];
      expect(firstUnnotified).toBeDefined();
      if (firstUnnotified) {
        expect(firstUnnotified.portalId).toBe("2026-A-0002");
      }

      // Query 3: Filter by unappliedOnly
      let unapplied = await repository.findAll({ unappliedOnly: true });
      expect(unapplied).toHaveLength(2);

      // Mark one as applied and query again
      await repository.markApplied(acme.id);
      unapplied = await repository.findAll({ unappliedOnly: true });
      expect(unapplied).toHaveLength(1);
      const firstUnapplied = unapplied[0];
      expect(firstUnapplied).toBeDefined();
      if (firstUnapplied) {
        expect(firstUnapplied.portalId).toBe("2026-A-0002");
      }
    }
  });

  it("should return single placement when querying by ID", async () => {
    const sample = sampleListings[0];
    if (!sample) throw new Error("Missing test fixture");

    await repository.upsertMany([sample]);
    const all = await repository.findAll();
    const target = all[0];
    expect(target).toBeDefined();

    if (target) {
      const fetched = await repository.findById(target.id);
      expect(fetched).not.toBeNull();
      if (fetched) {
        expect(fetched.portalId).toBe("2026-A-0001");
      }

      const nonExistent = await repository.findById("non-existent-uuid");
      expect(nonExistent).toBeNull();
    }
  });
});
