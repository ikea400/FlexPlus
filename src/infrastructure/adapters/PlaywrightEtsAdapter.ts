/**
 * src/infrastructure/adapters/PlaywrightEtsAdapter.ts
 *
 * SECONDARY ADAPTER — Driven side.
 * Implements IEtsScraper using Playwright + playwright-extra stealth.
 *
 * Dependency direction: Infrastructure → Domain (port interfaces only).
 * This file MUST NOT be imported by domain or application layers.
 */

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import {
  ETS_SELECTORS,
  ScraperAuthError,
  ScraperError,
  TokenExpiredError,
  type AffichageRow,
  type EtsUrls,
  type IEtsScraper,
  type InfoLigne,
  type PosteDetail,
  type PostulationRow,
  type RawPlacementListing,
  type ScraperOptions,
  type ScrapingResult,
} from "../../domain/ports/scraper.port.js";

// chromium.use(StealthPlugin());

// ─── Internal helpers ─────────────────────────────────────────────────────────

function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitiseText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class PlaywrightEtsAdapter implements IEtsScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private readonly headless: boolean;
  private readonly timeoutMs: number;
  private readonly urls: EtsUrls;
  private readonly userDataDir: string;

  constructor(
    options: Pick<
      ScraperOptions,
      "headless" | "timeoutMs" | "urls" | "userDataDir"
    > &
      Partial<ScraperOptions>,
  ) {
    this.headless = options.headless;
    this.timeoutMs = options.timeoutMs;
    this.urls = options.urls;
    this.userDataDir =
      options.userDataDir ??
      process.env["PLAYWRIGHT_USER_DATA_DIR"] ??
      "./data/browser-context";
  }

  // ─── Private: browser setup ────────────────────────────────────────────────

  private async ensureBrowser(): Promise<Page> {
    if (this.page) return this.page;

    const launchArgs = [
      "--disable-setuid-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ];

    const contextOptions = {
      headless: this.headless,
      viewport: { width: 1920, height: 1080 },
      locale: "fr-CA",
      timezoneId: "America/Toronto",
      args: launchArgs,
    };

    const userDataDir = this.userDataDir;
    console.log(
      `[PlaywrightEtsAdapter] Using persistent browser context at: ${userDataDir}`,
    );

    try {
      // 1. Try launching Google Chrome with persistent context
      this.context = await chromium.launchPersistentContext(userDataDir, {
        ...contextOptions,
        channel: "chrome",
      });
      console.log(
        "[PlaywrightEtsAdapter] Launched Google Chrome (Persistent).",
      );
    } catch {
      try {
        // 2. Try launching Microsoft Edge with persistent context
        this.context = await chromium.launchPersistentContext(userDataDir, {
          ...contextOptions,
          channel: "msedge",
        });
        console.log(
          "[PlaywrightEtsAdapter] Launched Microsoft Edge (Persistent).",
        );
      } catch {
        // 3. Fallback to bundled Chromium with persistent context
        this.context = await chromium.launchPersistentContext(
          userDataDir,
          contextOptions,
        );
        console.log(
          "[PlaywrightEtsAdapter] Launched bundled Chromium (Persistent).",
        );
      }
    }

    const pages = this.context.pages();
    const page = pages[0] || (await this.context.newPage());
    page.setDefaultTimeout(this.timeoutMs);
    page.setDefaultNavigationTimeout(this.timeoutMs);
    this.page = page;

    return page;
  }

  // ─── Private: Navigation Helper ───────────────────────────────────────────

  private async navigateToSection(menuSelector: string): Promise<void> {
    const page = await this.ensureBrowser();
    const menuLink = page.locator(menuSelector);
    await menuLink.waitFor({ state: "visible" });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      menuLink.click(),
    ]);

    if (page.url().includes("fs.etsmtl.ca/adfs")) {
      throw new TokenExpiredError(
        "Redirected to ADFS during section navigation.",
      );
    }
  }

  // ─── IEtsScraper: authenticate ─────────────────────────────────────────────

  async authenticate(
    credentials: ScraperOptions["credentials"],
  ): Promise<void> {
    const page = await this.ensureBrowser();

    try {
      console.log(
        `[PlaywrightEtsAdapter] Navigating to base URL: ${this.urls.baseUrl}`,
      );
      await page.goto(this.urls.baseUrl, {
        waitUntil: "domcontentloaded",
      });

      const loginInputSelector = "#userNameInput";
      const menuTopSelector = "#MenuTop";
      const mfaSelector =
        "#validEntropyNumber, [data-testid='numberMatchInput'], .displaySign";
      const kmsiSelector = "#idSIButton9";

      // Wait for either the ADFS login form, the MFA screen, the KMSI prompt, or the authenticated navigation menu
      await page.waitForSelector(
        `${loginInputSelector}, ${menuTopSelector}, ${mfaSelector}, ${kmsiSelector}`,
        {
          state: "visible",
        },
      );

      const isLoginVisible = await page
        .locator(loginInputSelector)
        .isVisible()
        .catch(() => false);

      const isMfaVisible = await page
        .locator(mfaSelector)
        .isVisible()
        .catch(() => false);

      if (isLoginVisible) {
        console.log(
          "[PlaywrightEtsAdapter] SSO login page detected. Authenticating...",
        );

        await page.fill(loginInputSelector, credentials.email);
        await humanDelay(200, 500);

        await page.fill("#passwordInput", credentials.password);
        await humanDelay(150, 400);

        // Check for ADFS KMSI option (e.g. "Keep me signed in" checkbox) on the login page itself
        const adfsKmsi = page.locator(
          "#kmsiInput, #kmsiInputCheckbox, #keepMeSignedInCheckbox, input[name='KMSI']",
        );
        if (await adfsKmsi.isVisible().catch(() => false)) {
          const isChecked = await adfsKmsi.isChecked().catch(() => false);
          if (!isChecked) {
            console.log(
              "[PlaywrightEtsAdapter] Checking ADFS 'Keep me signed in' checkbox...",
            );
            await adfsKmsi.check().catch(() => {});
          }
        }

        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle" }),
          page.click("#submitButton"),
        ]);

        const stillOnLogin = await page
          .locator(loginInputSelector)
          .isVisible()
          .catch(() => false);

        if (stillOnLogin) {
          throw new ScraperAuthError(
            "Authentication failed: still on ADFS login page after credentials submission.",
            { currentUrl: page.url() },
          );
        }
      } else if (isMfaVisible) {
        console.log(
          "[PlaywrightEtsAdapter] ADFS remembered the credentials and skipped directly to MFA!",
        );
      } else {
        console.log(
          "[PlaywrightEtsAdapter] Session is already authenticated or advanced beyond login.",
        );
      }
    } catch (err) {
      console.error("[PlaywrightEtsAdapter] Authentication failed:", err);
      throw new ScraperAuthError(
        `Failed to authenticate: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Waits for the MFA / SSO verification and KMSI confirmations to complete,
   * confirming successful redirection back to the target portal.
   */
  async waitForLoginComplete(maxWaitMs = 120000): Promise<void> {
    const page = await this.ensureBrowser();
    console.log(
      "[PlaywrightEtsAdapter] SSO/MFA/KMSI process active. Waiting for authentication and redirection...",
    );
    const targetHost = new URL(this.urls.baseUrl).hostname;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const currentUrl = page.url();

      // 1. If we reached targetHost, authentication is complete!
      if (currentUrl.includes(targetHost)) {
        console.log(
          "[PlaywrightEtsAdapter] Target host see.etsmtl.ca reached.",
        );
        break;
      }

      // 2. Handle Microsoft KMSI (Keep Me Signed In) post-login prompt if it appears
      const kmsiButton = page.locator("#idSIButton9");
      const kmsiCheckbox = page.locator("#KmsiCheckboxField");
      if (await kmsiButton.isVisible().catch(() => false)) {
        console.log(
          "[PlaywrightEtsAdapter] Microsoft 'Stay signed in?' prompt detected. Selecting Yes to persist login context...",
        );
        if (await kmsiCheckbox.isVisible().catch(() => false)) {
          await kmsiCheckbox.check().catch(() => {});
        }
        await kmsiButton.click().catch(() => {});
        await humanDelay(500, 1000);
        continue;
      }

      await humanDelay(1000, 1000);
    }

    // Final URL check to confirm success
    if (!page.url().includes(targetHost)) {
      throw new ScraperAuthError(
        `Authentication timed out or failed. Still on URL: ${page.url()}`,
      );
    }

    console.log("[PlaywrightEtsAdapter] Authenticated successfully.");

    try {
      // Confirm we are on /Accueil
      if (!page.url().includes("/Accueil")) {
        const accueilLink = page.locator("#MenuTop a[href$='Accueil']");
        const isAccueilVisible = await accueilLink
          .isVisible()
          .catch(() => false);
        if (isAccueilVisible) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle" }),
            accueilLink.click(),
          ]);
        } else {
          const origin = new URL(this.urls.baseUrl).origin;
          await page.goto(`${origin}/Accueil`, { waitUntil: "networkidle" });
        }
      }
    } catch (err) {
      if (err instanceof ScraperAuthError) throw err;
      throw new ScraperAuthError(
        `Authentication error navigating to Accueil: ${err instanceof Error ? err.message : String(err)}`,
        { currentUrl: page.url() },
      );
    }
  }

  // ─── IEtsScraper: getPostulationsActives ───────────────────────────────────

  async getPostulationsActives(): Promise<{
    readonly actives: readonly PostulationRow[];
    readonly inactives: readonly PostulationRow[];
  }> {
    const page = await this.ensureBrowser();

    try {
      console.log(
        "[PlaywrightEtsAdapter] Navigating to Suivi des postulations section...",
      );
      await this.navigateToSection(ETS_SELECTORS.Navigation.MenuSuivi);

      await page.waitForSelector("#grid1 tbody.ui-iggrid-tablebody", {
        state: "attached",
      });

      const actives = await this.extractGridRows(
        page,
        ETS_SELECTORS.SuiviDesPostulations.GrilleActives,
      );

      const inactives = await this.extractGridRows(
        page,
        ETS_SELECTORS.SuiviDesPostulations.GrilleInactives,
      );

      return { actives, inactives };
    } catch (err) {
      if (err instanceof ScraperError) throw err;
      throw new ScraperError(
        `Failed to extract postulations: ${err instanceof Error ? err.message : String(err)}`,
        { currentUrl: page.url() },
      );
    }
  }

  private async extractGridRows(
    page: Page,
    rowSelector: string,
  ): Promise<readonly PostulationRow[]> {
    const cols = ETS_SELECTORS.SuiviDesPostulations.SelecteursColonnes;

    return page.$$eval(
      rowSelector,
      (rows, selectors) =>
        rows.map((tr) => {
          const typeEl = tr.querySelector(selectors.Type) as HTMLElement | null;
          const numEl = tr.querySelector(
            selectors.NumeroPoste,
          ) as HTMLElement | null;
          const titreEl = tr.querySelector(
            selectors.TitrePoste,
          ) as HTMLElement | null;
          const entEl = tr.querySelector(
            selectors.Entreprise,
          ) as HTMLElement | null;
          const statEl = tr.querySelector(
            selectors.Statut,
          ) as HTMLElement | null;

          return {
            type: typeEl ? typeEl.innerText.trim() : "",
            numeroPoste: numEl ? numEl.innerText.trim() : "",
            titrePoste: titreEl ? titreEl.innerText.trim() : "",
            entreprise: entEl ? entEl.innerText.trim() : "",
            statut: statEl ? statEl.innerText.trim() : "",
          };
        }),
      cols,
    );
  }

  // ─── IEtsScraper: getNouveauxAffichages ────────────────────────────────────

  async getNouveauxAffichages(
    keyword?: string,
    excludePortalIds?: readonly string[],
  ): Promise<readonly PosteDetail[]> {
    const page = await this.ensureBrowser();

    try {
      console.log("[PlaywrightEtsAdapter] Navigating to Affichages section...");
      await this.navigateToSection(ETS_SELECTORS.Navigation.MenuAffichages);

      await page.waitForSelector(ETS_SELECTORS.RechercheAffichages.Formulaire, {
        state: "attached",
      });

      if (keyword && keyword.trim().length > 0) {
        await page.fill(
          ETS_SELECTORS.RechercheAffichages.ChampMotCle,
          keyword.trim(),
        );
        await humanDelay(100, 300);
      }

      await page.click(ETS_SELECTORS.RechercheAffichages.BoutonRechercher);
      try {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      } catch {
        // Continue even if networkidle does not settle
      }

      if (page.url().includes("fs.etsmtl.ca/adfs")) {
        throw new TokenExpiredError(
          "Redirected to ADFS during affichages search.",
        );
      }

      await page.waitForSelector("#grid1 tbody.ui-iggrid-tablebody", {
        state: "attached",
      });

      const origin = new URL(this.urls.baseUrl).origin;
      const affichageRows: AffichageRow[] = await page.$$eval(
        ETS_SELECTORS.RechercheAffichages.GrilleResultats,
        (rows, baseOrigin) =>
          rows.map((tr) => {
            const link = tr.querySelector("a") as HTMLAnchorElement | null;
            const href = link?.href ?? "";
            const numeroPoste =
              tr.getAttribute("data-id") ||
              (
                tr.querySelector("td:nth-child(2)") as HTMLElement | null
              )?.innerText.trim() ||
              "";
            const titrePoste =
              (
                tr.querySelector("td:nth-child(3)") as HTMLElement | null
              )?.innerText.trim() || "";
            return {
              numeroPoste,
              titrePoste,
              detailUrl: href.startsWith("http")
                ? href
                : `${baseOrigin}${href}`,
            };
          }),
        origin,
      );

      console.log(
        `[PlaywrightEtsAdapter] Found ${affichageRows.length} postings in results grid. Scrapping details...`,
      );

      const details: PosteDetail[] = [];
      for (const row of affichageRows) {
        if (!row.detailUrl) continue;

        if (excludePortalIds && excludePortalIds.includes(row.numeroPoste)) {
          console.log(
            `[PlaywrightEtsAdapter] Skipping detail page for already known posting: ${row.numeroPoste}`,
          );
          continue;
        }

        try {
          const detail = await this.getPosteDetail(
            row.detailUrl,
            row.titrePoste,
          );
          details.push(detail);
          await humanDelay(1000, 2000);
        } catch (err) {
          console.error(
            `[PlaywrightEtsAdapter] Failed to fetch detail for ${row.numeroPoste}:`,
            err,
          );
        }
      }

      const accueilLink = page.locator("#MenuTop a[href$='Accueil']");
      if (await accueilLink.isVisible().catch(() => false)) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle" }),
          accueilLink.click(),
        ]);
      }

      return details;
    } catch (err) {
      if (err instanceof ScraperError) throw err;
      throw new ScraperError(
        `Failed to fetch affichages: ${err instanceof Error ? err.message : String(err)}`,
        { currentUrl: page.url() },
      );
    }
  }

  // ─── IEtsScraper: getPosteDetail ───────────────────────────────────────────

  async getPosteDetail(
    detailUrl: string,
    titrePoste?: string,
  ): Promise<PosteDetail> {
    const page = await this.ensureBrowser();

    try {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded" });

      if (page.url().includes("fs.etsmtl.ca/adfs")) {
        throw new TokenExpiredError(
          `Redirected to ADFS when accessing detail page: ${detailUrl}`,
        );
      }

      await page.waitForSelector(ETS_SELECTORS.DetailsDuPoste.NumeroPoste, {
        state: "visible",
      });

      const numeroPosto = await page
        .locator(ETS_SELECTORS.DetailsDuPoste.NumeroPoste)
        .innerText()
        .then(sanitiseText);

      const nomEmployeur = await page
        .locator(ETS_SELECTORS.DetailsDuPoste.NomEmployeur)
        .innerText()
        .then(sanitiseText)
        .catch(() => "");

      const informations: InfoLigne[] = await page.$$eval(
        ETS_SELECTORS.DetailsDuPoste.LignesInformations,
        (elements) =>
          elements
            .map((el) => {
              const children = el.querySelectorAll("div");
              const label =
                (children[0] as HTMLElement | undefined)?.innerText.trim() ??
                "";
              const value =
                (children[1] as HTMLElement | undefined)?.innerText.trim() ??
                "";
              return { label, value };
            })
            .filter((pair) => pair.label.length > 0),
      );

      // Extract description blocks
      const descriptionHtml = await page
        .$$eval(".divBoiteBleu", (elements) =>
          elements.map((el) => el.innerHTML).join("\n"),
        )
        .catch(() => "");

      // Detect application mode from page text
      const pageText = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      let applicationMode: "full" | "external" | "applied" | "unknown" =
        "unknown";

      if (
        /postuler sur le site internet de l.employeur/i.test(pageText) ||
        /postulation.*d\u00e9sactiv\u00e9e/i.test(pageText)
      ) {
        applicationMode = "external";
      } else if (
        /cliquez ici pour postuler/i.test(pageText) ||
        /si ce poste vous int\u00e9resse/i.test(pageText)
      ) {
        applicationMode = "full";
      } else {
        // Check if already applied (postulation confirmation / success indicators)
        const hasApplied = await page
          .locator("#Postuler")
          .isVisible()
          .catch(() => false);
        if (!hasApplied) {
          // Look for evidence of already-applied state, rejected state, or cancelled state
          const appliedRegex = new RegExp(
            [
              "votre candidature a \u00e9t\u00e9 soumise", // votre candidature a été soumise
              "vous avez d\u00e9j\u00e0 postul\u00e9", // vous avez déjà postulé
              "votre cv a \u00e9t\u00e9 remis \u00e0 l'employeur", // Votre CV a té remis à l'employeur
              "vous \u00eates non gagnant", // Vous êtes non gagnant (e) sur ce posteé
              "vous n'avez pas \u00e9t\u00e9 retenu", // Vous n'avez pas été retenu (e)
              "poste annul\u00e9", // Poste annulé
            ].join("|"),
            "i",
          );
          const appliedText = appliedRegex.test(pageText);
          applicationMode = appliedText ? "applied" : "unknown";
        } else {
          applicationMode = "full";
        }
      }

      return {
        numeroPosto,
        titrePoste,
        nomEmployeur,
        informations,
        descriptionHtml,
        detailUrl,
        applicationMode,
      };
    } catch (err) {
      if (err instanceof ScraperError) throw err;
      throw new ScraperError(
        `Failed to fetch poste detail at ${detailUrl}: ${err instanceof Error ? err.message : String(err)}`,
        { detailUrl },
      );
    }
  }

  // ─── IEtsScraper: postuler ─────────────────────────────────────────────────

  async postuler(detailUrl: string, password: string): Promise<void> {
    const page = await this.ensureBrowser();

    try {
      console.log(
        `[PlaywrightEtsAdapter] Navigating to detail page for postulation: ${detailUrl}`,
      );
      await page.goto(detailUrl, { waitUntil: "domcontentloaded" });

      if (page.url().includes("fs.etsmtl.ca/adfs")) {
        throw new TokenExpiredError(
          `Redirected to ADFS when accessing postulation page: ${detailUrl}`,
        );
      }

      const { BoutonPostulerDetail } = ETS_SELECTORS.DetailsDuPoste;
      const { ConfirmationPasswordInput, BoutonConfirmer } =
        ETS_SELECTORS.ConfirmationPostulation;

      // 1. Click "Postuler" on the job detail page to initiate application
      console.log(
        "[PlaywrightEtsAdapter] Clicking 'Postuler' on the detail page...",
      );
      await page.waitForSelector(BoutonPostulerDetail, {
        state: "visible",
        timeout: 10000,
      });
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle" }),
        page.click(BoutonPostulerDetail),
      ]);

      // 2. We should now be on the confirmation page. Enter the password.
      console.log(
        "[PlaywrightEtsAdapter] Entering password on confirmation page...",
      );
      await page.waitForSelector(ConfirmationPasswordInput, {
        state: "visible",
        timeout: 10000,
      });

      const hasPasswordField = await page
        .locator(ConfirmationPasswordInput)
        .isVisible()
        .catch(() => false);

      if (hasPasswordField) {
        await page.fill(ConfirmationPasswordInput, password);
        await humanDelay(150, 300);
      }

      // 3. Submit the final 'Postuler' button (.boutonsPost)
      console.log("[PlaywrightEtsAdapter] Submitting confirmation...");
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle" }),
        page.click(BoutonConfirmer),
      ]);

      // 4. Verify we landed on PostulationReussie
      if (!page.url().includes("PostulationReussie")) {
        throw new ScraperError(
          "Failed to reach PostulationReussie after submitting.",
          { currentUrl: page.url() },
        );
      }

      console.log("[PlaywrightEtsAdapter] Postulation submitted successfully.");
    } catch (err) {
      if (err instanceof ScraperError) throw err;
      throw new ScraperError(
        `Failed to postuler at ${detailUrl}: ${err instanceof Error ? err.message : String(err)}`,
        { detailUrl, currentUrl: page.url() },
      );
    }
  }

  // ─── Session helpers ────────────────────────────────────────────────────────

  /**
   * Returns true if the current browser session is logged out (cookie expired).
   * Navigates to the base URL and checks whether the ADFS login form is visible.
   */
  async isLoggedOut(): Promise<boolean> {
    try {
      const page = await this.ensureBrowser();
      console.log(
        `[PlaywrightEtsAdapter] Checking session status at ${this.urls.baseUrl}...`,
      );

      // The user explicitly requested to see the page load in the browser during headed mode.
      // We wait for domcontentloaded to allow the SSO bounce (see.etsmtl.ca -> ADFS -> see.etsmtl.ca) to complete if the session is valid.
      await page.goto(this.urls.baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Briefly wait to ensure the final URL is settled
      await page.waitForTimeout(1000);

      const currentUrl = page.url();
      if (currentUrl.includes("fs.etsmtl.ca/adfs")) {
        console.log(
          "[PlaywrightEtsAdapter] Redirected to ADFS. Session is expired or not logged in.",
        );
        return true;
      }

      console.log(
        `[PlaywrightEtsAdapter] Stayed on ${currentUrl}. Session is active.`,
      );

      return false;
    } catch (err) {
      console.log(
        `[PlaywrightEtsAdapter] Error checking session status, assuming logged out: ${err}`,
      );
      return true; // treat errors as logged out
    }
  }

  /**
   * Clears the persistent session cookies to force a re-authentication.
   */
  async clearSession(): Promise<void> {
    await this.ensureBrowser();
    if (this.context) {
      await this.context.clearCookies();
      console.log("[PlaywrightEtsAdapter] Session cookies cleared.");
    }
  }

  /**
   * Explicitly closes the current browser window/context.
   */
  async closeBrowser(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
      console.log("[PlaywrightEtsAdapter] Browser window closed.");
    }
  }

  /**
   * After credentials are submitted, waits for Microsoft to display the
   * 2-digit number-matching MFA challenge and extracts it.
   * Returns null if the number is not found within the timeout.
   */
  async extractMfaCode(timeoutMs = 30000): Promise<string | null> {
    try {
      const page = await this.ensureBrowser();
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const pageText = await page
          .locator("body")
          .innerText()
          .catch(() => "");
        // Microsoft number-matching: look for "XX" large-font digit pairs
        const match = pageText.match(/\b(\d{2})\b/);
        if (match && pageText.toLowerCase().includes("approuv")) {
          return match[1] ?? null;
        }
        // Also look for the specific number-match challenge text
        const codeEl = await page
          .$(
            "#validEntropyNumber, [data-testid='numberMatchInput'], .displaySign",
          )
          .catch(() => null);
        if (codeEl) {
          const code = await codeEl.innerText().catch(() => "");
          if (/^\d{2}$/.test(code.trim())) return code.trim();
        }
        await humanDelay(1000, 1000);
      }
      return null;
    } catch {
      return null;
    }
  }

  // ─── IEtsScraper: scrape (convenience wrapper) ─────────────────────────────

  async scrape(options: ScraperOptions): Promise<ScrapingResult> {
    const startedAt = new Date().toISOString();

    await this.authenticate(options.credentials);

    const { actives, inactives } = await this.getPostulationsActives();
    const nouveauxAffichages = await this.getNouveauxAffichages(
      options.searchKeyword,
      options.excludePortalIds,
    );

    const finishedAt = new Date().toISOString();

    return {
      postulationsActives: actives,
      postulationsInactives: inactives,
      nouveauxAffichages,
      startedAt,
      finishedAt,
    };
  }

  // ─── IEtsScraper: isSiteDown ───────────────────────────────────────────────

  async isSiteDown(): Promise<boolean> {
    if (!this.page) return false;
    try {
      const title = await this.page.title().catch(() => "");
      if (title.toLowerCase().includes("site inaccessible")) {
        return true;
      }

      const h1Text = await this.page.locator("h1").innerText().catch(() => "");
      if (h1Text.toLowerCase().includes("site web inaccessible")) {
        return true;
      }

      const bodyText = await this.page.innerText("body").catch(() => "");
      if (
        bodyText.toLowerCase().includes("site web inaccessible") ||
        bodyText.toLowerCase().includes("présentement inaccessible")
      ) {
        return true;
      }

      return false;
    } catch (err) {
      console.error(
        "[PlaywrightEtsAdapter] Error checking if site is down:",
        err,
      );
      return false;
    }
  }

  // ─── IEtsScraper: takeScreenshot ───────────────────────────────────────────

  async takeScreenshot(): Promise<Buffer | null> {
    if (!this.page) return null;
    try {
      return await this.page.screenshot({ type: "png" });
    } catch (err) {
      console.error("[PlaywrightEtsAdapter] Failed to take screenshot:", err);
      return null;
    }
  }

  // ─── IEtsScraper: dispose ──────────────────────────────────────────────────

  async dispose(): Promise<void> {
    try {
      await this.context?.close();
    } finally {
      await this.browser?.close();
      this.page = null;
      this.context = null;
      this.browser = null;
    }
  }

  // ─── Static factory helper ─────────────────────────────────────────────────

  static fromEnv(): { adapter: PlaywrightEtsAdapter; options: ScraperOptions } {
    const email = process.env["ETS_EMAIL"];
    const password = process.env["ETS_PASSWORD"];

    if (!email || !password) {
      throw new ScraperError(
        "Missing required environment variables: ETS_EMAIL and/or ETS_PASSWORD.",
      );
    }

    const urls: EtsUrls = {
      baseUrl: process.env["ETS_BASE_URL"] ?? "https://see.etsmtl.ca",
    };

    const headless = process.env["PLAYWRIGHT_HEADLESS"] !== "false";
    const timeoutMs = parseInt(
      process.env["PLAYWRIGHT_TIMEOUT_MS"] ?? "30000",
      10,
    );
    const userDataDir =
      process.env["PLAYWRIGHT_USER_DATA_DIR"] ?? "./data/browser-context";

    const options: ScraperOptions = {
      urls,
      credentials: { email, password },
      headless,
      timeoutMs,
      userDataDir,
    };

    return { adapter: new PlaywrightEtsAdapter(options), options };
  }

  // ─── Mapping helpers (domain → repository shape) ──────────────────────────

  static toRawPlacementListing(detail: PosteDetail): RawPlacementListing {
    const find = (label: string): string | null => {
      const normalise = (s: string): string => s.toLowerCase().trim();
      return (
        detail.informations.find((i) =>
          normalise(i.label).includes(normalise(label)),
        )?.value ?? null
      );
    };

    const title = find("Titre") ?? find("titre du poste") ?? detail.numeroPosto;

    const location =
      find("lieu de travail") ?? find("lieu") ?? find("ville") ?? "";

    const deadlineDate = find("date limite") ?? find("date de clôture");

    const infoTableHtml =
      "<dl>" +
      detail.informations
        .map((pair) => `<dt>${pair.label}</dt><dd>${pair.value}</dd>`)
        .join("") +
      "</dl>";

    const descriptionHtml = `
      <div>
        <h4>Informations générales</h4>
        ${infoTableHtml}
        <h4>Description du stage & Mission</h4>
        <div>${detail.descriptionHtml}</div>
      </div>
    `;

    return {
      portalId: detail.numeroPosto,
      title: title.trim(),
      organisation: detail.nomEmployeur,
      location,
      deadlineDate,
      descriptionHtml,
      detailUrl: detail.detailUrl,
      scrapedAt: new Date().toISOString(),
      applicationMode: detail.applicationMode,
    };
  }
}
