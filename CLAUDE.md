# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

UMA Helper Bot — a Discord bot that automates recording proposal/ticket data from Discord channels and threads into Google Sheets. It processes "CLOSING:" message blocks for structured data extraction, supports automatic scanning of `proposal-*` channels, and integrates with Ticket Tool for post-processing actions.

## Commands

```bash
npm install                  # Install dependencies
node index.js                # Run the bot
node deploy_commands.js      # Register slash commands with Discord API
```

No build step, test suite, or linter is configured. The project runs plain JavaScript directly with Node.js.

## Architecture

**Single-file bot**: All logic lives in `index.js` (~4000 lines). There is no module/plugin system — commands, events, and processing logic are all in one file.

### Key Components in index.js

- **Event handlers**: `ready`, `messageCreate`, `channelCreate`, `interactionCreate` — all registered via `client.on()`
- **Ticket processing pipeline** (`processTicketChannel()`): Validates channel eligibility → extracts proposal ID from channel name → finds Oracle/Snapshot links via regex → parses CLOSING block → validates data → upserts to Google Sheets → posts summary → triggers post-processing
- **Thread processing pipeline** (`processThread()`): Similar flow but writes to a separate "Findoors" sheet tab and supports `(findoor)` user annotations
- **Automatic scanner** (`performMassScan()`): `setTimeout`-based loop that scans all `proposal-*` channels at a configurable interval. Uses lock flags (`isMassScanInProgress`) to prevent concurrent scans
- **Dispute thread monitor**: Tracks per-user participation in dispute threads via `disputeParticipationCache`, enforces one-message-per-user and no-reply rules
- **OO Live Feed monitor**: Watches a specific channel for oracle/snapshot links and creates fallback tickets via a queue system (`fallbackQueue` + `processFallbackQueue()`)
- **Slash commands** (`/config`, `/scan_status`, `/stats`): Admin configuration panel, scan status, and data statistics

### Data Flow

```
Discord channels/threads
  → !record / !recordt / auto-scan
  → processTicketChannel() / processThread()
  → Parse CLOSING block + extract metadata
  → upsertRowByOrderValue() / upsertRowByOoLink()
  → Google Sheets API (JWT auth)
  → Post-processing: $close / $delete via Ticket Tool
```

### External Integrations

- **Google Sheets** (`google-spreadsheet` + `google-auth-library`): Two worksheets — "Verification" for tickets, "Findoors" for threads. All sheet operations wrapped in `withTimeout()` (30s default)
- **Polygon blockchain** (`ethers`): MOOV2 proposal detection via RPC transaction receipt inspection
- **Ticket Tool bot**: Post-processing commands (`$close`, `$delete`) sent as messages
- **node-cron**: Scheduled tasks (e.g., thread archival every 4 hours)

### Concurrency & State Management

Multiple in-memory caches and lock flags prevent race conditions:
- `currentlyProcessingChannels` (Set) — prevents duplicate processing of same channel
- `isMassScanInProgress` / `isBacklogProcessRunning` — global locks for scans
- `disputeParticipationCache`, `createdFallbackThreads`, `otbVerifiedCache`, `pendingTicketTimers` — Map-based caches with TTL expiration

### Configuration

- **`.env`**: Secrets and startup defaults (Discord token, Google credentials, channel IDs, role IDs)
- **`bot_config.json`**: Runtime settings persisted to disk, modified via `/config` slash commands. Properties: `autoProcessingEnabled`, `currentPostProcessingAction`, `minTicketAgeForProcessing`, `processingIntervalMs`, `errorNotificationUserID`, `lastSuccessfulScanTimestamp`, `autoSetPaidToN`, `moov2FilterEnabled`

### Command System

Hybrid approach — prefix commands (`!record`, `!recordt`, `!processthreads`, `!stopbacklog`) for power users and slash commands (`/config`, `/scan_status`, `/stats`) for admin UI. Access control via `hasAccess()` checking Admin or RISK_LABS_ROLE permissions.

### CLOSING Block Format

The core data input mechanism. Messages starting with `CLOSING:` are parsed for:
- Comma-separated P/S/T user list (0-3 users)
- `Link:` override, `Type:` override, `Alertoor:` field
- `bonked` lines: `BonkerName bonked VictimName primary/secondary/tertiary`
- Special types: `CLOSING: disputed`, `CLOSING: assertion`, `CLOSING: snapshot`
- Thread-specific: `(findoor)` annotation on user names
