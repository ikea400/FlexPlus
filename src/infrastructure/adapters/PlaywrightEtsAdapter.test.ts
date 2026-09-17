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
    const fixturePath = resolve(process.cwd(), "src/infrastructure/adapters/fixtures/Poste - Stages.html");
    const fileUrl = `file://${fixturePath.replace(/\\/g, "/")}`;

    console.log(`[Test] Loading local fixture from URL: ${fileUrl}`);

    // Call getPosteDetail using the file:// protocol URL
    const detail = await adapter.getPosteDetail(fileUrl);

    // Verify key metadata fields
    expect(detail.numeroPosto).toBe("20263TEST001");
    expect(detail.nomEmployeur).toBe("ENTREPRISE DE TEST INC.");
    expect(detail.detailUrl).toBe(fileUrl);
 
    // Verify some items in the key-value informations grid
    const infoMap = new Map(detail.informations.map((inf) => [inf.label.toLowerCase(), inf.value]));
    
    // Check various extracted fields
    expect(infoMap.get("entreprise:")).toBe("ENTREPRISE DE TEST INC.");
    expect(infoMap.get("lieu:")).toBe("Joliette");
    expect(infoMap.get("taux horaire:")).toBe("24$ à 29$");
    expect(infoMap.get("durée du poste:")).toBe("4 mois");
    expect(infoMap.get("langue du cv:")).toBe("Strictement en français");
    
    // Check that we correctly parsed the rich description blocks (.divBoiteBleu)
    expect(detail.descriptionHtml).toContain("L’option <strong>Flex+</strong> étant maintenant en vigueur");
    expect(detail.descriptionHtml).toContain("Travailler sur des technologies de pointe et des architectures modernes");
    expect(detail.descriptionHtml).toContain("Participer au développement et à la conception d'applications de test");
    expect(detail.descriptionHtml).toContain("Connaissance pratique de TypeScript et de Node.js");
    expect(detail.descriptionHtml).toContain("EntrepriseTest Canada inc. est une filiale de EntrepriseTest Corporation");
 
    // Test formatting mapping to RawPlacementListing
    const rawListing = PlaywrightEtsAdapter.toRawPlacementListing(detail);
    expect(rawListing.portalId).toBe("20263TEST001");
    expect(rawListing.title).toBe("20263TEST001"); // Fallback title
    expect(rawListing.organisation).toBe("ENTREPRISE DE TEST INC.");
    expect(rawListing.location).toBe("Joliette");
    expect(rawListing.deadlineDate).toBeNull(); // No deadline date present in informations under "date limite" or "date de clôture"
    expect(rawListing.descriptionHtml).toContain("Informations générales");
    expect(rawListing.descriptionHtml).toContain("Description du stage & Mission");

    // Test that isSiteDown returns false on a valid page
    const siteIsDownValid = await adapter.isSiteDown();
    expect(siteIsDownValid).toBe(false);

    // Test that isAffichageDesactive returns false on a valid job detail page
    const isDesactiveValid = await adapter.isAffichageDesactive();
    expect(isDesactiveValid).toBe(false);

    // Test that takeScreenshot returns a Buffer
    const screenshot = await adapter.takeScreenshot();
    expect(screenshot).toBeInstanceOf(Buffer);
    if (screenshot) {
      expect(screenshot.length).toBeGreaterThan(0);
    }
  }, 30000);

  it("should detect site down on Site - Inaccessible.html", async () => {
    const inaccessiblePath = resolve(process.cwd(), "src/infrastructure/adapters/fixtures/Site - Inaccessible.html");
    const inaccessibleUrl = `file://${inaccessiblePath.replace(/\\/g, "/")}`;

    const page = await (adapter as unknown as { ensureBrowser: () => Promise<{ goto: (url: string, opts?: unknown) => Promise<unknown> }> }).ensureBrowser();
    await page.goto(inaccessibleUrl, { waitUntil: "domcontentloaded" });

    expect(await adapter.isSiteDown()).toBe(true);
    expect(await adapter.isAffichageDesactive()).toBe(false);
  }, 30000);

  it("should detect affichage disabled on Affichage - Desactive.html", async () => {
    const desactivePath = resolve(process.cwd(), "src/infrastructure/adapters/fixtures/Affichage - Desactive.html");
    const desactiveUrl = `file://${desactivePath.replace(/\\/g, "/")}`;

    const page = await (adapter as unknown as { ensureBrowser: () => Promise<{ goto: (url: string, opts?: unknown) => Promise<unknown> }> }).ensureBrowser();
    await page.goto(desactiveUrl, { waitUntil: "domcontentloaded" });

    expect(await adapter.isAffichageDesactive()).toBe(true);
    expect(await adapter.isSiteDown()).toBe(false);
  }, 30000);

  it("should extract rows across all pages using Infragistics igGrid pager", async () => {
    const pagingPath = resolve(process.cwd(), "src/infrastructure/adapters/fixtures/Affichage - Paging.html");
    const pagingUrl = `file://${pagingPath.replace(/\\/g, "/")}`;

    const internalAdapter = adapter as unknown as {
      ensureBrowser: () => Promise<any>;
      extractAllPagesFromGrid: (
        page: any,
        gridId: string,
        extractRows: () => Promise<any[]>,
        getKey: (item: any) => string,
      ) => Promise<any[]>;
    };

    const page = await internalAdapter.ensureBrowser();
    await page.goto(pagingUrl, { waitUntil: "domcontentloaded" });

    // Call extractAllPagesFromGrid
    const allRows = await internalAdapter.extractAllPagesFromGrid(
      page,
      "grid1",
      async () => {
        return page.$$eval("#grid1 tbody tr", (rows: any[]) =>
          rows.map((r) => ({
            id: r.getAttribute("data-id"),
            title: r.querySelector("td:nth-child(3)")?.textContent?.trim(),
          })),
        );
      },
      (row) => row.id,
    );

    // Verify all 5 rows across the 3 pages are returned
    expect(allRows).toHaveLength(5);
    expect(allRows.map((r) => r.id)).toEqual([
      "POST-001",
      "POST-002",
      "POST-003",
      "POST-004",
      "POST-005",
    ]);
  }, 30000);
});

