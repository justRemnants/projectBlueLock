# 🏆 Project Blue-Lock: World Cup Virtual Pool
### Global Project Specification & System Context

This document serves as the absolute "Source of Truth" for Project Blue-Lock. All codebase generators, refactoring tools, and conversational agents must strictly adhere to the architecture, schemas, and mathematical guardrails defined below.

---

## 📋 Project Overview
Project Blue-Lock is a hybrid Discord Bot and Web Dashboard application for a virtual World Cup betting game. Users wager fake tokens on real-world match outcomes. 

### Core Product Directives:
* **Asset-Light UI:** Avoid dense text commands. The Discord interface relies strictly on an interactive, color-coded, "Panel-driven" layout using dropdown components and modals.
* **Unified Database State:** A single cloud database acts as the synchronized backbone for both the active Discord bot and the interactive web frontend dashboard.
* **Frictionless Auth:** The web dashboard utilizes native Discord OAuth2 login, avoiding traditional password administration entirely and enabling rich user profiles.
* ⚠️ **Development Status Update:** The Web Dashboard component of Project Blue-Lock is currently scrapped/suspended for now. All active development, maintenance, and features are focused strictly on the Discord Bot ecosystem. The frontend specifications are preserved below for future reference, but are currently disabled in production.

---

## 🛠️ Technology Stack & Hosting Framework

* **Version Control:** Single Monorepo Repository containing `/bot` and `/web` workspace directories.
* **Database Engine:** Supabase (Cloud-hosted PostgreSQL platform).
* **Live Match Data Feeds:** Football-Data.org (via their free tier `WC` World Cup competition endpoint).
* **Primary Deployment Architecture (Vercel Serverless Platform):**
  * **Frontend Web Application:** Serves static files directly from the `/web/public` directory using Vercel's native static asset server.
  * **Discord Bot Runtime:** Configured as a stateless HTTP Webhook receiver endpoint (`/web/api/interactions.js`) hosted natively on Vercel. 
  * **Direct Response Architecture:** To guarantee instant execution and eliminate any possibility of Vercel container freezes, the bot bypasses deferred responses entirely. It executes lightweight database operations within 400ms and returns standard, direct HTTP responses (`R.MESSAGE` or Type 4).

### ⚠️ Monolithic Deployment Failures & Lessons Learned
During development, hosting the static frontend and the serverless APIs in the same `/web` directory initially failed with a `405 Method Not Allowed` on browser visits and blocked Discord interactions.

1. **The "main" Entrypoint Conflict:** The `/web/package.json` file originally contained the property `"main": "api/interactions.js"`. Under Vercel's Node.js framework preset, defining a `"main"` entrypoint instructs Vercel to treat the entire deployment as a single monolithic Node.js application, routing **all** incoming traffic (including your website `GET` requests) directly to `interactions.js`.
2. **The Resulting Crash:** Because `interactions.js` is programmed to reject any non-`POST` requests, browser visits were immediately blocked with `405 Method Not Allowed` by the serverless handler itself.
3. **The Static File-System Solution:** To resolve this, the `"main"` property was deleted from `package.json`, and the static frontend `index.html` was moved inside a dedicated `/web/public/` directory. This instructs Vercel to use isolated, directory-based routing: serving `/web/public/index.html` natively at the root `/` URL and routing `/api/` traffic exclusively to individual, sandboxed serverless handlers.

---

## 📁 Repository Directory Structure

### Primary Architecture (Vercel Serverless Routing)
Project-BlueLock/
├── .gitignore                  # Files for GitHub not to push to the repo
├── context.md                  # System specifications and absolute source of truth
├── projectbluelockdatabase.sql # SQL database initialization script for Supabase
├── bot/                        # Discord Interaction Code Assets (Gateway Client Backup)
│   ├── .env                    # Local credentials and private keys for the persistent bot
│   ├── .env.example            # Template outlining required credentials for the persistent bot
│   ├── index.js                # Continuous background event listener loop for the persistent bot
│   ├── package-lock.json       # Dependency lockfile tracking exact versions for the persistent bot
│   ├── package.json            # Gateway execution dependencies
│   └── src/
│       ├── database.js         # Persistent bot connection pool and database CRUD helpers
│       └── footballApi.js      # Persistent bot sports data synchronization parser
└── web/                        # Full-Stack Website Workspace
    ├── package-lock.json       # Dependency lockfile tracking exact versions for the web/api folder
    ├── package.json            # Dependencies & build scripts (no "main" entrypoint)
    ├── portugal.js             # Custom DM for Portugal winning, with an admin bonus of 100 on top of winnings from bets
    ├── vercel.json             # Secure environment overrides and cron rules
    ├── api/
    │   ├── interactions.js     # Discord Webhook command handler (direct-response)
    │   └── cron/
    │       └── sync.js         # Daily automated sync endpoint to process match and payout calculations
    ├── scripts/
    │   ├── history.js          # Admin CLI tool to trigger the interactive, paginated history DM console
    │   ├── leaderboard.js      # Admin CLI tool to publish a public standings card to the events channel
    │   └── register-commands.js# Developer utility to register slash command schemas with Discord's API
    └── src/
        ├── database.js         # Web-optimized Supabase pool client
        ├── footballApi.js      # Sync engine, automated payouts, & DM notifier
        └── panel.js            # Unified panel layouts (aligned spy metrics & flags)

---

## 🧠 Core Game Mechanics & Data Logic

### 1. The Payout & Dynamic Boosted Pool Formula
Standard wagers alter payout returns using an internal pool model. Heavy public favorites yield smaller rewards; underdog selections scale up based on relative token distribution.

$$Payout = \left(\frac{Boosted Pool}{Winning Tokens}\right) \times Your Bet + Base Reward$$

### 2. Anti-Inflation Multiplier Guardrails
To protect the economy from printing endless tokens on overwhelmingly obvious matches, the payout multiplier is restricted by the group's exact vote share distribution:
* **Massive Favorite Wins (Vote Share > 80%):** Pool multiplier drops to **1.0x** (Standard Pool Split, zero artificial scaling).
* **Normal Outcomes (Vote Share 50% - 80%):** Standard split model (**1.0x** pool boost).
* **Mild Underdog Upsets (Vote Share 20% - 50%):** Triggers an artificial **1.1x** pool boost.
* **Miracle Underdog Jackpots (Vote Share < 20%):** Triggers a maximum **1.2x ultimate jackpot** pool boost.

### 3. Dynamic Base Reward (20% Wager Ceilings)
To reward high rollers while maintaining bankruptcy protection, the base reward scales proportionally with risk:
* **Free Votes (Wager = 0):** Correct predictions award a flat, static **+5 tokens** directly from the system bank.
* **Standard Bets (Wager > 0):** Correct predictions award a dynamic base reward of **20% of the amount wagered** (rounded to the nearest integer).

### 4. Maximum Bet Allowed (30% Wealth Ceiling)
To prevent players from inflating their wagers beyond safety and risking bankruptcy in a single match, wagers are strictly capped. The maximum allowed bet on any single match is calculated dynamically:
$$\text{Max Bet Allowed} = \min(\lfloor\text{Total Wealth} \times 0.30\rfloor, 300)$$
Where:
$$\text{Total Wealth} = \text{Wallet Balance} + \text{All Currently Active Bets}$$
Because this calculates total wealth dynamically, placing wagers simply shifts tokens from your wallet to active wagers without reducing your baseline wealth. Your maximum bet limit remains perfectly stable throughout an active betting round.

---

## 🎨 User Interface & Panel Layout Architectures

### Discord Embed Guidelines
All system messages must output clean, color-coded embeds:
* **Green:** Operation success, wager confirmations, and winning results.
* **Blue:** Master Panel summaries, profile dashboards, and match refunds.
* **Gold:** Leaderboard standings, milestones, and high-roller returns.
* **Red:** Error alerts, system warnings, and failed interactions.

#### The Master Events Panel (The Server Hub)
An admin-initialized message string that updates dynamically over time.
* **Time Target:** Displays upcoming matches scheduled for "Today" and "Tomorrow" calculated relative to **USA Eastern Time (EST/EDT - America/New_York)**.
* **Formatting:** Uses country flags, team names, and native dynamic Discord timestamps so kickoff parameters localize to each player's device settings.
* **The Spy Metric:** Embed text updates dynamically to reflect the current live token/vote split distribution across options. To prevent alignment clipping on narrow mobile screens, team names are shortened dynamically, progress bars are kept to a compact length (6 characters), and names are padded in monospaced blocks.

---

## 🖥️ Web Dashboard Layout & Full-Stack Capabilities
⚠️ **Development Status Update:** The Web Dashboard component described below is currently **scrapped/suspended** and disabled in active builds.
The branch has been deleted and all files for the web dashboard have been removed from the repo however I can still access the files so let me know if and when you need them.

The web front-end matches the feature capabilities of the bot, utilizing a premium Dark-Mode sports analytic style built with Tailwind CSS.

* **Discord OAuth2 Login:** Authenticates users via Discord profile tokens. Grabs and synchronizes real user metadata to the database instantly.
* **Rich Profiles UI:** Leaderboard fields combine the user's bold **Display Name**, lowercase `@username` handles, and circular **Profile Pictures (pfp)** fetched straight from Discord's Content Delivery Network (CDN).
* **The Interactive Match Arena:** Allows logged-in browser users to track live token progress bars ("The Spy Metric"), view projected payout changes, and submit/edit match wagers using a secure web interface that calls backend serverless endpoints.
* **Public Betting Feed:** A real-time scrolling activity panel tracking global wager updates across the entire server community.

---

## 🗄️ Database Schema (Supabase Postgres SQL Script)

```sql
-- 1. Setup Users Table
CREATE TABLE public.users (
    discord_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    tokens_balance INTEGER DEFAULT 500 NOT NULL
);

-- 2. Setup Matches Table
CREATE TABLE public.matches (
    fixture_id TEXT PRIMARY KEY,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    kickoff_time TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL,
    winner TEXT CHECK (winner IN ('home', 'away', 'draw', NULL))
);

-- 3. Setup Bets Table
CREATE TABLE public.bets (
    bet_id SERIAL PRIMARY KEY,
    user_id TEXT REFERENCES public.users(discord_id) ON DELETE CASCADE,
    fixture_id TEXT REFERENCES public.matches(fixture_id) ON DELETE CASCADE,
    team_picked TEXT NOT NULL CHECK (team_picked IN ('home', 'away', 'draw')),
    amount_wagered INTEGER NOT NULL CHECK (amount_wagered >= 0),
    settled BOOLEAN DEFAULT false NOT NULL,
    CONSTRAINT unique_user_fixture UNIQUE (user_id, fixture_id)
);

-- 4. Setup System Config Table
CREATE TABLE public.system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);