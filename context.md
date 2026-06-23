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

---

## 🛠️ Technology Stack & Hosting Framework

* **Version Control:** Single Monorepo Repository containing `/bot` and `/web` workspace directories.
* **Database Engine:** Supabase (Cloud-hosted PostgreSQL platform).
* **Live Match Data Feeds:** API-Football (via API-Sports gateway). Operating on the Free Tier tier (capped at 100 requests per day) for score calculations and group scheduling.
* **Primary Deployment Architecture (Vercel Serverless Platform):**
  * **Frontend Web Application:** Automatically builds and deploys from the `/web` subdirectory using Vercel serverless distribution.
  * **Discord Bot Runtime:** Configured as a stateless HTTP Webhook receiver endpoint (`/web/api/interactions.js`) hosted natively on Vercel. 
  * **The 3-Second Timeout Safeguard:** To completely bypass Vercel cold starts and prevent Discord's strict 3-second response timeout, all heavy calculations (Supabase writes/API fetches) **MUST use deferred responses** (`InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`). The bot instantly acknowledges the ping, then uses the Discord Webhooks API asynchronously to edit/update the panel embeds once calculations complete.
* **Fallback Backup Architecture (JustRunMy.App):**
  * In the event of a structural migration, the `/bot` can run a traditional, persistent background event loop (`client.on('interactionCreate')`) hosted on JustRunMy.App. 
  * *Operational Constraint:** Requires manual interaction token resets every three days to prevent environment sleep states.

---

## 📁 Repository Directory Structure

### Primary Architecture (Vercel Serverless Routing)
├── .github/                  # Global GitHub Actions workflows
├── bot/                      # Discord Interaction Code Assets
│   ├── src/
│   │   └── interactions.js   # Main processing logic for webhook payloads
│   └── package.json          # Serverless execution dependencies
└── web/                      # Full-Stack Website Workspace
    ├── index.html            # Web layout entry point
    ├── src/                  # Tailwind CSS modules, Leaderboard rows, Profile layouts
    ├── api/
    │   └── interactions.js   # Vercel serverless function routing the Discord Webhook
    ├── package.json          # Core development and bundler configs
    └── vercel.json           # Secure environment overrides and URL endpoint rules

### Backup Architecture (Traditional Monolith for JustRunMy.App)
├── .github/                  # Global GitHub Actions workflows
├── bot/                      # Persistent Background Bot Loop Folder
│   ├── index.js              # Continuous active event listener loop
│   ├── database.js           # Shared Supabase pooling initializer
│   ├── package.json          # Node modules (discord.js, @supabase/supabase-js)
│   └── Dockerfile            # Container deployment blueprint for JustRunMy.App
└── web/                      # Static Dashboard Workspace
    ├── index.html            
    ├── src/                  
    └── package.json          

---

## 🧠 Core Game Mechanics & Data Logic

### 1. The Payout & Dynamic Boosted Pool Formula
Standard wagers alter payout returns using an internal pool model. Heavy public favorites yield smaller rewards; underdog selections scale up based on relative token distribution.

$$Payout = \left(\frac{Boosted Pool}{Winning Tokens}\right) \times Your Bet + Base Reward$$

### 2. Anti-Inflation Multiplier Guardrails
To protect the economy from printing endless tokens on overwhelmingly obvious matches, the payout multiplier is restricted by the group's exact vote share distribution:
* **Massive Favorite Wins (Vote Share > 80%):** Pool multiplier drops to **1.0x** (Standard Pool Split, zero artificial scaling).
* **Normal Outcomes (Vote Share 50% - 80%):** Standard split model (**1.0x** pool boost).
* **Mild Underdog Upsets (Vote Share 20% - 50%):** Triggers an artificial **1.2x or 1.3x** pool boost out of thin air.
* **Miracle Underdog Jackpots (Vote Share < 20%):** Triggers a maximum **1.5x ultimate jackpot** pool boost to reward extreme risky strategies.

### 3. Free-Vote System (Bankruptcy Protection)
* Users possessing exactly 0 tokens (or those refusing to risk their bankroll) can submit a **Free Vote**.
* Free votes bypass standard math calculations entirely and do not dilute the main wagering token pool.
* Correct predictions award a flat, hardcoded static reward of **+5 tokens** directly from the system bank.

### 4. Wager Modification / Re-entry
Users are allowed to edit active predictions prior to match kickoff. If a user tries to place a bet on an already predicted `fixture_id`, the system prompts a warning confirmation box. Confirming updates the row via a Supabase `UPSERT`, cleanly overwriting the previous bet data record.

---

## 🎨 User Interface & Panel Layout Architectures

### Discord Embed Guidelines
All system messages must output clean, color-coded embeds:
* **Green:** Operation success and wager confirmations.
* **Blue:** Master Panel summaries and profile dashboard panels.
* **Gold:** Milestone jackpot payouts and high-roller returns.
* **Red:** Error alerts, system warnings, and overwrite confirmations.

#### The Master Events Panel (The Server Hub)
An admin-initialized message string that updates dynamically over time.
* **Time Target:** Displays upcoming matches scheduled for "Today" and "Tomorrow" calculated relative to **Australian Timezones (AEST/AEDT)**.
* **Formatting:** Uses country flags, team names, and native dynamic Discord timestamps (`<t:TIMESTAMP:F>`) so kickoff parameters localize to each player's device settings.
* **The Spy Metric:** Embed text updates dynamically to reflect the current live token/vote split distribution across options. Real-world odds strings are omitted to prevent layout clutter.
* **Component Row Mapping:** To navigate around Discord's 5x5 interaction component limits, individual match buttons are replaced with organized selector dropdowns:
  * **Dropdown 1 (Match Selector):** Lists scheduled available games. Selection triggers the wager phase.
  * **Dropdown 2 (Prediction Selector):** Allows picking Home, Away, or Draw.
  * **Modal Input Box:** Launches a native pop-up textbox demanding the token wager amount (accepts 0 for Free Votes).
  * **Button A ("Show Estimated Earnings"):** Ephemeral-only response showing projected payout metrics based on the current live pool formula state.
  * **Button B ("View My History"):** Ephemeral profile embed mapping personal historical wins, losses, and cumulative token changes.

### 🖥️ Web Dashboard Layout & Full-Stack Capabilities
The web front-end matches the feature capabilities of the bot, utilizing a premium Dark-Mode sports analytic style built with Tailwind CSS.

* **Discord OAuth2 Login:** Authenticates users via Discord profile tokens. Grabs and synchronizes real user metadata to the database instantly.
* **Rich Profiles UI:** Leaderboard fields combine the user's bold **Display Name**, lowercase `@username` handles, and circular **Profile Pictures (pfp)** fetched straight from Discord's Content Delivery Network (CDN).
* **The Interactive Match Arena:** Allows logged-in browser users to track live token progress bars ("The Spy Metric"), view projected payout changes, and submit/edit match wagers using a secure web interface that calls backend serverless endpoints.
* **Public Betting Feed:** A real-time scrolling activity panel tracking global wager updates across the entire server community.

---

## 🗄️ Database Schema (Supabase Postgres SQL Script)

> **Note for Execution:** Run the entire block below inside the Supabase SQL Editor. It creates all 3 tables with appropriate relationship constraints, composite primary keys, and auto-incrementing tracking IDs.

```sql
-- 1. Setup Users Table
CREATE TABLE users (
    discord_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    tokens_balance INTEGER DEFAULT 1000
);

-- 2. Setup Matches Table
CREATE TABLE matches (
    fixture_id TEXT PRIMARY KEY,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    kickoff_time TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL,
    winner TEXT CHECK (winner IN ('home', 'away', 'draw', NULL))
);

-- 3. Setup Bets Table
CREATE TABLE bets (
    bet_id SERIAL PRIMARY KEY,
    user_id TEXT REFERENCES users(discord_id) ON DELETE CASCADE,
    fixture_id TEXT REFERENCES matches(fixture_id) ON DELETE CASCADE,
    team_picked TEXT CHECK (team_picked IN ('home', 'away', 'draw')),
    amount_wagered INTEGER NOT NULL,
    CONSTRAINT unique_user_fixture UNIQUE (user_id, fixture_id)
);