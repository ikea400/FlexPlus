/**
 * src/domain/ports/scraper.port.ts
 *
 * PRIMARY PORT — Driving side.
 * Defines the ETS Placement Flex portal scraping contract.
 * This interface has ZERO external dependencies.
 *
 * Selector constants are co-located here so the domain layer owns the
 * "what to find" knowledge while the infrastructure adapter owns the
 * "how to find it" mechanics.
 */

// ─── URL configuration (loaded from env vars by the adapter) ─────────────────
// Domain-layer interface only: NO hardcoded values here.
// Concrete values live in src/infrastructure/config/ and .env.example.

/**
 * All ETS portal URLs consumed by the scraper adapter.
 * Populated at startup from environment variables.
 *
 * Why here and not in ETS_SELECTORS?
 * ETS_SELECTORS contains CSS selector strings — pure DOM knowledge.
 * URLs are runtime configuration, not DOM knowledge, and must be
 * configurable per deployment without touching source code.
 */
export interface EtsUrls {
  /**
   * ETS portal base URL (e.g., https://see.etsmtl.ca).
   * If a user visits this URL, they are redirected to login if not authenticated.
   * Env var: ETS_BASE_URL
   * Default: https://see.etsmtl.ca
   */
  readonly baseUrl: string;
}

// ─── DOM Selector Map ────────────────────────────────────────────────────────
// Contains ONLY CSS selectors — pure DOM knowledge, zero runtime URLs.
// Any future adapter (Puppeteer, fetch+cheerio, etc.) reuses this map.

export const ETS_SELECTORS = {
  AdfsSSO: {
    CourrielInput: "#userNameInput",
    MotDePasseInput: "#passwordInput",
    BoutonSoumettre: "#submitButton",
  },
  Navigation: {
    MenuAffichages: "#MenuTop a[href$='Postes/Affichages']",
    MenuSuivi: "#MenuTop a[href$='SuiviPostulations']",
  },
  ConfirmationPostulation: {
    ConfirmationPasswordInput: "#passwordInput",
    BoutonConfirmer: ".boutonsPost, #boutonsPost, input[value='Postuler']",
  },
  SuiviDesPostulations: {
    GrilleActives: "#grid1 tbody.ui-iggrid-tablebody tr",
    GrilleInactives: "#grid2 tbody.ui-iggrid-tablebody tr",
    SelecteursColonnes: {
      Type: "td:nth-child(1)",
      NumeroPoste: "td:nth-child(2)",
      TitrePoste: "td:nth-child(3)",
      Entreprise: "td:nth-child(4)",
      Statut: "td:nth-child(5)",
    },
  },
  RechercheAffichages: {
    Formulaire: "#rechercheForm",
    ChampMotCle: "#FiltreRecherche_MotCle",
    BoutonRechercher: "#rechercherBtn",
    GrilleResultats: "#grid1 tbody.ui-iggrid-tablebody tr",
  },
  DetailsDuPoste: {
    NumeroPoste: "#spanTitreEmploiStage",
    NomEmployeur: "#divNomEmployeur",
    LignesInformations: ".ligneInfo",
    BoutonPostulerDetail: "#Postuler",
  },
} as const;

// ─── Domain value types ───────────────────────────────────────────────────────

/**
 * A row in the "Suivi des postulations" active/inactive grid.
 * Extracted column-by-column from the Infragistics ui-iggrid table.
 */
export interface PostulationRow {
  /** e.g. "Stage", "Emploi" */
  readonly type: string;

  /** Unique post identifier on the ETS portal (e.g. "2024-A-1234") */
  readonly numeroPoste: string;

  /** Job / internship title */
  readonly titrePoste: string;

  /** Employer / company name */
  readonly entreprise: string;

  /** Application status (e.g. "Soumise", "En traitement", "Refusée") */
  readonly statut: string;
}

/**
 * A key/value pair extracted from a `.ligneInfo` div pair:
 *   <div class="ligneInfo"><div>Label</div><div>Value</div></div>
 */
export interface InfoLigne {
  readonly label: string;
  readonly value: string;
}

/**
 * Full detail page for a single job posting, including all `.ligneInfo` pairs.
 */
export interface PosteDetail {
  /** Raw numero/titre as displayed in #spanTitreEmploiStage */
  readonly numeroPosto: string;

  /** Title extracted from the search grid */
  readonly titrePoste?: string | undefined;

  /** Employer name from #divNomEmployeur */
  readonly nomEmployeur: string;

  /** Structured key/value pairs from .ligneInfo elements */
  readonly informations: readonly InfoLigne[];

  /** Rich job description HTML block from .divBoiteBleu */
  readonly descriptionHtml: string;

  /** Canonical URL of the detail page */
  readonly detailUrl: string;

  /**
   * How the application is handled:
   * - 'full'     — Can apply directly on Flex portal
   * - 'external' — Must apply on the employer's own website
   * - 'applied'  — Already applied (postulation submitted)
   * - 'unknown'  — Could not be determined
   */
  readonly applicationMode: 'full' | 'external' | 'applied' | 'unknown';
}

/**
 * A new posting found in the Affichages search grid.
 * Minimal shape — full details require a subsequent `getPosteDetail()` call.
 */
export interface AffichageRow {
  /** Portal-assigned post number */
  readonly numeroPoste: string;

  /** Title extracted from the search grid */
  readonly titrePoste?: string | undefined;

  /** Direct URL to the posting detail page */
  readonly detailUrl: string;
}

/**
 * Result of a full portal scraping session.
 */
export interface ScrapingResult {
  /** Active postulations from the "Suivi des postulations" grid */
  readonly postulationsActives: readonly PostulationRow[];

  /** Inactive / archived postulations */
  readonly postulationsInactives: readonly PostulationRow[];

  /** New affichages found via the search form */
  readonly nouveauxAffichages: readonly PosteDetail[];

  /** ISO 8601 timestamp when the scraping run started */
  readonly startedAt: string;

  /** ISO 8601 timestamp when the scraping run finished */
  readonly finishedAt: string;
}

/**
 * Raw placement shape — kept for backwards compat with IPlacementRepository.
 * Constructed by the adapter from a `PosteDetail`.
 */
export interface RawPlacementListing {
  readonly portalId: string;
  readonly title: string;
  readonly organisation: string;
  readonly location: string;
  readonly deadlineDate: string | null;
  readonly descriptionHtml: string;
  readonly detailUrl: string;
  readonly scrapedAt: string;
  readonly applicationMode: 'full' | 'external' | 'applied' | 'unknown';
}

// ─── Scraper options ──────────────────────────────────────────────────────────

export interface ScraperOptions {
  /** Portal URLs — all loaded from environment variables, never hardcoded */
  readonly urls: EtsUrls;

  /** ETS ADFS credentials */
  readonly credentials: {
    readonly email: string;
    readonly password: string;
  };

  /** Whether to run the browser in headless mode */
  readonly headless: boolean;

  /** Navigation timeout in milliseconds (default: 30 000) */
  readonly timeoutMs: number;

  /** Path to the persistent browser user data directory */
  readonly userDataDir?: string;

  /**
   * Optional list of portal IDs (job numbers) that are already known.
   * Scrapers can skip downloading the details page for these postings.
   */
  readonly excludePortalIds?: readonly string[];

  /**
   * Optional search keyword for the Affichages search form.
   * When omitted the search form is submitted empty (all results).
   */
  readonly searchKeyword?: string;
}

// ─── Port interface ───────────────────────────────────────────────────────────

/**
 * IEtsScraper — Primary port for the ETS Placement Flex portal.
 *
 * Implementations live in `src/infrastructure/adapters/`.
 * The domain and application layers program against this interface only.
 */
export interface IEtsScraper {
  /**
   * Authenticates against the ETS ADFS SSO portal.
   * Must be called before any other method.
   *
   * @throws {ScraperAuthError} when credentials are rejected or the SSO
   *   login form cannot be found.
   */
  authenticate(credentials: ScraperOptions["credentials"]): Promise<void>;

  /**
   * Navigates to "Suivi des postulations" and extracts both active
   * and inactive postulation rows from the two ui-iggrid tables.
   *
   * @throws {ScraperError} when the grid is not found within the timeout.
   */
  getPostulationsActives(): Promise<{
    readonly actives: readonly PostulationRow[];
    readonly inactives: readonly PostulationRow[];
  }>;

  /**
   * Navigates to "Affichages", optionally filters by keyword, then
   * extracts each result row and fetches its full detail page.
   *
   * @param keyword - Optional filter keyword (empty = all results).
   * @throws {ScraperError} when the results grid is not found.
   */
  getNouveauxAffichages(
    keyword?: string,
    excludePortalIds?: readonly string[],
  ): Promise<readonly PosteDetail[]>;

  /**
   * Fetches the detail page for a single posting.
   *
   * @param detailUrl - Absolute URL of the posting's detail page.
   * @param titrePoste - Optional title extracted from the grid.
   */
  getPosteDetail(detailUrl: string, titrePoste?: string): Promise<PosteDetail>;

  /**
   * Submits an application for a posting.
   * Fills the confirmation password field and clicks the submit button.
   *
   * @param detailUrl - The absolute detail URL of the posting to apply to.
   * @param password - Re-entered ETS password required by the confirmation form.
   * @throws {ScraperError} when the apply button is not found.
   */
  postuler(detailUrl: string, password: string): Promise<void>;

  /**
   * Performs a complete session: authenticate → suivi → affichages.
   * Convenience wrapper used by the application use-case.
   */
  scrape(options: ScraperOptions): Promise<ScrapingResult>;

  /**
   * Checks if the scraper is currently showing the site down / inaccessible screen.
   */
  isSiteDown(): Promise<boolean>;

  /**
   * Captures a screenshot of the current page.
   */
  takeScreenshot(): Promise<Buffer | null>;

  /**
   * Releases browser resources. Must be called in a finally block.
   */
  dispose(): Promise<void>;
}

// ─── Domain error types ───────────────────────────────────────────────────────

export class ScraperError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ScraperError";
  }
}

export class ScraperAuthError extends ScraperError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
    this.name = "ScraperAuthError";
  }
}

export class TokenExpiredError extends ScraperAuthError {
  constructor(message: string = "Session token expired mid-scrape. Redirected to ADFS.", context?: Record<string, unknown>) {
    super(message, context);
    this.name = "TokenExpiredError";
  }
}
