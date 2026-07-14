import "dotenv/config";
import { PlaywrightEtsAdapter } from "./infrastructure/adapters/PlaywrightEtsAdapter.js";
import { ScraperError } from "./domain/ports/scraper.port.js";

async function run() {
  console.log("=== Launching Scraper in Headed Mode ===");
  
  const email = process.env["ETS_EMAIL"];
  const password = process.env["ETS_PASSWORD"];
  
  if (!email || !password) {
    console.error("ERROR: ETS_EMAIL and/or ETS_PASSWORD environment variables are missing.");
    process.exit(1);
  }
  
  const urls = {
    baseUrl: process.env["ETS_BASE_URL"] ?? "https://see.etsmtl.ca",
  };
  
  // Create adapter explicitly in headed mode
  console.log(`[Config] Base URL: ${urls.baseUrl}`);
  console.log(`[Config] User: ${email}`);
  console.log(`[Config] Mode: HEADED (headless: false)`);
  
  const adapter = new PlaywrightEtsAdapter({
    urls,
    credentials: { email, password },
    headless: false, // Force headed mode so the browser window is visible
    timeoutMs: 60000, // 60s timeout to give ample time for manual/visual check
  });
  
  try {
    console.log("\n[Step 1] Initialising browser and authenticating...");
    await adapter.authenticate({ email, password });
    console.log("✓ Authentication completed successfully.");
    
    console.log("\n[Step 2] Navigating to 'Affichages' and retrieving postings...");
    // Retrieve postings (keyword can be passed if needed, or empty for all)
    const postings = await adapter.getNouveauxAffichages();
    console.log(`\n✓ Scraped details for ${postings.length} postings.\n`);
    
    console.log("=== List of Scraped Offers ===");
    postings.forEach((post, index) => {
      console.log(`[${index + 1}] Number: ${post.numeroPosto}`);
      console.log(`    Employer: ${post.nomEmployeur}`);
      console.log(`    Detail URL: ${post.detailUrl}`);
      // Find Title in details
      const titlePair = post.informations.find(
        (inf) => inf.label.toLowerCase().includes("titre")
      );
      if (titlePair) {
        console.log(`    Title: ${titlePair.value}`);
      }
      const locationPair = post.informations.find(
        (inf) => inf.label.toLowerCase().includes("lieu")
      );
      if (locationPair) {
        console.log(`    Location: ${locationPair.value}`);
      }
      console.log("------------------------------------------");
    });
    
    console.log("\nWaiting 10 seconds before closing the browser so you can inspect the window...");
    await new Promise((resolve) => setTimeout(resolve, 10000));
    
  } catch (err) {
    console.error("\n❌ Scraper failed with error:");
    if (err instanceof ScraperError) {
      console.error(err.message, err.context);
    } else {
      console.error(err);
    }
  } finally {
    console.log("\nDisposing browser and cleaning up...");
    await adapter.dispose().catch((e) => console.error("Error disposing adapter:", e));
    console.log("Done.");
  }
}

run().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
