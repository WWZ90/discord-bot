require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  MessageFlags
} = require("discord.js");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const cron = require("node-cron");
const fs = require("fs").promises;
const path = require("path");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.COMMAND_PREFIX || "!";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY_RAW = process.env.GOOGLE_PRIVATE_KEY;
const GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY_RAW
  ? GOOGLE_PRIVATE_KEY_RAW.replace(/\\n/g, "\n")
  : undefined;

const WORKSHEET_TITLE_MAIN = process.env.WORKSHEET_TITLE_MAIN || "Sheet1";
const PROPOSAL_COLUMN_HEADER = "Proposal";
const ORDER_COLUMN_HEADER = "#";

const WORKSHEET_TITLE_FINDOOR =
  process.env.WORKSHEET_TITLE_FINDOOR || "Findoors";
const PROPOSAL_COLUMN_HEADER_FOR_SHEET = "Proposal";

const TICKET_TOOL_CLOSE_COMMAND_TEXT =
  process.env.TICKET_TOOL_CLOSE_COMMAND || "$close";
const TICKET_TOOL_DELETE_COMMAND_TEXT =
  process.env.TICKET_TOOL_DELETE_COMMAND || "$delete";

const DEFAULT_MIN_TICKET_AGE_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;
const DEFAULT_PROCESSING_INTERVAL_MS = 30 * 60 * 1000;
const DELAY_BETWEEN_TICKET_PROCESSING_MS =
  parseInt(process.env.DELAY_BETWEEN_TICKETS_MS, 10) || 10000;

const CONFIG_FILE_PATH = path.join(__dirname, "bot_config.json");
let botConfig = {
  autoProcessingEnabled:
    (process.env.ENABLE_AUTO_PROCESSING || "true").toLowerCase() === "true",
  currentPostProcessingAction: process.env.DEFAULT_TICKET_POST_ACTION || "none",
  minTicketAgeForProcessing: DEFAULT_MIN_TICKET_AGE_MS,
  processingIntervalMs: DEFAULT_PROCESSING_INTERVAL_MS,
  errorNotificationUserID: process.env.DEFAULT_ERROR_USER_ID || null,
  lastSuccessfulScanTimestamp: 0,
};

const currentlyProcessingChannels = new Set();
let isMassScanInProgress = false;
let scanTimeoutId = null;

const blockTypes = ["polymarket", "snapshot", "disputed", "assertion"];

const LINK_REGEX = new RegExp(
  /(https:\/\/(?:oracle\.uma\.xyz|snapshot\.org|snapshot\.xyz)\/[^\s<>()'"]+)/
);

function findValidLinkIn(text) {
  if (!text) return null;
  const match = text.match(LINK_REGEX);
  if (!match || !match[0]) return null;

  let url = match[0];
  if (url.endsWith(".") && !url.endsWith("..")) {
    url = url.slice(0, -1);
  }
  return url;
}

function parseDurationToMs(durationString) {
  if (!durationString || typeof durationString !== "string") return null;
  let totalMs = 0;
  const durationRegex = /(\d+)\s*(d|h|m)/gi;
  let match;
  if (/^\d+$/.test(durationString))
    return parseInt(durationString, 10) * 60 * 1000;
  while ((match = durationRegex.exec(durationString)) !== null) {
    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "d") totalMs += value * 24 * 60 * 60 * 1000;
    else if (unit === "h") totalMs += value * 60 * 60 * 1000;
    else if (unit === "m") totalMs += value * 60 * 1000;
  }
  return totalMs > 0 ? totalMs : null;
}

function formatMsToHumanReadable(ms) {
  if (ms <= 0) return "now";
  let seconds = Math.floor(ms / 1000);
  let minutes = Math.floor(seconds / 60);
  let hours = Math.floor(minutes / 60);
  let days = Math.floor(hours / 24);
  seconds %= 60;
  minutes %= 60;
  hours %= 24;
  let parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 && parts.length === 0) parts.push(`${seconds}s`);
  if (parts.length === 0) return "in less than a minute";
  return `in approx. ${parts.join(" ")}`;
}

function capitalizeFirstLetter(string) {
  if (!string) return "";
  return string.charAt(0).toUpperCase() + string.slice(1);
}

async function getStatsForColumn(columnName, startOrder) {
  if (
    !GOOGLE_SHEET_ID ||
    !GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !GOOGLE_PRIVATE_KEY
  ) {
    throw new Error("Master Sheet environment variables are not configured.");
  }

  const serviceAccountAuth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const masterDoc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);

  await masterDoc.loadInfo();
  const sheet = masterDoc.sheetsByTitle[WORKSHEET_TITLE_MAIN];
  if (!sheet) {
    throw new Error(
      `Worksheet "${WORKSHEET_TITLE_MAIN}" not found in the master sheet.`
    );
  }

  const rows = await sheet.getRows();
  const counts = {};

  for (const row of rows) {
    const orderNum = parseInt(row.get(ORDER_COLUMN_HEADER), 10);
    const value = row.get(columnName)?.trim();

    if (!isNaN(orderNum) && orderNum >= startOrder && value) {
      counts[value] = (counts[value] || 0) + 1;
    }
  }

  const sortedData = Object.entries(counts).sort(([, a], [, b]) => b - a);

  if (sortedData.length === 0) {
    return `No data found for column "${columnName}" starting from order #${startOrder}.`;
  }

  let responseMessage = `**${capitalizeFirstLetter(
    columnName
  )} Stats (from Master Sheet, Order #${startOrder})**\n\`\`\`\n`;
  for (const [name, count] of sortedData) {
    responseMessage += `${name.padEnd(20, " ")}: ${count}\n`;
  }
  responseMessage += "```";

  if (responseMessage.length > 2000) {
    responseMessage =
      responseMessage.substring(0, 1990) +
      "...\n```\n(List too long to display fully)";
  }

  return responseMessage;
}

function parseClosingBlock(lines) {
  const bonkersList = [];
  const bonkedUsersData = {
    primary: new Set(),
    secondary: new Set(),
    tertiary: new Set(),
  };
  let manualLink = null;
  let manualType = null;
  let alertoorUser = null;

  const bonkPattern =
    /^(.*?)\s+bonked\s+(.*?)\s+(primary|secondary|tertiary)$/i;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    const lowerCaseLine = trimmedLine.toLowerCase();
    const bonkMatch = lowerCaseLine.match(bonkPattern);

    if (bonkMatch) {
      const bonker = capitalizeFirstLetter(bonkMatch[1].trim());
      const victim = capitalizeFirstLetter(bonkMatch[2].trim());
      const type = bonkMatch[3].toLowerCase();
      bonkersList.push(bonker);
      if (type === "primary") bonkedUsersData.primary.add(victim);
      else if (type === "secondary") bonkedUsersData.secondary.add(victim);
      else if (type === "tertiary") bonkedUsersData.tertiary.add(victim);
    } else if (lowerCaseLine.startsWith("link:")) {
      manualLink = trimmedLine.substring(5).trim();
    } else if (lowerCaseLine.startsWith("type:")) {
      manualType = trimmedLine.substring(5).trim();
    } else if (lowerCaseLine.startsWith("alertoor:")) {
      alertoorUser = capitalizeFirstLetter(trimmedLine.substring(9).trim());
    }
  }

  return { bonkersList, bonkedUsersData, manualLink, manualType, alertoorUser };
}

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE_PATH, "utf8");
    const loadedConfig = JSON.parse(data);
    let changedDuringLoad = false;
    const applyOrDefault = (key, defaultValue, validator) => {
      if (
        loadedConfig[key] !== undefined &&
        (validator ? validator(loadedConfig[key]) : true)
      ) {
        botConfig[key] = loadedConfig[key];
      } else if (
        loadedConfig[key] === undefined &&
        botConfig[key] === undefined
      ) {
        botConfig[key] = defaultValue;
        changedDuringLoad = true;
      } else if (
        validator &&
        loadedConfig[key] !== undefined &&
        !validator(loadedConfig[key])
      ) {
        console.warn(
          `Invalid value for ${key} in config: "${loadedConfig[key]}". Using default.`
        );
        botConfig[key] = defaultValue;
        changedDuringLoad = true;
      }
    };
    applyOrDefault(
      "autoProcessingEnabled",
      (process.env.ENABLE_AUTO_PROCESSING || "true").toLowerCase() === "true",
      (val) => typeof val === "boolean"
    );
    applyOrDefault(
      "currentPostProcessingAction",
      process.env.DEFAULT_TICKET_POST_ACTION || "none",
      (val) =>
        typeof val === "string" && ["none", "close", "delete"].includes(val)
    );
    applyOrDefault(
      "minTicketAgeForProcessing",
      DEFAULT_MIN_TICKET_AGE_MS,
      (val) => typeof val === "number" && val > 0
    );
    applyOrDefault(
      "processingIntervalMs",
      DEFAULT_PROCESSING_INTERVAL_MS,
      (val) => typeof val === "number" && val > 0
    );
    applyOrDefault(
      "errorNotificationUserID",
      process.env.DEFAULT_ERROR_USER_ID || null,
      (val) => typeof val === "string" || val === null
    );
    applyOrDefault(
      "lastSuccessfulScanTimestamp",
      0,
      (val) => typeof val === "number"
    );

    if (loadedConfig.scanInterval !== undefined) changedDuringLoad = true;

    console.log("Configuration loaded from bot_config.json.");
    if (changedDuringLoad) {
      console.log(
        "Defaults applied or legacy keys found. Saving updated config."
      );
      await saveConfig(false);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(
        "bot_config.json not found. Initializing with defaults and creating file."
      );
      await saveConfig(false);
    } else {
      console.error(
        "Error loading bot_config.json. Using hardcoded/env defaults.",
        error
      );
      botConfig = {
        autoProcessingEnabled:
          (process.env.ENABLE_AUTO_PROCESSING || "true").toLowerCase() ===
          "true",
        currentPostProcessingAction:
          process.env.DEFAULT_TICKET_POST_ACTION || "none",
        minTicketAgeForProcessing: DEFAULT_MIN_TICKET_AGE_MS,
        processingIntervalMs: DEFAULT_PROCESSING_INTERVAL_MS,
        errorNotificationUserID: process.env.DEFAULT_ERROR_USER_ID || null,
        lastSuccessfulScanTimestamp: 0,
      };
    }
  }
}

async function saveConfig(logFullObject = true) {
  try {
    const configToSave = {
      autoProcessingEnabled: botConfig.autoProcessingEnabled,
      currentPostProcessingAction: botConfig.currentPostProcessingAction,
      minTicketAgeForProcessing: botConfig.minTicketAgeForProcessing,
      processingIntervalMs: botConfig.processingIntervalMs,
      errorNotificationUserID: botConfig.errorNotificationUserID,
      lastSuccessfulScanTimestamp: botConfig.lastSuccessfulScanTimestamp,
    };
    await fs.writeFile(
      CONFIG_FILE_PATH,
      JSON.stringify(configToSave, null, 2),
      "utf8"
    );
    if (logFullObject)
      console.log("Configuration saved to bot_config.json:", configToSave);
    else console.log("Configuration saved to bot_config.json.");
  } catch (error) {
    console.error("Error saving bot_config.json:", error);
  }
}

let googleDoc;
if (GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY && GOOGLE_SHEET_ID) {
  try {
    const serviceAccountAuth = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    googleDoc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    console.log("GoogleSpreadsheet instance created.");
  } catch (error) {
    console.error("Error creating JWT or GoogleSpreadsheet instance:", error);
  }
} else {
  console.warn(
    "Warning: Core Google Sheets environment variables are missing."
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.ThreadMember],
});

async function upsertRowByOrderValue(
  orderValueToFind,
  dataWithOrderAndProposal
) {
  const logPrefix = `[Order #${orderValueToFind}]`;
  if (!googleDoc) {
    console.error(
      `${logPrefix} Error: GoogleSpreadsheet instance not initialized.`
    );
    return {
      success: false,
      action: "none",
      message: "GoogleSpreadsheet instance not initialized.",
    };
  }
  try {
    await googleDoc.loadInfo();
    const sheet = googleDoc.sheetsByTitle[WORKSHEET_TITLE_MAIN];
    if (!sheet) {
      console.error(
        `${logPrefix} Error: Worksheet "${WORKSHEET_TITLE_MAIN}" not found.`
      );
      return {
        success: false,
        action: "none",
        message: `Worksheet "${WORKSHEET_TITLE_MAIN}" not found.`,
      };
    }
    await sheet.loadHeaderRow();
    if (!sheet.headerValues.includes(ORDER_COLUMN_HEADER)) {
      console.error(
        `${logPrefix} Error: Order Column "${ORDER_COLUMN_HEADER}" not in sheet.`
      );
      return {
        success: false,
        action: "none",
        message: `Order Column "${ORDER_COLUMN_HEADER}" not found.`,
      };
    }

    const rows = await sheet.getRows();
    let targetRow = null;
    const orderValueString = orderValueToFind.toString();
    for (const row of rows) {
      if (row.get(ORDER_COLUMN_HEADER)?.toString() === orderValueString) {
        targetRow = row;
        break;
      }
    }
    const dataForSheet = {};
    for (const header of sheet.headerValues) {
      dataForSheet[header] = dataWithOrderAndProposal[header] || "";
    }
    dataForSheet[ORDER_COLUMN_HEADER] = orderValueString;

    if (targetRow) {
      console.log(`${logPrefix} Row found. Updating...`);
      for (const key in dataForSheet) {
        targetRow.set(key, dataForSheet[key]);
      }
      await targetRow.save();
      console.log(`${logPrefix} Row updated successfully.`);
      return { success: true, action: "updated" };
    } else {
      console.log(`${logPrefix} No row found. Adding new row...`);
      await sheet.addRow(dataForSheet);
      console.log(`${logPrefix} New row added successfully.`);
      return { success: true, action: "added" };
    }
  } catch (error) {
    console.error(`${logPrefix} Error upserting row:`, error);
    return {
      success: false,
      action: "none",
      error: error,
      message: "Sheet operation error.",
    };
  }
}

async function upsertRowByProposalName(proposalNameKey, dataToUpsert) {
  const logPrefix = `[Thread: ${proposalNameKey}]`;
  if (!googleDoc) {
    console.error(
      `${logPrefix} Error: GoogleSpreadsheet instance not initialized.`
    );
    return {
      success: false,
      action: "none",
      message: "GoogleSpreadsheet instance not initialized.",
    };
  }
  try {
    await googleDoc.loadInfo();
    const sheet = googleDoc.sheetsByTitle[WORKSHEET_TITLE_FINDOOR];
    if (!sheet) {
      console.error(
        `${logPrefix} Error: Worksheet "${WORKSHEET_TITLE_FINDOOR}" not found.`
      );
      return {
        success: false,
        action: "none",
        message: `Worksheet "${WORKSHEET_TITLE_FINDOOR}" not found.`,
      };
    }
    await sheet.loadHeaderRow();
    if (!sheet.headerValues.includes(PROPOSAL_COLUMN_HEADER_FOR_SHEET)) {
      console.error(
        `${logPrefix} Error: Key Column "${PROPOSAL_COLUMN_HEADER_FOR_SHEET}" not in sheet. Cannot upsert by proposal name.`
      );
      return {
        success: false,
        action: "none",
        message: `Key Column "${PROPOSAL_COLUMN_HEADER_FOR_SHEET}" not found.`,
      };
    }

    const rows = await sheet.getRows();
    let targetRow = null;

    for (let i = 0; i < rows.length; i++) {
      let cellProposalValue = rows[i].get(PROPOSAL_COLUMN_HEADER_FOR_SHEET);
      if (cellProposalValue !== null && cellProposalValue !== undefined) {
        if (cellProposalValue.toString().trim() === proposalNameKey.trim()) {
          targetRow = rows[i];
          break;
        }
      }
    }

    const dataForSheet = {};
    for (const key of sheet.headerValues) {
      dataForSheet[key] =
        dataToUpsert[key] === "N/A" || dataToUpsert[key] === undefined
          ? ""
          : dataToUpsert[key];
    }
    dataForSheet[PROPOSAL_COLUMN_HEADER_FOR_SHEET] = proposalNameKey;

    if (targetRow) {
      console.log(`${logPrefix} Row found by Proposal Name. Updating...`);
      for (const key in dataForSheet) {
        if (sheet.headerValues.includes(key))
          targetRow.set(key, dataForSheet[key]);
      }
      await targetRow.save();
      console.log(`${logPrefix} Row updated.`);
      return { success: true, action: "updated" };
    } else {
      console.log(
        `${logPrefix} No row found for Proposal "${proposalNameKey}". Adding new row...`
      );
      await sheet.addRow(dataForSheet);
      console.log(`${logPrefix} New row added.`);
      return { success: true, action: "added" };
    }
  } catch (error) {
    console.error(`${logPrefix} Error upserting row:`, error);
    return {
      success: false,
      action: "none",
      error: error,
      message: "Sheet operation error.",
    };
  }
}

async function processTicketChannel(
  channel,
  initiatedBy = "Automatic Scan",
  recordType = "standard"
) {
  const logPrefix = `[${channel.id} | ${channel.name}]`;
  console.log(
    `${logPrefix} Starting processing. Initiated by: ${initiatedBy}, Type: ${recordType}`
  );
  let proposalNumber = "",
    typeColumn = capitalizeFirstLetter(blockTypes[0]), //By default Polymarket
    ooLink = "",
    primaryUser = "",
    secondaryUser = "",
    terciaryUser = "",
    closerUser = "";
  const recorderUser =
    initiatedBy === "Automatic Scan"
      ? client.user.username
      : initiatedBy.split(" by ")[1] || initiatedBy;
  let disputedColumn = "";
  const bonkersInMessageText = [];
  const bonkedUsersData = {
    primary: new Set(),
    secondary: new Set(),
    tertiary: new Set(),
  };
  let validationErrorMessages = [];

  const channelNameMatch = channel.name.match(/proposal-(\d+)/i);
  proposalNumber =
    channelNameMatch && channelNameMatch[1]
      ? parseInt(channelNameMatch[1], 10).toString()
      : "";
  if (!proposalNumber) {
    console.log(
      `${logPrefix} Could not extract numeric ID from "${channel.name}". Skipping.`
    );
    return { success: false, reason: "invalid_proposal_id_format" };
  }
  const orderColumnValue = proposalNumber;
  console.log(
    `${logPrefix} Normalized Proposal Number: ${proposalNumber} (Order #${orderColumnValue})`
  );

  try {
    const allMessages = await channel.messages.fetch({ limit: 100 });
    if (initiatedBy === "Automatic Scan") {
      for (const msg of allMessages.values()) {
        const lowerContent = msg.content.toLowerCase();
        if (
          lowerContent.startsWith("flag:") ||
          lowerContent.startsWith("ticket data for order")
        ) {
          console.log(
            `${logPrefix} Found "Flag:" or previous processing summary. Skipping auto-scan.`
          );
          return { success: false, reason: "flagged_or_processed" };
        }
      }
    }

    ooLink = "";
    for (const msg of allMessages.values()) {
      let foundLink = null;
      if (msg.embeds && msg.embeds.length > 0) {
        for (const embed of msg.embeds) {
          foundLink = findValidLinkIn(embed.url);
          if (foundLink) break;
          foundLink = findValidLinkIn(embed.description);
          if (foundLink) break;
          if (embed.fields && embed.fields.length > 0) {
            for (const field of embed.fields) {
              foundLink = findValidLinkIn(field.value);
              if (foundLink) break;
            }
          }
          if (foundLink) break;
        }
      }
      if (!foundLink) {
        foundLink = findValidLinkIn(msg.content);
      }
      if (foundLink) {
        ooLink = foundLink;
        console.log(`${logPrefix} Link FOUND: ${ooLink}`);
        break;
      }
    }

    let closingBlockFoundAndProcessed = false;
    let closingMessage = null;
    for (const msg of allMessages.values()) {
      if (msg.content.toLowerCase().startsWith("closing:")) {
        closingMessage = msg;
        break;
      }
    }

    if (blockTypes.includes(recordType)) {
      primaryUser = "";
      secondaryUser = "";
      terciaryUser = "";
      closerUser = recorderUser;
      bonkersInMessageText.length = 0;
      bonkedUsersData.primary.clear();
      bonkedUsersData.secondary.clear();
      bonkedUsersData.tertiary.clear();
      disputedColumn = "";
      closingBlockFoundAndProcessed = true;

      if (recordType === "assertion") {
        typeColumn = "Assertion";
        console.log(`${logPrefix} Processing as Assertion (manual).`);
      } else if (recordType === "disputed") {
        typeColumn = "Disputed";
        disputedColumn = "y";
        console.log(`${logPrefix} Processing as Disputed (manual).`);
      } else if (recordType === "snapshot") {
        typeColumn = "Snapshot";
        console.log(`${logPrefix} Processing as Snapshot (manual).`);
      } else if (recordType === "polymarket") {
        typeColumn = "Polymarket";
        console.log(`${logPrefix} Processing as Polymarket (manual).`);
      }
    } else if (closingMessage) {
      closingBlockFoundAndProcessed = true;
      let member = closingMessage.member;
      if (!member) {
        try {
          console.log(
            `${logPrefix} Member not cached for message author ${closingMessage.author.id}. Fetching...`
          );
          member = await closingMessage.guild.members.fetch(
            closingMessage.author.id
          );
        } catch (fetchError) {
          console.error(
            `${logPrefix} Could not fetch member for user ${closingMessage.author.id}.`,
            fetchError
          );
          member = null;
        }
      }
      closerUser = member?.displayName ?? closingMessage.author.displayName;
      console.log(`${logPrefix} 'CLOSING:' block by ${closerUser}`);

      const lines = closingMessage.content.split("\n");
      const firstLineRaw = lines.shift() || "";
      const contentRaw = firstLineRaw.substring(8).trim();
      const contentLower = contentRaw.toLowerCase();

      if (blockTypes.includes(contentLower)) {
        typeColumn =
          contentLower.charAt(0).toUpperCase() + contentLower.slice(1);
        if (contentLower === "disputed") {
          disputedColumn = "y";
        }
      } else {
        const users = contentRaw
          ? contentRaw
              .split(/[.,]/)
              .map((n) => n.trim())
              .filter(Boolean)
          : [];
        if (users.length > 3) {
          validationErrorMessages.push(
            `Error: "CLOSING:" line max 3 P/S/T users. Found: ${users.length}.`
          );
        }
        primaryUser = users[0] || "";
        secondaryUser = users[1] || "";
        terciaryUser = users[2] || "";
      }

      const closingData = parseClosingBlock(lines);
      bonkedUsersData.primary = closingData.bonkedUsersData.primary;
      bonkedUsersData.secondary = closingData.bonkedUsersData.secondary;
      bonkedUsersData.tertiary = closingData.bonkedUsersData.tertiary;

      bonkersInMessageText.push(...closingData.bonkersList);

      if (closingData.manualLink) {
        ooLink = closingData.manualLink;
        console.log(
          `${logPrefix} OO Link overridden from CLOSING message: ${ooLink}`
        );
      }
      if (closingData.manualType) {
        typeColumn = closingData.manualType;
        console.log(
          `${logPrefix} Type overridden from CLOSING message: ${typeColumn}`
        );
      }
      if (closingData.alertoorUser) {
        disputedColumn = `y (Alertoor: ${closingData.alertoorUser})`;
        console.log(
          `${logPrefix} Disputed column set by Alertoor: ${closingData.alertoorUser}`
        );
      }
    }

    if (ooLink === "") {
      console.log(`${logPrefix} OO Link NOT FOUND. Flagging ticket.`);
      let flagMessage = `Flag: OO Link not found. Manual review needed.`;
      if (botConfig.errorNotificationUserID)
        flagMessage += ` <@${botConfig.errorNotificationUserID}>`;
      await channel.send(flagMessage);
      return { success: false, reason: "oo_link_not_found_and_flagged" };
    }

    if (validationErrorMessages.length > 0) {
      console.error(
        `${logPrefix} Validation errors in CLOSING: ${validationErrorMessages.join(
          "; "
        )}.`
      );
      let errReply = `Error(s) in CLOSING block (data not saved):\n- ${validationErrorMessages.join(
        "\n- "
      )}`;
      if (botConfig.errorNotificationUserID)
        errReply += ` <@${botConfig.errorNotificationUserID}>`;
      errReply += "\n\nPlease correct and re-run or wait for scan.";
      await channel.send(errReply);
      return { success: false, reason: "validation_error_in_closing_block" };
    }
    if (
      recordType === "standard" &&
      !closingBlockFoundAndProcessed &&
      validationErrorMessages.length === 0
    ) {
      console.log(
        `${logPrefix} "CLOSING:" not found for standard record. Flagging.`
      );
      let flagMsg = `Flag: "CLOSING:" message not found. Manual review needed.`;
      if (botConfig.errorNotificationUserID)
        flagMsg += ` <@${botConfig.errorNotificationUserID}>`;
      await channel.send(flagMsg);
      return { success: false, reason: "no_closing_message_and_flagged" };
    }

    const rowData = {
      [ORDER_COLUMN_HEADER]: orderColumnValue,
      [PROPOSAL_COLUMN_HEADER]: proposalNumber,
      "Type (PM / Snap, etc)": typeColumn,
      "OO Link": ooLink,
      Primary: primaryUser,
      Secondary: secondaryUser,
      Tertiary: terciaryUser,
      Closer: closerUser,
      Recorder: recorderUser,
      "Disputed? (y?)": disputedColumn,
      "bonker 1": bonkersInMessageText[0] || "",
      "bonker 2": bonkersInMessageText[1] || "",
      "bonker 3": bonkersInMessageText[2] || "",
      "bonker 4": bonkersInMessageText[3] || "",
      "bonker 5": bonkersInMessageText.slice(4).join(", ") || "",
      "BONKED 1": Array.from(bonkedUsersData.primary).join(", ") || "",
      "BONKED 2": Array.from(bonkedUsersData.secondary).join(", ") || "",
      "BONKED 3": Array.from(bonkedUsersData.tertiary).join(", ") || "",
    };
    if (!googleDoc) {
      console.error(`${logPrefix} Sheets not configured.`);
      await channel.send("Error: Google Sheets not configured.");
      return { success: false, reason: "sheets_not_configured" };
    }

    const result = await upsertRowByOrderValue(orderColumnValue, rowData);

    if (result.success) {
      console.log(`${logPrefix} Data ${result.action}.`);
      const ooLinkFmt = ooLink === "" ? "Not found" : `[here](${ooLink})`;
      let actionTxt = result.action;
      let resp = `Ticket data for Order #${orderColumnValue} ${actionTxt}!\n**Proposal:** ${proposalNumber}\n`;
      if (typeColumn) resp += `**Type:** ${typeColumn}\n`;
      resp += `**OO Link:** ${ooLinkFmt}\n`;
      if (disputedColumn) {
        resp += `**Disputed:** ${disputedColumn}\n`;
      } else if (
        recordType !== "assertion" &&
        recordType !== "snapshot" &&
        !typeColumn.toLowerCase().includes("assertion")
      ) {
        resp +=
          `**P/S/T:** ${primaryUser || "-"}/${secondaryUser || "-"}/${
            terciaryUser || "-"
          }\n` +
          `**Closer:** ${closerUser || "-"}, **Recorder:** ${recorderUser}\n` +
          `**Bonkers:** ${bonkersInMessageText.join(", ") || "None"}\n` +
          `**BONKED P/S/T:** P:[${
            Array.from(bonkedUsersData.primary).join(", ") || "N"
          }] S:[${
            Array.from(bonkedUsersData.secondary).join(", ") || "N"
          }] T:[${Array.from(bonkedUsersData.tertiary).join(", ") || "N"}]`;
      }
      await channel.send(resp);
      if (botConfig.currentPostProcessingAction !== "none") {
        const cmd =
          botConfig.currentPostProcessingAction === "delete"
            ? TICKET_TOOL_DELETE_COMMAND_TEXT
            : TICKET_TOOL_CLOSE_COMMAND_TEXT;
        if (cmd) {
          try {
            await channel.send(cmd);
            console.log(`${logPrefix} Sent: ${cmd}`);
          } catch (e) {
            console.error(`${logPrefix} Err sending post-processing cmd:`, e);
            await channel.send(
              "Saved, but failed to send post-processing cmd."
            );
          }
        } else
          console.log(
            `${logPrefix} No post-processing cmd configured for action: ${botConfig.currentPostProcessingAction}.`
          );
      }
      return { success: true, action: result.action };
    } else {
      console.error(
        `${logPrefix} Failed to save/update sheet. Message: ${
          result.message || "Unknown"
        }`
      );
      let errSave =
        result.action === "not_found" &&
        result.message &&
        result.message.includes("Order Column")
          ? `Flag: ${result.message}`
          : result.action === "not_found"
          ? `Flag: Row for Order #${orderColumnValue} not found. Data NOT added.`
          : `Error: Issue saving/updating sheet for Order #${orderColumnValue}.`;
      if (botConfig.errorNotificationUserID)
        errSave += ` <@${botConfig.errorNotificationUserID}>`;
      await channel.send(errSave);
      return {
        success: false,
        reason: result.reason || result.action || "sheets_upsert_error",
      };
    }
  } catch (error) {
    console.error(`${logPrefix} Major processing error:`, error);
    let majErr = `Flag: Major processing error for Order #${orderColumnValue}. Check logs.`;
    if (botConfig.errorNotificationUserID)
      majErr += ` <@${botConfig.errorNotificationUserID}>`;
    await channel.send(majErr);
    return { success: false, reason: "unknown_error" };
  }
}

async function processThread(
  threadChannel,
  initiatedByDisplayName,
  recordType = "standard"
) {
  const logPrefix = `[Thread: ${threadChannel.name} (${threadChannel.id})]`;
  console.log(
    `${logPrefix} Starting processing. Initiated by: ${initiatedByDisplayName}, Type: ${recordType}`
  );

  let date = "",
    ooLink = "",
    primaryUser = "",
    secondaryUser = "",
    terciaryUser = "",
    typeColumn = capitalizeFirstLetter(blockTypes[0]), //By default Polymarket
    closerUser = "",
    disputedColumn = "";
  const proposalNameForSheet = threadChannel.name;
  const recorderUser = initiatedByDisplayName;
  const findoorUsers = new Set();
  const bonkersInMessageText = [];
  const bonkedUsersData = {
    primary: new Set(),
    secondary: new Set(),
    tertiary: new Set(),
  };
  let validationErrorMessages = [];

  const orderColumnValue = threadChannel.name;
  console.log(`${logPrefix} Order Column Value: #${orderColumnValue}`);

  if (threadChannel.createdTimestamp) {
    const creationDate = new Date(threadChannel.createdTimestamp);
    date = `${
      creationDate.getMonth() + 1
    }/${creationDate.getDate()}/${creationDate.getFullYear()}`;
  } else {
    console.warn(`${logPrefix} Could not get thread creation timestamp.`);
  }

  try {
    const starterMessage = await threadChannel
      .fetchStarterMessage()
      .catch((err) => {
        console.error(`${logPrefix} Could not fetch starter message:`, err);
        return null;
      });

    const referenceLinkMatch = starterMessage.content.match(
      /https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/
    );
    if (!referenceLinkMatch) {
      console.log(
        `${logPrefix} No Discord message link found in starter message.`
      );
    } else {
      const [, linkedChannelId, linkedMessageId] = referenceLinkMatch;
      try {
        const linkedChannel = await client.channels.fetch(linkedChannelId);
        if (!linkedChannel || !linkedChannel.isTextBased()) {
          await threadChannel.send(
            `Flag: Linked channel ID ${linkedChannelId} not valid. <@${
              botConfig.errorNotificationUserID || ""
            }>`
          );
          return { success: false, reason: "linked_channel_not_text" };
        }
        const feedMessage = await linkedChannel.messages.fetch(linkedMessageId);

        let foundLink = null;
        if (feedMessage.embeds && feedMessage.embeds.length > 0) {
          for (const embed of feedMessage.embeds) {
            foundLink =
              findValidLinkIn(embed.url) || findValidLinkIn(embed.description);
            if (foundLink) break;
            if (embed.fields && embed.fields.length > 0) {
              for (const field of embed.fields) {
                foundLink = findValidLinkIn(field.value);
                if (foundLink) break;
              }
            }
            if (foundLink) break;
          }
        }
        if (!foundLink) {
          foundLink = findValidLinkIn(feedMessage.content);
        }
        if (foundLink) {
          ooLink = foundLink;
        }
      } catch (err) {
        console.error(
          `${logPrefix} Error fetching/processing linked message for OO Link:`,
          err
        );
      }
    }

    const threadMessages = await threadChannel.messages.fetch({ limit: 100 });
    let closingMessage = null;
    for (const msg of threadMessages.values()) {
      if (msg.content.toLowerCase().startsWith("closing:")) {
        closingMessage = msg;
        break;
      }
    }

    let closingBlockFoundAndProcessed = false;
    if (blockTypes.includes(recordType)) {
      primaryUser = "";
      secondaryUser = "";
      terciaryUser = "";
      closerUser = recorderUser;
      bonkersInMessageText.length = 0;
      bonkedUsersData.primary.clear();
      bonkedUsersData.secondary.clear();
      bonkedUsersData.tertiary.clear();
      disputedColumn = "";
      closingBlockFoundAndProcessed = true;

      if (recordType === "assertion") {
        typeColumn = "Assertion";
        console.log(`${logPrefix} Processing as Assertion (manual).`);
      } else if (recordType === "disputed") {
        typeColumn = "Disputed";
        disputedColumn = "y";
        console.log(`${logPrefix} Processing as Disputed (manual).`);
      } else if (recordType === "snapshot") {
        typeColumn = "Snapshot";
        console.log(`${logPrefix} Processing as Snapshot (manual).`);
      } else if (recordType === "polymarket") {
        typeColumn = "Polymarket";
        console.log(`${logPrefix} Processing as Polymarket (manual).`);
      }
    } else if (closingMessage) {
      closingBlockFoundAndProcessed = true;
      let member = closingMessage.member;
      if (!member) {
        try {
          console.log(
            `${logPrefix} Member not cached for message author ${closingMessage.author.id}. Fetching...`
          );
          member = await closingMessage.guild.members.fetch(
            closingMessage.author.id
          );
        } catch (fetchError) {
          console.error(
            `${logPrefix} Could not fetch member for user ${closingMessage.author.id}.`,
            fetchError
          );
          member = null;
        }
      }
      closerUser = member?.displayName ?? closingMessage.author.displayName;
      console.log(`${logPrefix} 'CLOSING:' block found by ${closerUser}`);

      const messageContentLines = closingMessage.content.split("\n");
      const firstLineLower = messageContentLines.shift()?.toLowerCase() || "";
      const closingLineContentRaw = firstLineLower.startsWith("closing:")
        ? firstLineLower.substring(8).trim()
        : "";

      if (blockTypes.includes(closingLineContentRaw)) {
        typeColumn =
          closingLineContentRaw.charAt(0).toUpperCase() +
          closingLineContentRaw.slice(1);
        if (closingLineContentRaw === "disputed") {
          disputedColumn = "y";
        }
        primaryUser = "";
        secondaryUser = "";
        terciaryUser = "";
      } else {
        const usersRaw = closingLineContentRaw
          ? closingLineContentRaw
              .split(/[.,]/)
              .map((n) => n.trim())
              .filter(Boolean)
          : [];
        if (usersRaw.length > 3) {
          validationErrorMessages.push(
            `Error: "CLOSING:" line max 3 P/S/T users. Found: ${usersRaw.length}.`
          );
        }

        const pstUsers = [];
        usersRaw.forEach((userStr) => {
          const findoorMatch = userStr.match(/^(.*?)\s*\(\s*findoor\s*\)$/i);
          if (findoorMatch) {
            const userName = capitalizeFirstLetter(findoorMatch[1].trim());
            pstUsers.push(userName);
            findoorUsers.add(userName);
          } else {
            pstUsers.push(capitalizeFirstLetter(userStr));
          }
        });
        primaryUser = pstUsers[0] || "";
        secondaryUser = pstUsers[1] || "";
        terciaryUser = pstUsers[2] || "";
      }

      const closingData = parseClosingBlock(messageContentLines);
      bonkedUsersData.primary = closingData.bonkedUsersData.primary;
      bonkedUsersData.secondary = closingData.bonkedUsersData.secondary;
      bonkedUsersData.tertiary = closingData.bonkedUsersData.tertiary;

      bonkersInMessageText.push(...closingData.bonkersList);

      if (closingData.manualLink) {
        ooLink = closingData.manualLink;
        console.log(
          `${logPrefix} OO Link overridden from CLOSING message: ${ooLink}`
        );
      }
      if (closingData.manualType) {
        typeColumn = closingData.manualType;
        console.log(
          `${logPrefix} Type overridden from CLOSING message: ${typeColumn}`
        );
      }
      if (closingData.alertoorUser) {
        disputedColumn = `y (Alertoor: ${closingData.alertoorUser})`;
        console.log(
          `${logPrefix} Disputed column set by Alertoor: ${closingData.alertoorUser}`
        );
      }
    }

    if (ooLink === "") {
      console.log(`${logPrefix} OO Link NOT FOUND. Flagging.`);
      let flagMessage = `Flag: OO Link not found after checking referenced message. Manual review needed.`;
      if (botConfig.errorNotificationUserID)
        flagMessage += ` <@${botConfig.errorNotificationUserID}>`;
      await threadChannel.send(flagMessage);
      return { success: false, reason: "oo_link_not_found_and_flagged" };
    }

    if (validationErrorMessages.length > 0) {
      console.error(
        `${logPrefix} Validation errors: ${validationErrorMessages.join("; ")}.`
      );
      let errReply = `Error(s) found (data not saved):\n- ${validationErrorMessages.join(
        "\n- "
      )}`;
      if (botConfig.errorNotificationUserID)
        errReply += ` <@${botConfig.errorNotificationUserID}>`;
      errReply += "\n\nPlease correct and re-run `!recordt`.";
      await threadChannel.send(errReply);
      return { success: false, reason: "validation_error_in_closing_block" };
    }

    if (recordType === "standard" && !closingBlockFoundAndProcessed) {
      console.log(`${logPrefix} "CLOSING:" message not found. Flagging.`);
      let flagMsg = `Flag: "CLOSING:" message not found. Manual review needed.`;
      if (botConfig.errorNotificationUserID)
        flagMsg += ` <@${botConfig.errorNotificationUserID}>`;
      await threadChannel.send(flagMsg);
      return { success: false, reason: "no_closing_message_and_flagged" };
    }

    const rowData = {
      [ORDER_COLUMN_HEADER]: orderColumnValue,
      [PROPOSAL_COLUMN_HEADER_FOR_SHEET]: proposalNameForSheet,
      Date: date,
      "OO Link": ooLink,
      Primary: primaryUser,
      Secondary: secondaryUser,
      Tertiary: terciaryUser,
      Findoor: Array.from(findoorUsers).join(", ") || "",
      Closer: closerUser,
      Recorder: recorderUser,
      "Disputed? (y?)": disputedColumn,
      "bonker 1": bonkersInMessageText[0] || "",
      "bonker 2": bonkersInMessageText[1] || "",
      "bonker 3": bonkersInMessageText[2] || "",
      "bonker 4": bonkersInMessageText[3] || "",
      "bonker 5": bonkersInMessageText.slice(4).join(", ") || "",
      "BONKED 1": Array.from(bonkedUsersData.primary).join(", ") || "",
      "BONKED 2": Array.from(bonkedUsersData.secondary).join(", ") || "",
      "BONKED 3": Array.from(bonkedUsersData.tertiary).join(", ") || "",
      "Type (PM / Snap, etc)": typeColumn,
    };

    if (!googleDoc) {
      console.error(`${logPrefix} Sheets not configured.`);
      await threadChannel.send("Error: Google Sheets not configured.");
      return { success: false, reason: "sheets_not_configured" };
    }

    const result = await upsertRowByProposalName(proposalNameForSheet, rowData);

    if (result.success) {
      console.log(`${logPrefix} Data ${result.action}.`);
      const ooLinkFmt = ooLink === "" ? "Not found" : `[here](${ooLink})`;
      let actionTxt = result.action;
      let resp = `Thread data for "${proposalNameForSheet}" ${actionTxt} in Google Sheets!\n**Date:** ${date}\n(#${orderColumnValue})\n`;
      if (typeColumn) resp += `**Type:** ${typeColumn}\n`;
      resp += `**OO Link:** ${ooLinkFmt}\n`;
      if (disputedColumn) {
        resp += `**Disputed:** ${disputedColumn}\n`;
      } else if (
        recordType !== "assertion" &&
        recordType !== "snapshot" &&
        !typeColumn.toLowerCase().includes("assertion")
      ) {
        resp +=
          `**P/S/T:** ${primaryUser || "-"}/${secondaryUser || "-"}/${
            terciaryUser || "-"
          }\n` +
          `**Findoor(s):** ${Array.from(findoorUsers).join(", ") || "None"}\n` +
          `**Closer:** ${closerUser || "-"}, **Recorder:** ${recorderUser}\n` +
          `**Bonkers:** ${bonkersInMessageText.join(", ") || "None"}\n` +
          `**BONKED P/S/T:** P:[${
            Array.from(bonkedUsersData.primary).join(", ") || "N"
          }] S:[${
            Array.from(bonkedUsersData.secondary).join(", ") || "N"
          }] T:[${Array.from(bonkedUsersData.tertiary).join(", ") || "N"}]`;
      }
      await threadChannel.send(resp);
      return { success: true, action: result.action };
    } else {
      console.error(
        `${logPrefix} Failed to save/update sheet. Message: ${
          result.message || "Unknown"
        }`
      );
      let errSave = `Error: Issue saving/updating sheet for "${proposalNameForSheet}".`;
      if (botConfig.errorNotificationUserID)
        errSave += ` <@${botConfig.errorNotificationUserID}>`;
      await threadChannel.send(errSave);
      return {
        success: false,
        reason: result.reason || result.action || "sheets_upsert_error",
      };
    }
  } catch (error) {
    console.error(`${logPrefix} Major processing error:`, error);
    let majErr = `Error: Major processing error for "${proposalNameForSheet}". Check logs.`;
    if (botConfig.errorNotificationUserID)
      majErr += ` <@${botConfig.errorNotificationUserID}>`;
    await threadChannel.send(majErr);
    return { success: false, reason: "unknown_error" };
  }
}

async function performMassScan() {
  if (!botConfig.autoProcessingEnabled) {
    console.log(
      `[${new Date().toISOString()}] Auto-processing is disabled. Scan skipped.`
    );
    scheduleNextScan();
    return;
  }
  if (isMassScanInProgress) {
    console.log(
      `[${new Date().toISOString()}] Mass scan already in progress. Skipping this cycle.`
    );
    return;
  }

  isMassScanInProgress = true;
  console.log(
    `[${new Date().toISOString()}] Starting scheduled mass ticket scan... Lock acquired.`
  );

  try {
    const guild = client.guilds.cache.first();
    if (!guild) {
      console.log(
        `[${new Date().toISOString()}] Bot is not in a guild. Scan aborted.`
      );
      return;
    }
    console.log(`[${new Date().toISOString()}] Scanning guild: ${guild.name}`);

    const channelsToProcess = [];
    for (const [_id, ch] of guild.channels.cache) {
      if (
        (ch.type === ChannelType.GuildText ||
          ch.type === ChannelType.PublicThread ||
          ch.type === ChannelType.PrivateThread) &&
        ch.name.toLowerCase().startsWith("proposal-") &&
        !currentlyProcessingChannels.has(ch.id)
      ) {
        const age = Date.now() - ch.createdTimestamp;
        if (age >= botConfig.minTicketAgeForProcessing) {
          channelsToProcess.push(ch);
        }
      }
    }

    if (channelsToProcess.length > 0) {
      console.log(
        `[${new Date().toISOString()}] Found ${
          channelsToProcess.length
        } eligible ticket(s) for processing.`
      );

      console.log("Sorting tickets by proposal number...");
      channelsToProcess.sort((a, b) => {
        const numA = parseInt(a.name.split("-")[1]) || 0;
        const numB = parseInt(b.name.split("-")[1]) || 0;
        return numA - numB;
      });

      for (let i = 0; i < channelsToProcess.length; i++) {
        const channel = channelsToProcess[i];
        if (currentlyProcessingChannels.has(channel.id)) {
          console.log(
            `Cron: Channel ${channel.name} is already in processing set, skipping this iteration.`
          );
          continue;
        }

        console.log(
          `[${new Date().toISOString()}] Attempting to process: ${
            channel.name
          } (${i + 1} of ${channelsToProcess.length}).`
        );
        currentlyProcessingChannels.add(channel.id);
        let processingResult;
        try {
          processingResult = await processTicketChannel(
            channel,
            "Automatic Scan",
            "standard"
          );
        } catch (e) {
          console.error(
            `[${new Date().toISOString()}] Uncaught error processing channel ${
              channel.name
            } in mass scan:`,
            e
          );
          processingResult = {
            success: false,
            reason: "uncaught_error_in_process",
          };
        } finally {
          currentlyProcessingChannels.delete(channel.id);
          console.log(
            `[${new Date().toISOString()}] Finished with ${
              channel.name
            }. Removed from processing set.`
          );
        }

        if (i < channelsToProcess.length - 1) {
          const reasonsToSkipLongDelay = [
            "flagged_explicitly",
            "no_closing_message_and_flagged",
            "oo_link_not_found_and_flagged",
            "invalid_proposal_id_format",
            "flagged_or_processed",
          ];
          if (
            processingResult &&
            reasonsToSkipLongDelay.includes(processingResult.reason)
          ) {
            console.log(
              `Cron: Ticket ${channel.name} resulted in a skip/flag (${processingResult.reason}). Short delay.`
            );
            await new Promise((r) => setTimeout(r, 500));
          } else {
            console.log(
              `Cron: Staggering for ${
                DELAY_BETWEEN_TICKET_PROCESSING_MS / 1000
              }s before next ticket.`
            );
            await new Promise((r) =>
              setTimeout(r, DELAY_BETWEEN_TICKET_PROCESSING_MS)
            );
          }
        }
      }
    } else {
      console.log(
        `[${new Date().toISOString()}] No eligible tickets found in this scan cycle.`
      );
    }
  } catch (scanError) {
    console.error(
      `[${new Date().toISOString()}] Major error during mass scan execution:`,
      scanError
    );
  } finally {
    botConfig.lastSuccessfulScanTimestamp = Date.now();
    await saveConfig(false);
    isMassScanInProgress = false;
    console.log(
      `[${new Date().toISOString()}] Mass scan finished. Lock released.`
    );
    scheduleNextScan();
  }
}

function scheduleNextScan() {
  if (scanTimeoutId) {
    clearTimeout(scanTimeoutId);
  }
  if (!botConfig.autoProcessingEnabled) {
    console.log(
      "Auto-processing disabled, not scheduling next scan via setTimeout."
    );
    return;
  }
  scanTimeoutId = setTimeout(performMassScan, botConfig.processingIntervalMs);
  console.log(
    `Next mass ticket scan scheduled in ~${Math.round(
      botConfig.processingIntervalMs / 60000
    )} minutes.`
  );
}

client.on("messageCreate", async (message) => {
  if (message.author.bot && message.author.id !== client.user.id) return;
  if (!message.guild || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  if (commandName === "record") {
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)
    )
      return message.reply("No permission.");

    if (message.channel.isThread()) {
      await message.reply(
        "Error: !record is just for using on tickets... Use !recordt instead"
      );
      return;
    }

    const subCommand = (args[0] || "").toLowerCase();
    let recordType = "standard";
    let initiatedByString = `Manual Record by ${message.member.displayName}`;

    if (blockTypes.includes(subCommand)) {
      recordType = subCommand;
      initiatedByString = `Manual ${
        subCommand.charAt(0).toUpperCase() + subCommand.slice(1)
      } Record by ${message.member.displayName}`;
    }

    await message.reply(
      `Processing ${message.channel.name} as ${recordType}...`
    );
    await processTicketChannel(message.channel, initiatedByString, recordType);
  } else if (commandName === "recordt") {
    if (!message.channel.isThread()) {
      await message.reply(
        "Error: !recordt is just for using on threads... Use !record instead"
      );
      return;
    }
    if (
      !message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)
    )
      return message.reply("No permission.");

    const subCommand = (args[0] || "").toLowerCase();
    let recordType = "standard";

    if (blockTypes.includes(subCommand)) {
      recordType = subCommand;
    }
    await message.reply(
      `Processing thread ${message.channel.name} as ${recordType}...`
    );
    await processThread(
      message.channel,
      message.member.displayName,
      recordType
    );
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  const { commandName } = interaction;
  if (commandName === "config") {
    if (typeof botConfig === "undefined" || typeof saveConfig === "undefined") {
      return interaction.reply({ content: "Config error.", flags: MessageFlags.Ephemeral });
    }
    const subCommand = interaction.options.getSubcommand();
    if (
      !interaction.memberPermissions.has(
        PermissionsBitField.Flags.Administrator
      )
    ) {
      return interaction.reply({ content: "Admin only.", flags: MessageFlags.Ephemeral });
    }
    let configChanged = false;

    if (subCommand === "set_post_processing_action") {
      const act = interaction.options.getString("action");
      if (botConfig.currentPostProcessingAction !== act) {
        botConfig.currentPostProcessingAction = act;
        configChanged = true;
      }
      await interaction.reply({
        content: `Post processing action: **${botConfig.currentPostProcessingAction}**.`,
        flags: MessageFlags.Ephemeral,
      });
    } else if (subCommand === "toggle_auto_processing") {
      const newState = interaction.options.getBoolean("enabled");
      if (botConfig.autoProcessingEnabled !== newState) {
        botConfig.autoProcessingEnabled = newState;
        configChanged = true;
        if (botConfig.autoProcessingEnabled) {
          console.log(
            "Auto-processing enabled by command. Ensuring next scan is scheduled."
          );
          isMassScanInProgress = false;
          clearTimeout(scanTimeoutId);
          scheduleNextScan();
        } else {
          clearTimeout(scanTimeoutId);
          console.log(
            "Auto-processing disabled by command. Future scans cancelled."
          );
        }
      }
      await interaction.reply({
        content: `Auto processing: **${
          botConfig.autoProcessingEnabled ? "on" : "off"
        }**.`,
        flags: MessageFlags.Ephemeral,
      });
    } else if (subCommand === "set_min_ticket_age") {
      const ageStr = interaction.options.getString("age");
      const ms = parseDurationToMs(ageStr);
      if (ms && ms > 0) {
        if (botConfig.minTicketAgeForProcessing !== ms) {
          botConfig.minTicketAgeForProcessing = ms;
          configChanged = true;
        }
        await interaction.reply({
          content: `Min ticket age: **${ageStr}** (~${Math.round(
            ms / 60000
          )}m).`,
          flags: MessageFlags.Ephemeral,
        });
      } else
        await interaction.reply({
          content: `Invalid age: "${ageStr}". Use "2h5m", "30m", "1d", "125" (mins).`,
          flags: MessageFlags.Ephemeral,
        });
    } else if (subCommand === "set_processing_interval") {
      const intervalString = interaction.options.getString("interval");
      const parsedMs = parseDurationToMs(intervalString);
      if (parsedMs !== null && parsedMs >= 60000) {
        if (botConfig.processingIntervalMs !== parsedMs) {
          botConfig.processingIntervalMs = parsedMs;
          configChanged = true;
          console.log(
            `Processing interval changed to ${parsedMs}ms. Re-scheduling next scan.`
          );
          scheduleNextScan();
        }
        await interaction.reply({
          content: `Ticket processing interval set to: **${intervalString}** (~${Math.round(
            parsedMs / 60000
          )} minutes). Next scan cycle adjusted.`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: `Invalid interval: "${intervalString}". Use "30m", "1h", etc. Min 1 minute.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } else if (subCommand === "set_error_user") {
      const user = interaction.options.getUser("user");
      if (user) {
        if (botConfig.errorNotificationUserID !== user.id) {
          botConfig.errorNotificationUserID = user.id;
          configChanged = true;
        }
        await interaction.reply({
          content: `Error pings will target: **${user.tag}** (<@${user.id}>).`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        if (botConfig.errorNotificationUserID !== null) {
          botConfig.errorNotificationUserID = null;
          configChanged = true;
        }
        await interaction.reply({
          content: `Error ping user cleared.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } else if (subCommand === "view_settings") {
      const ageM = Math.round(botConfig.minTicketAgeForProcessing / 60000);
      const procIntM = Math.round(botConfig.processingIntervalMs / 60000);
      const errU = botConfig.errorNotificationUserID
        ? `<@${botConfig.errorNotificationUserID}>`
        : "Not set";

      let nextScanInfo;
      if (!botConfig.autoProcessingEnabled) {
        nextScanInfo = "Auto-processing disabled.";
      } else if (isMassScanInProgress) {
        nextScanInfo = "A mass scan is currently in progress.";
      } else {
        const nextScanTimestamp =
          (botConfig.lastSuccessfulScanTimestamp || 0) +
          botConfig.processingIntervalMs;
        const timeRemainingMs = nextScanTimestamp - Date.now();
        if (timeRemainingMs <= 0) {
          nextScanInfo = "A scan is due to start very soon.";
        } else {
          nextScanInfo = `Next scan **${formatMsToHumanReadable(
            timeRemainingMs
          )}**.`;
        }
      }

      await interaction.reply({
        content:
          `Current Bot Configuration:\n` +
          `- Ticket Processing Interval: **${procIntM} minutes**\n` +
          `- Automatic Processing: **${
            botConfig.autoProcessingEnabled ? "Enabled" : "Disabled"
          }**\n` +
          `- Next Scan: ${nextScanInfo}\n` +
          `- Default Post Processing Action: **${botConfig.currentPostProcessingAction}**\n` +
          `- Min Ticket Age for Auto-Processing: **${ageM} minutes**\n` +
          `- Error Notification User: **${errU}**`,
        flags: MessageFlags.Ephemeral,
      });
    } else
      await interaction.reply({
        content: "Unknown config subcmd.",
        flags: MessageFlags.Ephemeral,
      });
    if (configChanged) {
      await saveConfig(false);
    }
  } else if (commandName === "scan_status") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.ManageMessages
      )
    ) {
      return interaction.reply({
        content: "You do not have sufficient permissions.",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!botConfig.autoProcessingEnabled) {
      return interaction.reply({
        content: "Automatic ticket processing is currently **disabled**.",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (isMassScanInProgress) {
      return interaction.reply({
        content: "A mass scan is **currently in progress**.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const nextScanTimestamp =
      (botConfig.lastSuccessfulScanTimestamp || 0) +
      botConfig.processingIntervalMs;
    const timeRemainingMs = nextScanTimestamp - Date.now();

    if (timeRemainingMs <= 0) {
      await interaction.reply({
        content:
          "A ticket scan is due and should start very soon (within the next minute).",
        flags: MessageFlags.Ephemeral,
      });
    } else {
      const timeRemainingReadable = formatMsToHumanReadable(timeRemainingMs);
      await interaction.reply({
        content: `Next full ticket scan is scheduled **${timeRemainingReadable}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } else if (commandName === "stats") {
    if (
      !interaction.memberPermissions.has(
        PermissionsBitField.Flags.ManageMessages
      )
    ) {
      return interaction.reply({
        content: "You do not have sufficient permissions.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const subCommand = interaction.options.getSubcommand();
    const startOrder = interaction.options.getInteger("start_order") ?? 0;

    // Mapeamos el subcomando al nombre exacto de la columna en la hoja de cálculo
    const columnMap = {
      closers: "Closer",
      primary: "Primary",
      secondary: "Secondary",
      tertiary: "Tertiary",
    };

    const targetColumn = columnMap[subCommand];

    if (targetColumn) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const responseMessage = await getStatsForColumn(
          targetColumn,
          startOrder
        );
        await interaction.editReply({ content: responseMessage });
      } catch (error) {
        console.error(`Error fetching stats for ${targetColumn}:`, error);
        await interaction.editReply({
          content: `An error occurred while fetching stats: ${error.message}`,
        });
      }
    }
  }
});

async function initializeBot() {
  await loadConfig();
  if (
    !DISCORD_TOKEN ||
    !GOOGLE_SHEET_ID ||
    !GOOGLE_SERVICE_ACCOUNT_EMAIL ||
    !GOOGLE_PRIVATE_KEY
  ) {
    console.error(`Critical env vars missing. Bot will not start.`);
    return;
  }
  client.on("ready", () => {
    console.log(`${client.user.tag} has connected to Discord and is ready!`);
    console.log(
      `Initial auto-processing state: ${
        botConfig.autoProcessingEnabled ? "Enabled" : "Disabled"
      }`
    );
    console.log(
      `Initial processing interval: ${
        botConfig.processingIntervalMs / 60000
      } minutes`
    );

    if (botConfig.autoProcessingEnabled) {
      console.log(
        "Auto-processing is enabled. Performing an initial scan immediately upon startup."
      );
      performMassScan();
    } else {
      console.log(
        "Auto-processing is initially disabled. No scan will run until enabled via command."
      );
    }
  });
  client.login(DISCORD_TOKEN).catch((err) => {
    console.error("Failed to log into Discord:", err);
    if (
      err.code === "TokenInvalid" ||
      (err.message && err.message.includes("Privileged Intents"))
    ) {
      console.error("CHECK TOKEN & INTENTS IN DISCORD DEV PORTAL.");
    }
  });
}

initializeBot();
