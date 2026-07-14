# FlexPlus Scraper

A headless Node.js microservice that automates scraping the ETS Placement Flex portal. It extracts job postings, scores their relevance using AI (OpenAI-compatible APIs like Gemini/Groq), and sends interactive notifications to Discord. 

### Table of Contents

| Section | Description |
| :--- | :--- |
| 🚀 [Features](#features) | Key highlights and capabilities of the scraper |
| 📐 [Architecture](#architecture) | Hexagonal Architecture overview and relation diagrams |
| 🛠️ [Installation & Setup](#installation--setup) | Setup procedures, environment options, and configuration references |
| 🎮 [Usage (Discord Commands)](#usage-discord-commands) | Available commands and usage documentation |
| 🔍 [Troubleshooting](#troubleshooting) | Resolutions for common installation and running problems |

## Features
- **Automated Scraping**: Uses Playwright with persistent browser contexts to bypass ADFS SSO and extract job details.
- **AI Relevance Filtering**: Scores postings based on a candidate profile. Falls back to a secondary AI provider if the primary fails.
- **Interactive Discord Notifications**: Sends rich embed alerts with direct "Quick Apply" buttons.
- **MFA Flow via Discord**: Automatically detects session expiration and prompts the user on Discord to approve MFA on their phone.
- **Hexagonal Architecture**: Strict separation of concerns ensuring domain logic is isolated from external dependencies (DB, UI, APIs).

## Architecture

This project strictly adheres to Hexagonal Architecture (Ports and Adapters):

```mermaid
flowchart LR
    %% Primary Adapters (Driving)
    Cron(["⏱️ Cron Scheduler"])
    DiscordUser(["🎮 Discord User"])

    %% The Hexagon (Core)
    CORE{{ <b>Core Domain</b><br/>ScrapeAndFilterUseCase }}

    %% Secondary Adapters (Driven)
    EtsAdapter["PlaywrightEtsAdapter"]
    DbAdapter["SqlitePlacementRepository"]
    AiAdapter["OpenAiCompatAIFilterAdapter"]
    BotAdapter["DiscordBotAdapter"]

    %% External Systems
    ETS[("🌐 ETS Portal")]
    DB[("💾 SQLite")]
    AI[("🧠 AI API")]
    DiscordSys[("💬 Discord API")]

    %% Relationships (Driving)
    Cron -->|Triggers| CORE
    DiscordUser -->|Commands| BotAdapter
    BotAdapter -->|Triggers| CORE

    %% Relationships (Driven)
    CORE -->|IEtsScraper| EtsAdapter
    CORE -->|IPlacementRepository| DbAdapter
    CORE -->|IAIFilter| AiAdapter
    CORE -->|INotification| BotAdapter
    
    %% Relationships (External)
    EtsAdapter -->|Scrapes| ETS
    DbAdapter -->|Read/Write| DB
    AiAdapter -->|Scores| AI
    BotAdapter -->|Embeds| DiscordSys

    %% Styling
    classDef core fill:#d8b4e2,stroke:#333,stroke-width:2px,color:#000;
    classDef adapter fill:#a9d18e,stroke:#333,stroke-width:1px,color:#000;
    classDef external fill:#bdd7ee,stroke:#333,stroke-width:1px,color:#000;
    
    class CORE core;
    class EtsAdapter,DbAdapter,AiAdapter,BotAdapter adapter;
    class ETS,DB,AI,DiscordSys external;
```

## Installation & Setup

We recommend running this service via Docker to avoid OS-level Playwright and dependency issues.

1. **Clone the repository:**
   ```bash
   git clone <repo-url>
   cd FlexPlus
   ```

2. **Configure Environment:**
   Copy the example config and fill in your credentials.
   ```bash
   cp .env.example .env
   ```
   
   Below is the detailed configuration board for all environment variables supported in `.env`. Required settings must be explicitly defined.

   ### Configuration Board

   | Environment Variable | Requirement | Default Value | Description & Format Restrictions |
   | :--- | :--- | :--- | :--- |
   | [`ETS_EMAIL`](#ets_email) | **Required** | *None* | Valid ÉTS email address used to log in via ADFS SSO. |
   | [`ETS_PASSWORD`](#ets_password) | **Required** | *None* | Password for the ÉTS student portal. |
   | [`ETS_BASE_URL`](#ets_base_url) | Optional | `https://see.etsmtl.ca` | Target base URL of the Placement Flex portal. |
   | [`AI_PROVIDER`](#ai_provider) | Optional | `gemini` | Provider preset: `gemini`, `openai`, `groq`, `mistral`, `openrouter`, or `ollama`. |
   | [`AI_API_KEY`](#ai_api_key) | **Required** | *None* | API key for the chosen AI provider (except when using `ollama`). |
   | [`AI_BASE_URL`](#ai_base_url) | Optional | *Preset URL* | Overrides the endpoint URL (useful for self-hosted or proxy services). |
   | [`AI_MODEL`](#ai_model) | Optional | *Preset Model* | Specific model string for categorization and relevance scoring. |
   | [`AI_BATCH_SIZE`](#ai_batch_size) | Optional | `10` | Max postings scored per API call. Reduce if context limits are hit. |
   | [`AI_TEMPERATURE`](#ai_temperature) | Optional | `0` | Generation temperature. Must be a decimal float between `0` and `1`. |
   | [`AI_CANDIDATE_PROFILE`](#ai_candidate_profile) | Optional | *Student profile* | Candidate bio injected into prompts to personalize scoring. |
   | [`AI_RELEVANCE_THRESHOLD`](#ai_relevance_threshold) | Optional | `60` | Minimum score `0-100` required to notify of a new placement. |
   | [`AI_BACKUP_PROVIDER`](#ai_backup_provider) | Optional | `openai` | Backup provider preset to fallback on if the primary fails. |
   | [`AI_BACKUP_API_KEY`](#ai_backup_api_key) | Optional | *None* | API key for the failover AI provider. |
   | [`AI_BACKUP_BASE_URL`](#ai_backup_base_url) | Optional | *Preset URL* | Custom endpoint URL override for the failover AI provider. |
   | [`AI_BACKUP_MODEL`](#ai_backup_model) | Optional | *Preset Model* | Specific model string for failover runs. |
   | [`FILTER_ALLOWED_LOCATIONS`](#filter_allowed_locations) | Optional | *None* | Comma-separated list of allowed cities (empty = all allowed). |
   | [`FILTER_EXCLUDED_LOCATIONS`](#filter_excluded_locations) | Optional | *None* | Comma-separated list of cities to filter out immediately. |
   | [`FILTER_EXCLUDED_KEYWORDS`](#filter_excluded_keywords) | Optional | *None* | Comma-separated title keywords to skip before scoring (e.g. QA, Test). |
   | [`AI_CUSTOM_PROMPT`](#ai_custom_prompt) | Optional | *None* | Custom prompt instructions/rubrics telling the AI how to score. |
   | [`DATABASE_PATH`](#database_path) | Optional | `./data/flexplus.db` | Directory path where SQLite database file is stored. |
   | [`DISCORD_BOT_TOKEN`](#discord_bot_token) | **Required** | *None* | Bot token generated in the Discord Developer portal. |
   | [`DISCORD_CHANNEL_ID`](#discord_channel_id) | **Required** | *None* | Numeric ID of the Discord channel where alerts are posted. |
   | [`DISCORD_IMPORTANT_TAG`](#discord_important_tag) | Optional | *None* | Mention string `<@id>` or `<@&id>` for critical errors/MFA. |
   | [`DISCORD_ALLOWED_USERS`](#discord_allowed_users) | **Required** | *None* | Comma-separated Discord user IDs allowed to interact with the bot. |
   | [`SCRAPER_CRON`](#scraper_cron) | Optional | `0 */6 * * *` | Standard cron pattern to regulate the scraping frequency. |
   | [`SCRAPER_JITTER_MIN_SEC`](#scraper_jitter_min_sec) | Optional | `0` | Minimum delay in seconds applied to the cron runs. |
   | [`SCRAPER_JITTER_MAX_SEC`](#scraper_jitter_max_sec) | Optional | `300` | Maximum delay in seconds to humanise scraper start times. |
   | [`PLAYWRIGHT_HEADLESS`](#playwright_headless) | Optional | `true` | Sets browser headless mode (`true` or `false`). |
   | [`PLAYWRIGHT_TIMEOUT_MS`](#playwright_timeout_ms) | Optional | `30000` | Playwright action and navigation timeout limit in milliseconds. |
   | [`PLAYWRIGHT_USER_DATA_DIR`](#playwright_user_data_dir) | Optional | `./data/browser-context` | Directory where browser cache and session cookies are persisted. |
   | [`AUTO_APPLY`](#auto_apply) | Optional | `false` | Automatically submit postulations for high-scoring offers (RISKY). |
   | [`LOG_LEVEL`](#log_level) | Optional | `info` | Logs level filters: `error`, `warn`, `info`, or `debug`. |
   | [`NODE_ENV`](#node_env) | Optional | `development` | Node environment config: `development` or `production`. |

   ---

   ### Advanced Settings Details

   #### ETS Portal Credentials
   - **`ETS_EMAIL`**: Required. Format must match your student address (e.g., `firstname.lastname.1@ens.etsmtl.ca`).
   - **`ETS_PASSWORD`**: Required. SSO login credentials.
   - **`ETS_BASE_URL`**: Useful if the university changes the entrypoint portal domain.

   #### AI Filtering Configuration
   - **`AI_PROVIDER` presets**:
     - `gemini`: Uses standard OpenAI SDK pointing to Gemini API (Preset URL: `https://generativelanguage.googleapis.com/v1beta/openai/`, Default model: `gemini-3.5-flash` or `gemini-3.1-flash-lite`).
     - `openai`: Pointing to OpenAI (Preset URL: `https://api.openai.com/v1`, Default model: `gpt-4o-mini`).
     - `groq`: Pointing to Groq Cloud API (Preset URL: `https://api.groq.com/openai/v1`, Default model: `llama-3.1-8b-instant`).
     - `mistral`: Pointing to Mistral Platform (Preset URL: `https://api.mistral.ai/v1`, Default model: `mistral-small-latest`).
     - `openrouter`: Pointing to OpenRouter (Preset URL: `https://openrouter.ai/api/v1`).
     - `ollama`: Pointing to local Ollama (Preset URL: `http://localhost:11434/v1`).
   - **`AI_BACKUP_PROVIDER`**: Serves as a hot-fallback. If the primary API returns errors or hits rate limits, the scraper switches to this config.

   #### Pre-filtering & Scoring Guidance
   - **`FILTER_ALLOWED_LOCATIONS`**: Case-insensitive substring filtering on location before invoking AI (saves tokens). E.g. `Montréal, Remote`.
   - **`FILTER_EXCLUDED_KEYWORDS`**: Skips positions with matching titles immediately. Highly recommended to filter out `QA, Test, Stage` if you only want developer positions.
   - **`AI_CUSTOM_PROMPT`**: Injected into the core system instructions. E.g. `Strictly penalize suburbs. Exclude roles using legacy Java frameworks.`

   #### Discord Integration & Access Control
   - **`DISCORD_BOT_TOKEN`** & **`DISCORD_CHANNEL_ID`**: Required to initialize the bot. Message Content Intent and Server Members Intent must be enabled in Discord's developer settings.
   - **`DISCORD_ALLOWED_USERS`**: Explicit user authorization list. **Crucial restriction**: if left empty, anyone in the server can execute critical commands like `!auth` or `!run`. Enter your Discord user ID (Numeric).
   - **`DISCORD_IMPORTANT_TAG`**: Mention format. Example: `<@1234567>` for user or `<@&1234567>` for role.

   #### Scheduler & Humanisation
   - **`SCRAPER_CRON`**: Cron syntax (`* * * * *`). The default is run every 6 hours. For humanisation, `.env.example` sets it to run every 20 minutes from 8am to 5pm (`*/20 8-17 * * 1-5`).
   - **Jitter Settings**: Delay cron jobs randomly using `SCRAPER_JITTER_MIN_SEC` and `SCRAPER_JITTER_MAX_SEC` to prevent the scraper from executing exactly on the 20-minute mark (which is a signature bot behavior).

   #### Playwright Caching & Auto-Apply
   - **`PLAYWRIGHT_USER_DATA_DIR`**: Persistent context cache. Stores ADFS session cookies to avoid requesting MFA approvals on every cron run.
   - **`AUTO_APPLY`**: Extremely risky. If enabled, the system fills the portal password confirmation field and applies automatically if AI score > relevance threshold. Keep disabled (`false`).

   #### Free AI API Options

   To run the FlexPlus scraper without any hosting or model API costs, you can configure any of the following free-tier presets:

   1. **Google Gemini API (Recommended)**
      - **Free Tier**: Google provides a free developer tier in Google AI Studio for prototyping and testing.
      - **Configuration**:
        ```ini
        AI_PROVIDER=gemini
        AI_API_KEY=your_gemini_api_key
        AI_MODEL=gemini-3.5-flash      # Or gemini-3.1-flash-lite
        ```

   2. **Groq Cloud**
      - **Free Tier**: Groq offers free access to open-weights models through their developer platform.
      - **Configuration**:
        ```ini
        AI_PROVIDER=groq
        AI_API_KEY=your_groq_api_key
        AI_MODEL=llama-3.1-8b-instant
        ```

   3. **OpenRouter**
      - **Free Tier**: OpenRouter hosts several free open-source models.
      - **Configuration**:
        ```ini
        AI_PROVIDER=openrouter
        AI_API_KEY=your_openrouter_free_key
        AI_MODEL=meta-llama/llama-3-8b-instruct:free
        ```

   4. **Mistral AI**
      - **Free Tier**: Mistral provides a free developer platform tier (La Plateforme) for model testing.
      - **Configuration**:
        ```ini
        AI_PROVIDER=mistral
        AI_API_KEY=your_mistral_api_key
        AI_MODEL=mistral-small-latest
        ```

   5. **Ollama (Self-Hosted)**
      - **Free Tier**: Completely offline, private, and unlimited local model execution.
      - **Configuration**:
        ```ini
        AI_PROVIDER=ollama
        AI_BASE_URL=http://localhost:11434/v1
        AI_MODEL=gemma2
        AI_API_KEY=not_needed
        ```

3. **Deploy using Docker Compose:**
   Start the production daemon in the background.
   ```bash
   docker compose up -d --build
   ```

4. **Initial Authentication:**
   - Watch the Discord channel. The bot will notify you when it needs MFA approval. 
   - Click "Prêt pour le MFA", approve the prompt on your phone matching the code provided by the bot.

## Usage (Discord Commands)

Authorized users (defined in `DISCORD_ALLOWED_USERS`) can control the bot directly from Discord:
- `!status` - Check if the scraper is running, standby, or requires MFA.
- `!run` - Manually force a scrape cycle immediately.
- `!auth` - Force a session wipe and restart the MFA process.
- `!help` - Display available commands.

## Troubleshooting

| Issue | Cause & Solution |
|-------|------------------|
| **Bot replies twice to `!status`** | The bot token is running in two environments simultaneously. Ensure you don't have the script running locally and in Docker at the same time. If lost, reset the Discord Bot Token in the Developer Portal. |
| **Chromium crashing in Docker** | Ensure your Docker host provides enough shared memory. The `docker-compose.yml` sets `shm_size: "512mb"` and `SYS_ADMIN` capabilities which are required for Chromium to run smoothly. |
| **"Target page, context or browser has been closed"** | ADFS timeout or the Playwright session crashed. Run `!auth` in Discord to clear the corrupted session and force a fresh login. |
| **MFA code not showing up on phone** | The ETS ADFS portal timed out waiting for the prompt. Click "Prêt pour le MFA" again in Discord or use `!auth` to restart the flow. |
| **TypeScript Build Errors (`npx.ps1` restricted)** | If you receive PowerShell execution policy errors locally, build using `npm run build` instead of relying on `npx` directly. |
