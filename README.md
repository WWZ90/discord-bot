# UMA Helper Bot for Discord & Google Sheets

This versatile Discord bot automates recording information from dedicated "proposal" channels and "thread" channels into a Google Sheet. It can operate manually via `!record` (for channels) and `!recordt` (for threads) commands, or automatically scan eligible `proposal-` channels based on configurable intervals and age. 

The bot intelligently parses messages for key data points, including a multi-line **`CLOSING:`** block for finalizers, "bonk" actions, manual link overrides, and special dispute types, then upserts this data into designated Google Sheets.

The bot also features configurable post-processing actions like attempting to close tickets via another bot (e.g., Ticket Tool).

## Core Features

*   **Dual Processing Modes:**
    *   **Ticket Channels (`proposal-`):** Processed automatically by a scanner or manually with `!record`. Data is saved to a primary sheet.
    *   **Threads:** Processed manually with `!recordt`. Data is saved to a secondary sheet (e.g., "Findoors").
*   **Intelligent Data Extraction:**
    *   Extracts a numeric **Proposal ID** from channel names (e.g., `proposal-123` -> `123`).
    *   Automatically finds the latest **Oracle or Snapshot Link**.
    *   Processes a multi-line `CLOSING:` message for rich data:
        *   **Primary/Secondary/Tertiary (P/S/T)** users from a comma-separated list.
        *   **Closer:** The author of the `CLOSING:` message, resolving their server display name.
        *   **Manual Overrides:** Users can specify `Link:`, `Type:`, `Alertoor:`, and `bonked` lines within the `CLOSING:` message to ensure data accuracy.
        *   **Special Types:** Handles `CLOSING: disputed`, `CLOSING: assertion`, `CLOSING: snapshot`, etc., to categorize tickets without P/S/T data.
        *   **Findoors:** Identifies users marked with `(findoor)` in thread processing.
*   **Robust Google Sheets Integration:**
    *   **Tickets Sheet:** Uses a numeric `#` column to find and update existing rows. Adds a new row if not found.
    *   **Threads Sheet:** Uses the thread name as a unique key to update or insert rows.
*   **Persistent & Dynamic Configuration (`bot_config.json`):**
    *   Settings for the automatic scanner, post-processing actions, ticket age, and error notifications are stored locally.
    *   Fully configurable on-the-fly via powerful **`/config`** slash commands (admin-only).
*   **Automatic Scanner:**
    *   Uses an internal `setTimeout` loop, making it more efficient than cron-based systems.
    *   Scans for `proposal-` channels older than a configured age.
    *   **Flagging System:** If critical info is missing, the bot posts a "Flag" message (pinging a configured user) and skips the channel in future auto-scans to prevent errors.
*   **User-Friendly Commands:**
    *   `!record` / `!recordt` for manual processing with optional sub-types (`disputed`, `assertion`, etc.).
    *   `/scan_status` to see when the next automatic scan is scheduled.

## Prerequisites

*   [Node.js](https://nodejs.org/) (v16.x or higher recommended)
*   [npm](https://www.npmjs.com/) (usually comes with Node.js)
*   A Discord Bot Application
*   A Google Cloud Platform Project with the Google Sheets API enabled
*   Two Google Sheets prepared with the necessary header columns (one for tickets, one for threads).

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
# Target worksheet (tab) names in your Google Sheet
WORKSHEET_TITLE_MAIN=Verification
WORKSHEET_TITLE_FINDOOR=Findoors

# Bot Behavior
COMMAND_PREFIX=!
DEFAULT_TICKET_POST_ACTION=close  # Initial post-processing action: 'none', 'close', or 'delete'
ENABLE_AUTO_PROCESSING=true       # Initial state for auto-processing: 'true' or 'false'
DELAY_BETWEEN_TICKETS_MS=5000     # Delay in ms between processing each ticket in a mass scan
DEFAULT_ERROR_USER_ID=USER_ID_TO_PING_ON_FLAGGED_ERRORS # Optional

# Ticket Tool Commands (if used)
TICKET_TOOL_CLOSE_COMMAND=$close
TICKET_TOOL_DELETE_COMMAND=$delete
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

### 8. Deploy Slash Commands
To register the /config and /scan_status commands with Discord, run the deployment script once:
 - Navigate to the project's root directory in your terminal and run:
   ```
   node deploy-commands.js
   ```

### 9. Running the Bot
Once all dependencies are installed and the .env file is correctly configured:
 - Run the bot using:
   ```
   node index.js
   ```
You should see confirmation logs in your console and the bot will start with a full scan.

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
    - scan_status: Display how much time is left until the next scan. 

2. **Automatic Scanner**:
  - "Wakes up" at a fixed interval defined in set_processing_interval.
  - Checks if autoProcessingEnabled is true.
  - Scans all channels starting with proposal- in the server.
  - For each eligible ticket (older than minTicketAgeForProcessing and not already containing "Flag:"):
    - Calls processTicketChannel.
  - Updates lastSuccessfulScanTimestamp after a scan cycle.
3. **Manual Processing** (!record and !recordt):
  - !record: Processes the current ticket channel immediately, regardless of auto-processing state or if previously flagged.
  - !record assertion: Processes as an "Assertion" type, mainly recording OO Link.
  - !record disputed: Processes as a "Disputed" type, setting the disputed flag with OO Link
  - !record assertion: Processes as a "Assertion" type, with OO Link
  - !record snapshot: Processes as a "Snapshot" type, with OO Link
  - !record 
  If we use only !record, it is because we have a CLOSING with information to process
  All of the above is applicable to !recordt as well for threads

4. **The CLOSING: Message Block**
  This is the primary way to provide detailed data for manual processing.
  ```
  CLOSING: User1, User Two, User3
  Link: https://some-manual-link.com/if/needed
  Type: Assertion/Snapshot/Disputed #By default here is Polymarket, so only need to add it if diferent
  User1 bonked User5 primary/secondary/tertiary
  ``` 

  On threads you can use (findoor) as well and will add "y (Alertoor: User1)" to the column
  ```
  CLOSING: User1 (findoor), User Two, User3
  Type: Disputed
  ```

5. processTicketChannel **Function (Core Logic)**:
  - **Flag Check:** For auto-scans, skips if a message starts with "Flag:" or "Ticket data for order" (indicating prior processing/error).
  - **OO Link Extraction:** Finds the latest https://oracle.uma.xyz/... or https://snapshot.org/ link.
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
6. **Google Sheets (upsertRowByOrderValue):**
  - Uses the Order # column (populated with the normalized Proposal ID) to find a row.
  - If found, updates the row.
  - If not found, **adds a new row to the end of the sheet**.
  - Ensures blank cells for empty data instead of "N/A".

## Potential Future Enhancements
**- Comprehensive Database Integration:**
  This would allow for more complex data integrity rules and better performance under high load.
**- Web Interface for advanced analytics or direct integration with other backend services.**
  **Features could include:**
    - Visualizing Statistics: Charts and graphs for ticket processing times, user activity (closers, bonkers), dispute rates, etc.
    - Data Summaries: Customizable reports and summaries.
    - Search for Analytics and Management:
      - Visualize statistics derived from the collected ticket data.
      - Provide summaries and reports.
      - Offer an interface to search, filter, and view ticket data stored in the database.
      - and Filtering:** Advanced search capabilities for all recorded ticket data.
      - Export to Sheet/CSV: Functionality to export queried data or reports to a new Google Sheet or CSV file for ad-hoc analysis or sharing.
      - (Optional) Bot Configuration Interface: A web UI to manage bot settings currently handled by /config commands.
      - Potentially allow exporting selected data to CSV or a new Google Sheet for ad-hoc analysis.
      - This would make the entire data processing and review workflow significantly faster, more efficient, and more user-friendly than relying solely on the Google Sheet or* This would significantly improve data accessibility and analysis efficiency beyond what a raw Google Sheet or direct database queries can offer to non-technical users.
      - Implementing these would make the entire data collection and analysis process much faster, more efficient, and direct database queries.

## Troubleshooting
  - **Slash Commands Not Appearing:** Run node deploy-commands.js. If using GUILD_ID in .env for deploy-commands.js, ensure it's correct. Global commands can take up to an hour to appear.
  - **Config Not Saving/Loading:** Check console for errors related to bot_config.json. Ensure the bot has write permissions in its directory.
  - **Other common issues:** Refer to the troubleshooting section in the previous README version (related to Google Sheets setup, Discord permissions, token errors, etc.).