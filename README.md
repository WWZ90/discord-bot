# UMA Helper Bot for Discord & Google Sheets

This Discord bot automates recording information from "ticket" channels into a Google Sheet. It can operate manually via a `!record` command or automatically scan eligible tickets based on configurable intervals and age. It parses messages for key data points, including a "CLOSING:" block for finalizers and "bonk" actions, and then upserts (updates or inserts) this data into a designated Google Sheet. The bot also features configurable post-processing actions like attempting to close tickets via another bot (e.g., Ticket Tool).

## Core Features

*   **Manual & Automatic Processing:**
    *   **`!record` command:** Manually trigger processing for the current ticket channel. Supports `!record assertion` and `!record disputed` sub-types.
    *   **Automatic Scanner:** Periodically scans for `ticket-` channels older than a configured age, processes them, and attempts a post-processing action (e.g., close/delete).
*   **Data Extraction & Parsing:**
    *   Extracts a numeric **Proposal ID** from channel names (e.g., `ticket-123` -> `123`). This ID is also used for an order column (`#`) in the sheet.
    *   Finds the latest **Optimistic Oracle (OO) Link** (`https://oracle.uma.xyz/...`).
    *   Processes the latest message starting with **`CLOSING:`** (case-insensitive):
        *   Identifies **Primary, Secondary, Tertiary** users (P/S/T) from a comma-separated list. Supports 0-3 users and names with spaces.
        *   Identifies the **Closer** (author of the `CLOSING:` message).
        *   Handles special cases: `CLOSING: disputed` (marks as disputed) and `CLOSING: assertion` (sets type to Assertion).
    *   Parses **"Bonk" actions** from lines within the same `CLOSING:` message (e.g., `Bonker Name bonked Victim Name type`).
*   **Google Sheets Integration:**
    *   Uses a designated **Order Column (`#`)** in the sheet (populated with the Proposal ID) to find and update existing rows.
    *   If a row with the corresponding Order # is not found, a **new row is added** to the end of the sheet.
*   **Persistent Configuration (`bot_config.json`):**
    *   Settings for automatic processing, post-processing actions, ticket age, processing interval, and error notification user are stored and loaded from `bot_config.json`.
    *   Configurable via **Slash Commands (`/config ...`)**.
*   **Error Handling & Flagging:**
    *   If critical information (like a `CLOSING:` block) is missing during an automatic scan, the ticket channel will have a "Flag:" message posted by the bot (pinging a configured error user) and will be skipped in future auto-scans.
    *   Validation errors within a `CLOSING:` block are reported without auto-flagging, allowing for correction.
*   **Ticket Post-Processing (Configurable):**
    *   After successful data recording, can attempt to send a command (e.g., `$close` or `$delete`) to Ticket Tool based on configuration.

## Prerequisites

*   [Node.js](https://nodejs.org/) (v16.x or higher recommended)
*   [npm](https://www.npmjs.com/) (usually comes with Node.js)
*   A Discord Bot Application (see [Discord Developer Portal Setup](#discord-developer-portal-setup))
*   A Google Cloud Platform Project with the Google Sheets API enabled (see [Google Cloud Platform Setup](#google-cloud-platform-setup))
*   A Google Sheet prepared with the necessary header columns.

## Setup and Configuration

### 1. Clone the Repository

```bash
git clone https://github.com/WWZ90/discord-bot.git # Or your repository URL
cd discord-bot
```

### 2. Install Dependencies
Navigate to the project directory in your terminal and run:
```npm install```

This will install all necessary libraries defined in package.json (e.g., discord.js, google-spreadsheet, dotenv).

### 3. Discord Developer Portal Setup
If you haven't already, you need to create a Discord bot application:
 - Go to the Discord Developer Portal.
 - Click "New Application" and give it a name.
 - Navigate to the "Bot" tab.
 - Click "Add Bot".
 - Crucially, enable Privileged Gateway Intents:
   - ✅ Message Content Intent (Required to read message content) 
   - ✅ Server Members Intent (Recommended for accurately fetching user display names)
   - (Presence Intent is optional)
 - Under "Token," click "Reset Token" (or "View Token") and copy the token. This is your DISCORD_TOKEN. Keep it secret!
 - Navigate to the "OAuth2" tab, then "URL Generator".
 - Select the following scopes: bot and applications.commands (if you plan to add slash commands later).
 - Under "Bot Permissions," select at least:
   - View Channels
   - Send Messages
   - Read Message History
  (Add other permissions if your bot needs them, e.g., Manage Messages if you restrict the !record command to users with that permission).
 - Copy the generated URL and paste it into your browser to invite the bot to your Discord server.
   
### 4. Google Cloud Platform Setup
To allow the bot to interact with Google Sheets:
 - Go to the Google Cloud Platform Console.
 - Create a new project or select an existing one.
 - Enable APIs:
   - Search for and enable the "Google Sheets API".
   - Search for and enable the "Google Drive API" (sometimes needed by google-spreadsheet for discovery).
 - Create Service Account Credentials:
   - Navigate to "APIs & Services" > "Credentials".
   - Click "+ CREATE CREDENTIALS" and select "Service account".
   - Fill in the service account details (e.g., name: sheets-bot-service-account).
   - Grant this service account a role. For writing to sheets, "Editor" (roles/editor) is usually sufficient for the project, or you can create a custom role with roles/sheets.editor. Click "Continue".
   - Skip granting users access to this service account (optional step) and click "Done".
   - Find the service account you just created in the list. Click on its email address.
   - Go to the "KEYS" tab.
   - Click "ADD KEY" > "Create new key".
   - Select "JSON" as the key type and click "CREATE".
   - A JSON file will be downloaded. Rename this file to credentials.json and place it in the root directory of your bot project.
   - Important: This credentials.json file contains sensitive information. It's already included in the .gitignore file to prevent accidental commits.
 - Share Your Google Sheet:
   - Open the credentials.json file. Find the client_email value (e.g., your-service-account-name@your-project-id.iam.gserviceaccount.com).
   - Open the Google Sheet you want the bot to use.
   - Click the "Share" button (usually green, top-right).
   - Paste the client_email into the "Add people or groups" field.
   - Ensure you give it "Editor" permissions.
   - Click "Send" (or "Save").
     
### 6. Configure Environment Variables (.env file)
Create a file named .env in the root directory of the project. This file is listed in .gitignore and should never be committed to version control.
Populate it with the following, replacing the placeholder values:
```
# Discord Bot
DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
BOT_ID=YOUR_BOT_APPLICATION_CLIENT_ID 
GUILD_ID=YOUR_SERVER_ID_FOR_SLASH_COMMAND_TESTING # Optional, for faster slash command updates during dev

# Google Sheets
GOOGLE_SHEET_ID=YOUR_GOOGLE_SHEET_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL=THE_CLIENT_EMAIL_FROM_CREDENTIALS.JSON
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_FROM_JSON_WITH_\\n_FOR_NEWLINES\n-----END PRIVATE KEY-----\n"
WORKSHEET_TITLE=Sheet1 # Target tab name in your Google Sheet

# Bot Behavior
COMMAND_PREFIX=!
DEFAULT_ERROR_USER_ID=USER_ID_TO_PING_ON_FLAGGED_ERRORS # Optional: User ID

# Cron Job for Automatic Scanning
CRON_WAKE_INTERVAL_EXPRESSION="* * * * *" # Default: Every minute (Bot "wakes up" this often to check)
# Initial default values for bot_config.json (can be changed via /config commands)
ENABLE_AUTO_PROCESSING=true # Initial state for auto-processing (true/false)
DEFAULT_TICKET_POST_ACTION=close # Initial post-processing action ('none', 'close', 'delete')
# DEFAULT_MIN_TICKET_AGE and DEFAULT_PROCESSING_INTERVAL are hardcoded as initial defaults in index.js if bot_config.json is new

# Ticket Tool Commands (if used)
TICKET_TOOL_CLOSE_COMMAND=$close
TICKET_TOOL_DELETE_COMMAND=$delete
DEFAULT_ERROR_USER_ID=
```

### 7. Prepare Your Google Sheet Headers
Ensure the first row of your target worksheet in Google Sheets contains the following headers (or adjust the rowData object keys in index.js to match your headers exactly, case-sensitive):
 - Proposal
 - Type (PM / Snap, etc)
 - OO Link
 - Primary
 - Secondary
 - Tertiary
 - Closer
 - Recorder
 - Disputed? (y?)
 - bonker 1
 - bonker 2 
 - bonker 3
 - bonker 4
 - bonker 5
 - BONKED 1
 - BONKED 2
 - BONKED 3

### 8. Running the Bot
Once all dependencies are installed and the .env file is correctly configured:
 - Navigate to the project's root directory in your terminal.
 - Run the bot using:
   ```
   node index.js
   ```
You should see console this console logs:
```
GoogleSpreadsheet instance created.
Configuration loaded from bot_config.json.
UMABot# has connected to Discord and is ready!
Scanner master cron task scheduled: * * * * *. Processing interval: ~1m
```

## How the Bot Works (index.js)
1. **Configuration** (bot_config.json & /config):
  - On first run, bot_config.json is created with default settings.
  - Administrators can use /config slash commands to:
    - toggle_auto_processing [enabled: True/False]: Turn the automatic scanner on/off.
    - set_post_processing_action [action: none/close/delete]: Define what happens after a ticket is processed (nothing, send  - $close, or send $delete).
    - set_min_ticket_age [age: "2h5m"]: Set how old a ticket must be before auto-processing.
    - set_processing_interval [interval: "30m"]: Set how often the bot attempts a full scan of eligible tickets.
    - set_error_user [user: @User]: Designate a user to be pinged on certain errors/flags.
    - view_settings: Display current configurations.

2. **Automatic Scanner (Cron Job)**:
  - "Wakes up" at a fixed interval defined by CRON_WAKE_INTERVAL (from .env, e.g., every minute).
  - Checks if autoProcessingEnabled is true.
  - Checks if enough time has passed since lastSuccessfulScanTimestamp based on processingIntervalMs.
  - If conditions met, it scans all channels starting with ticket- in the server.
  - For each eligible ticket (older than minTicketAgeForProcessing and not already containing "Flag:"):
    - Calls processTicketChannel.
  - Updates lastSuccessfulScanTimestamp after a scan cycle.
3. **Manual Processing** (!record):
  - !record: Processes the current ticket channel immediately, regardless of auto-processing state or if previously flagged.
  - !record assertion: Processes as an "Assertion" type, mainly recording OO Link.
  - !record disputed: Processes as a "Disputed" type, setting the disputed flag.
4. processTicketChannel **Function (Core Logic)**:
  - **Flag Check:** For auto-scans, skips if a message starts with "Flag:" or "Ticket data for order" (indicating prior processing/error).
  - **OO Link Extraction:** Finds the latest https://oracle.uma.xyz/... link.
  - **"CLOSING:" Block Processing:**
    - Finds the latest message starting with CLOSING: (case-insensitive).
    -**Special Cases:**
      - CLOSING: disputed: Sets Disputed? (y?) to "y", clears P/S/T/bonks.
      - CLOSING: assertion: Sets Type to "Assertion", clears P/S/T/bonks.
    - **Normal Case:** Parses P/S/T users (0-3 allowed, comma-separated, names can have spaces). Identifies "Closer" (author of CLOSING: message).
    - **Bonk Parsing:** Reads lines within the same CLOSING: message for Bonker Name bonked Victim Name type patterns (handles spaces in names).
  - **Validations:** Checks P/S/T user count. Errors within a CLOSING: block are reported to the channel (pinging error user) but don't auto-flag the ticket.
  - **Flagging:** If a CLOSING: block is not found (and not an assertion/disputed type), a "Flag:" message is posted, and the ticket is skipped by future auto-scans.
  -  **Data Recording:** Calls upsertRowByOrderValue.
  - **Discord Summary:** Posts a summary of processed data to the ticket channel.
  - **Post-Processing:** Sends configured close/delete command to Ticket Tool if action is not "none".
5. **Google Sheets (upsertRowByOrderValue):**
  - Uses the Order # column (populated with the normalized Proposal ID) to find a row.
  - If found, updates the row.
  - If not found, **adds a new row to the end of the sheet**.
  - Ensures blank cells for empty data instead of "N/A".
  - /scan_status Command: Allows users with "Manage Messages" permission to see when the next full automatic scan is approximately due.  

## Important Usage Notes
  - **Manual !record:** Can be used anytime to process/re-process a ticket.
  - **Automatic Scanner Timing:** Configure minTicketAgeForProcessing and processingIntervalMs via /config commands to control when and how often automatic processing occurs.
  - **Verification:** Regularly check bot output and Google Sheet data for accuracy, especially after configuration changes or bot updates.

## Potential Future Enhancements
**- Comprehensive Database Integration:**
  This would allow for more complex data integrity rules and better performance under high load.
**- Web Interface for advanced analytics or direct integration with other backend services.**
  **Features could include:**
    - Visualizing Statistics: Charts and graphs for ticket processing times, user activity (closers, bonkers), dispute rates, etc.
    - Data Summaries: Customizable reports and summaries.
    - Search for Analytics and Management:
      - Develop a web application (e.g., using React + Vite for the frontend, and Node.js/Express for a backend API المرضى the database) to:
      - Visualize statistics derived from the collected ticket data (e.g., processing times, user activity, bonk patterns).
      - Provide summaries and reports.
      - Offer an interface to search, filter, and view ticket data stored in the database.
      - and Filtering:** Advanced search capabilities for all recorded ticket data.
      - Export to Sheet/CSV: Functionality to export queried data or reports to a new Google Sheet or CSV file for ad-hoc analysis or sharing.
      - (Optional) Bot Configuration Interface: A web UI to manage bot settings currently handled by /config commands.
      - Potentially allow exporting selected data to CSV or a new Google Sheet for ad-hoc analysis.
      - This would make the entire data processing and review workflow significantly faster, more efficient, and more user-friendly than relying solely on the Google Sheet or* This would significantly improve data accessibility and analysis efficiency beyond what a raw Google Sheet or direct database queries can offer to non-technical users.
      - Implementing these would make the entire data collection and analysis process much faster, more efficient, and direct database queries.

## Troubleshooting
  - **"Invalid CRON_WAKE_INTERVAL...":** Ensure CRON_WAKE_INTERVAL_EXPRESSION in .env is a valid 5-field cron string (e.g., * * * * * for every minute). Use crontab.guru.
  - **Slash Commands Not Appearing:** Run node deploy-commands.js. If using GUILD_ID in .env for deploy-commands.js, ensure it's correct. Global commands can take up to an hour to appear.
  - **Config Not Saving/Loading:** Check console for errors related to bot_config.json. Ensure the bot has write permissions in its directory.
  - **Other common issues:** Refer to the troubleshooting section in the previous README version (related to Google Sheets setup, Discord permissions, token errors, etc.).

**Key Updates in this README:**

*   **Features:** Updated to include automatic scanning, `bot_config.json`, slash commands for config, new `CLOSING:` logic, and the "Flagging" behavior.
*   **`.env` Variables:** Added `BOT_ID`, `GUILD_ID`, and clarified `CRON_WAKE_INTERVAL_EXPRESSION` vs. user-configurable intervals.
*   **Slash Command Deployment:** Added a dedicated step `8. Deploy Slash Commands`.
*   **How the Bot Works:** Significantly expanded to explain the new automatic scanner, `bot_config.json`, the `/config` and `/scan_status` commands, and the refined `processTicketChannel` logic for `CLOSING:`, assertions, disputes, and flagging.
*   **Important Usage Notes:** Updated to reflect manual vs. automatic modes.
*   **Troubleshooting:** Added a note about `CRON_WAKE_INTERVAL` and slash commands.