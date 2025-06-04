# UMA Helper Bot for Discord & Google Sheets

This Discord bot is designed to automate the process of recording information from specific "ticket" or "proposal" channels into a Google Sheet. It streamlines workflows by extracting data from Discord messages based on defined patterns and then updating or adding rows to a designated Google Sheet.

## Features

*   **Automatic Data Extraction:** Parses Discord channel history to find key information.
*   **Google Sheets Integration:** Automatically adds or updates rows in a Google Sheet.
*   **Ticket Number Parsing:** Extracts a proposal/ticket number from the channel name (e.g., `ticket-123` -> `123`).
*   **OO Link Extraction:** Finds and records a specific "Optimistic Oracle" link (`https://oracle.uma.xyz/...`) from messages.
*   **"Final:" Message Processing:**
    *   Identifies a message starting with "Final:" to determine Primary, Secondary, and Tertiary users, and the "Closer" (author of the "Final:" message).
    *   Supports an empty "Final:" line (no P/S/T users).
    *   Handles a special "Final: disputed" case.
*   **"Bonk" Processing:** Parses subsequent lines within the "Final:" message for "bonk" actions (e.g., `UserA bonked UserB primary`) and records bonkers and bonked users.
*   **Update/Insert Logic:** Checks if a record for a proposal already exists in the Google Sheet and updates it; otherwise, adds a new row.
*   **Assertion Recording:** A special `!record assertion` command to log only the OO Link and set a "Type" column to "Assertion".
*   **Automatic Ticket Closing (Optional):** Can send a pre-configured command to another bot (like Ticket Tool) to close the ticket after processing. (NOT WORKING)
*   **Configurable:** Uses a `.env` file for easy configuration of tokens, IDs, and commands.

## Prerequisites

*   [Node.js](https://nodejs.org/) (v16.x or higher recommended)
*   [npm](https://www.npmjs.com/) (usually comes with Node.js)
*   A Discord Bot Application (see [Discord Developer Portal Setup](#discord-developer-portal-setup))
*   A Google Cloud Platform Project with the Google Sheets API enabled (see [Google Cloud Platform Setup](#google-cloud-platform-setup))
*   A Google Sheet prepared with the necessary header columns.

## Setup and Configuration

### 1. Clone the Repository

```bash
git clone https://github.com/WWZ90/discord-bot.git
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
# Discord Bot Token
DISCORD_TOKEN=YOUR_ACTUAL_DISCORD_BOT_TOKEN

# Google Sheets Configuration
GOOGLE_SHEET_ID=YOUR_GOOGLE_SHEET_ID_FROM_THE_URL
GOOGLE_SERVICE_ACCOUNT_EMAIL=THE_CLIENT_EMAIL_FROM_CREDENTIALS.JSON
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_FROM_CREDENTIALS.JSON_WITH_ALL_NEWLINES_REPLACED_BY_\\n\n-----END PRIVATE KEY-----\n"
WORKSHEET_TITLE=Sheet1 # Or the exact name of the tab/worksheet you want to use

# Bot Configuration
COMMAND_PREFIX=!

# Optional: Command for Ticket Tool to close tickets
# Example: TICKET_TOOL_CLOSE_COMMAND=$close Processed by UMA Helper
TICKET_TOOL_CLOSE_COMMAND=$close
```
#### Explanation of .env variables:
```
DISCORD_TOKEN: The token you copied from the Discord Developer Portal.
GOOGLE_SHEET_ID: The long ID found in the URL of your Google Sheet (e.g., https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit).
GOOGLE_SERVICE_ACCOUNT_EMAIL: The client_email from your credentials.json file.
GOOGLE_PRIVATE_KEY: The private_key from your credentials.json file.
Crucial Formatting: Copy the entire private key string, including -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY-----.
It must be enclosed in double quotes "".
WORKSHEET_TITLE: The exact name of the specific tab (worksheet) within your Google Sheet that the bot should write to (e.g., Sheet1, ProposalsData).
COMMAND_PREFIX: The prefix for bot commands (e.g., !).
TICKET_TOOL_CLOSE_COMMAND: (Optional) If you use Ticket Tool and want the bot to attempt to close tickets, set this to the text command Ticket Tool uses (e.g., $close or $close Processed).
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
Successfully logged into Discord.
UMABot#aaaa has connected to Discord!
Bot is ready to process tickets. Use "!record" or "!record assertion".
```

## How the Bot Works (index.js)
1. Initialization:
 - Loads environment variables from .env.
 - Initializes the Discord client with necessary intents.
 - Sets up the Google Sheets API client using credentials (either from .env variables for email/private key or directly from credentials.json if you modify the code to use GoogleAuth with keyFile).
2. Event Listener (messageCreate):
 - The bot listens for new messages in servers it's a part of.
 - It ignores messages from other bots (and itself, unless configured otherwise).
 - It checks if the message starts with the defined COMMAND_PREFIX.
3. Command Handling (!record):
 - Permissions: Checks if the user has "Manage Messages" permission (configurable).
 - Sub-commands:
  - !record assertion: Enters "Assertion" mode.
 - Proposal Number: Extracts a numeric ID from the channel name (e.g., ticket-123 becomes 123). This ID is normalized to remove leading zeros for consistent matching with sheet data.
 - OO Link Search: Fetches recent messages and scans for the latest URL matching https://oracle.uma.xyz/....
 - Assertion Mode Logic: If !record assertion, it sets Type to "Assertion" and primarily focuses on the OO Link. Other data fields are generally left blank.
 - Normal Record Mode Logic:
  - "Final:" Message Search: Fetches recent messages to find the latest message starting with "Final:" (case-insensitive).
  - Closer Identification: The author of this "Final:" message is identified as the "Closer". Their display name is used.
  - "Final: disputed" Case: If the line is exactly "Final: disputed", the Disputed? (y?) column is set to "y", and other P/S/T/bonk fields are cleared.
  - P/S/T User Extraction: Parses users (0 to 3 allowed) from the "Final:" line.
  - Validation 1 (P/S/T Count): Ensures the "Final:" line doesn't exceed 3 users.
  - Bonk Processing:
   - Scans subsequent lines within the same "Final:" message for patterns like BonkerName bonked VictimName type.
   - Validation 2 (Bonked User): Ensures a user listed in the "Final:" line (P/S/T) is not also a VictimName in a bonk line.
   - Records up to 5 BonkerNames (can be duplicates if one user bonks multiple times) and unique VictimNames for each bonk type (primary, secondary, tertiary), joined by commas.  
 - Error Handling: If validations fail, an error message is sent to Discord, and no data is written to the sheet.
 - Recorder: The display name of the user who executed the !record command.
4. Google Sheets Interaction (upsertSpreadsheetRow function):
 - Takes the processed rowData and the proposalNumber.
 - Connects to the specified Google Sheet and worksheet.
 - Loads header row to ensure correct column mapping.
 - Searches for an existing row: Iterates through sheet rows, comparing the normalized proposalNumber with the value in the PROPOSAL_COLUMN_HEADER column (also normalized for comparison).
 - Updates or Adds:
  - If a row with a matching proposalNumber is found, it updates that row with the new rowData.
  - If no match is found, it adds a new row with rowData.
5. Confirmation and Ticket Closing:
 - Sends a confirmation message to Discord summarizing the data recorded and whether it was added or updated.
 - (Optional) If TICKET_TOOL_CLOSE_COMMAND is set in .env, the bot sends this command as a text message to the ticket channel to attempt an automatic close via another bot (e.g., Ticket Tool). (NOT WORKING ATM)

## Important Usage Notes
 - Manual Trigger: This bot is designed to be triggered manually in each ticket channel using the !record command.
 - Timing: It is recommended to run the !record command only after the initial 2-hour period (or relevant discussion/voting period) has passed to ensure all relevant data (like the "Final:" message and bonks) is present.
 - Verification: Constantly verify that the bot is processing data accurately and that the information in the Google Sheet is correct. Manual checks are crucial, especially initially, to catch any discrepancies or errors in data processing. Due to the dynamic nature of Discord messages, parsing can sometimes encounter unexpected formats.

## Future Automation Ideas
The current bot relies on finding a "Final:" message. Future enhancements could make it less dependent on this specific keyword by implementing more heuristic-based parsing:
 1. Automatic P/S/T Detection (Alternative to "Final:"):
  - The bot could be programmed to identify the first 3 unique users (excluding known bots like Ticket Tool) who wrote in the ticket.
  - It could further refine this by looking for messages from these users that start with a keyword like "Verification" and also contain image attachments (as evidence).
  - A mapping system could be implemented if the Discord usernames need to be translated to specific names for the sheet (e.g., User1-bot on Discord maps to User1 in the sheet). This would provide the P/S/T users in order.
 2. Independent Bonk Pattern Analysis:
  - The bot could scan messages for the BonkerName bonked VictimName type pattern independently of the "Final:" message.
  - This would require careful consideration of context (e.g., only processing bonks made after P/S/T are identified or within a certain timeframe).
These are more complex to implement reliably and would require robust error handling and clear rule definitions.

## Troubleshooting
 - "Error: GoogleSpreadsheet instance is not initialized": Double-check your GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_PRIVATE_KEY in .env. Ensure the private key format is correct (single line).
 - "Error: Worksheet titled "..." not found": Verify WORKSHEET_TITLE in .env matches the tab name in your Google Sheet exactly (case-sensitive).
 - "Error: Column "Proposal" does not exist...": Ensure your Google Sheet has a header row, and the column used for matching proposal IDs is correctly named (and matches PROPOSAL_COLUMN_HEADER in the code if you changed it).
 - Permissions Errors (Discord): Make sure the bot has the necessary Privileged Intents enabled in the Developer Portal and the required permissions in your server/channels.
 - Permissions Errors (Google Sheets): Confirm the service account email has "Editor" access to your Google Sheet.
 - Bot doesn't respond / !record fails silently: Check the console for errors. Ensure DISCORD_TOKEN is correct.
 - Row not updating / new row added китайською: This usually means the proposalNumber normalization or comparison is failing. Check console logs for Normalized Proposal Number and how cell values are being read/compared.
 - Ticket Tool not closing: Ticket Tool might be ignoring messages from bots. Confirm if $close (or your configured command) works when sent by a bot, or if Ticket Tool has settings to allow bot commands/specific bot roles to execute its commands. I still haven't found a solution to this problem. Apparently, a bot can't execute another bot's command.

