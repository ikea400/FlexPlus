/**
 * src/infrastructure/adapters/PlaywrightEtsAdapter.test.ts
 *
 * Integration/Unit test for PlaywrightEtsAdapter's parser.
 * Loads the local Poste - Stages.html fixture file into a headless
 * Playwright page and verifies that selectors and text parsing work exactly
 * as expected against real portal structures.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "path";

import { PlaywrightEtsAdapter } from "./PlaywrightEtsAdapter.js";

describe("PlaywrightEtsAdapter Parser", () => {
  let adapter: PlaywrightEtsAdapter;

  beforeAll(() => {
    // Instantiate adapter in headless mode
    adapter = new PlaywrightEtsAdapter({
      headless: true,
      timeoutMs: 10000,
      urls: { baseUrl: "https://see.etsmtl.ca" },
    });
  });

  afterAll(async () => {
    await adapter.dispose();
  });

  it("should parse placement details correctly from Poste - Stages.html fixture", async () => {
    // Resolve absolute path to the local HTML fixture file
    const fixturePath = resolve(process.cwd(), "Poste - Stages.html");
    const fileUrl = `file://${fixturePath.replace(/\\/g, "/")}`;

    console.log(`[Test] Loading local fixture from URL: ${fileUrl}`);

    // Call getPosteDetail using the file:// protocol URL
    const detail = await adapter.getPosteDetail(fileUrl);

    // Verify key metadata fields
    expect(detail.numeroPosto).toBe("20263BRIDG009");
    expect(detail.nomEmployeur).toBe("BRIDGESTONE CANADA INC.");
    expect(detail.detailUrl).toBe(fileUrl);

    // Verify some items in the key-value informations grid
    const infoMap = new Map(detail.informations.map((inf) => [inf.label.toLowerCase(), inf.value]));
    
    // Check various extracted fields
    expect(infoMap.get("entreprise:")).toBe("BRIDGESTONE CANADA INC.");
    expect(infoMap.get("lieu:")).toBe("Joliette");
    expect(infoMap.get("taux horaire:")).toBe("24$ à 29$");
    expect(infoMap.get("durée du poste:")).toBe("4 mois");
    expect(infoMap.get("langue du cv:")).toBe("Strictement en français");
    
    // Check that we correctly parsed the rich description blocks (.divBoiteBleu)
    expect(detail.descriptionHtml).toContain("L’option <strong>Flex+</strong> étant maintenant en vigueur");
    expect(detail.descriptionHtml).toContain("Faire partie d'une entreprise technologique engagée dans la 4ème révolution industrielle");
    expect(detail.descriptionHtml).toContain("Participer à différents projets comportant des volets reliés à l'installation");
    expect(detail.descriptionHtml).toContain("Maitrise de la suite Office (Outlook, Word et Excel)");
    expect(detail.descriptionHtml).toContain("Bridgestone Canada inc. est une filiale de Bridgestone Corporation");

    // Test formatting mapping to RawPlacementListing
    const rawListing = PlaywrightEtsAdapter.toRawPlacementListing(detail);
    expect(rawListing.portalId).toBe("20263BRIDG009");
    expect(rawListing.title).toBe("20263BRIDG009"); // Fallback title
    expect(rawListing.organisation).toBe("BRIDGESTONE CANADA INC.");
    expect(rawListing.location).toBe("Joliette");
    expect(rawListing.deadlineDate).toBeNull(); // No deadline date present in informations under "date limite" or "date de clôture"
    expect(rawListing.descriptionHtml).toContain("Informations générales");
    expect(rawListing.descriptionHtml).toContain("Description du stage & Mission");
  });
});
