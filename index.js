require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  MessageFlags,
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

const TICKET_TOOL_USER_ID = process.env.TICKET_TOOL_USER_ID;
const OO_LIVE_FEED_CHANNEL_ID = process.env.OO_LIVE_FEED_CHANNEL_ID;
const FAILED_TICKETS_FORUM_ID = process.env.FAILED_TICKETS_FORUM_ID;

const OTB_VERIFICATIONS_CHANNEL_ID = process.env.OTB_VERIFICATIONS_CHANNEL_ID;
const OTB_BOT_USER_ID = process.env.OTB_BOT_USER_ID;

const VERIFIER_ID_MAP = {
  // --- Bots ---
  "1168799488819859506": "Thatcryptogal",
  "1315158450023436419": "Brooks",
  "1306255447921266708": "Moon",
  "1166775345786126458": "Kurapika",
  "1166811542927454238": "Bonded",
  "1251472380732244111": "Mperry",
  "1440048299888480329": "Henry",
  "1166811112105324635": "Obito",
  "1440057036363661495": "SolaX",
  "1440048398421201086": "Williamson",

  // --- Verifiers ---
  "1192038652428156930": "Williamson",
  "1087299154629365780": "Henry",
  "740634549070856243": "Kurapika",
  "1465243309852201093": "Mperry",
  "948633228741320764": "Obito",
  "693794367395332196": "RuneManny",
  "1089240716988919990": "Cha",
  "920460678580547665": "Anglo",
  "927149128440508457": "SolaX",
  "1194602153210282107": "Coffee",
  "1348003493713023117": "crzu",
  "424567831657709594": "Lonfus",
  "975111115858124850": "Ace",
  "1209765189885501523": "Hayy",
  "560891548963700749": "Say10",
  "757559795401097276": "ZenMaster",
  "838764590094745631": "Thatcryptogal",
  "1467559478319910943": "Bonded",
  "620160105748496404": "Nemo",
  "634236418310275072": "Jessica",
  "964250522230087711": "Moon",
  "991526929930911744": "Brickz",
  "1057540551815213106": "Rikkybetty",
  "533270381218496523": "Fhantom",
  "182372734783717377": "Decap",
  "1075289665264955472": "Dynosawr",
  "959529778061398068": "Havillah",
  "1210165991225692214": "Ty",
  "441681034388701205": "JC",
  "194561713033445376": "Flame",
  "1342077143135289354": "Wacko",
  "218899496598372366": "Verrissimus",
  "489167811357311017": "aajjss",
  "252215153305583616": "aenews",
  "187029075485917184": "Pingu",
  "845581203628490762": "tenadome",
  "996906539199758389": "Elliot",
  "828689736596062219": "YNG",
  "792217223501840414": "Scout",
};

const KNOWN_VERIFIER_BOT_IDS = Object.keys(VERIFIER_ID_MAP);

let lastTicketToolActivityTimestamp = Date.now();
const FALLBACK_QUEUE_PROCESS_INTERVAL_MS = 60 * 1000;
const TICKET_TOOL_INACTIVITY_THRESHOLD_MS = 2 * 60 * 1000;
const MIN_AGE_FOR_FALLBACK_CHECK_MS = 25 * 60 * 1000;

const fallbackQueue = [];
const channelsToRecheck = new Set();
let isProcessingFallbackQueue = false;

const createdFallbackThreads = new Map();
const FALLBACK_RECORD_EXPIRATION_MS = 2 * 60 * 60 * 1000;
const OTB_CACHE_EXPIRATION_MS = 60 * 60 * 1000;
const otbVerifiedCache = new Map();

const pendingTicketTimers = new Map();

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
const DEFAULT_PROCESSING_INTERVAL_MS = 5 * 60 * 1000;
const DELAY_BETWEEN_TICKET_PROCESSING_MS =
  parseInt(process.env.DELAY_BETWEEN_TICKETS_MS, 10) || 10000;

const CONFIG_FILE_PATH = path.join(__dirname, "bot_config.json");
let botConfig = {
  autoProcessingEnabled:
    (process.env.ENABLE_AUTO_PROCESSING || "true").toLowerCase() === "true",
  currentPostProcessingAction: process.env.DEFAULT_TICKET_POST_ACTION || "none",
  autoSetPaidToN: true,
  minTicketAgeForProcessing: DEFAULT_MIN_TICKET_AGE_MS,
  processingIntervalMs: DEFAULT_PROCESSING_INTERVAL_MS,
  errorNotificationUserID: process.env.DEFAULT_ERROR_USER_ID || null,
  lastSuccessfulScanTimestamp: 0,
};

const currentlyProcessingChannels = new Set();
let isMassScanInProgress = false;
let isBacklogProcessRunning = false;
let scanTimeoutId = null;

const blockTypes = ["polymarket", "snapshot", "disputed", "assertion"];

const LINK_REGEX = new RegExp(
  /(https:\/\/(?:oracle\.uma\.xyz|snapshot\.org|snapshot\.xyz)\/[^\s<>()'"]+)/,
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

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${ms} ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
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

async function getStatsForColumn(columnName, startOrder, endOrder) {
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
      `Worksheet "${WORKSHEET_TITLE_MAIN}" not found in the master sheet.`,
    );
  }

  const rows = await sheet.getRows();
  const counts = {};

  for (const row of rows) {
    const orderNum = parseInt(row.get(ORDER_COLUMN_HEADER), 10);
    const value = row.get(columnName)?.trim();

    if (
      !isNaN(orderNum) &&
      orderNum >= startOrder &&
      orderNum <= endOrder &&
      value
    ) {
      counts[value] = (counts[value] || 0) + 1;
    }
  }

  const sortedData = Object.entries(counts).sort(([, a], [, b]) => b - a);

  let rangeText = "";
  if (startOrder === 0 && endOrder === Infinity) {
    rangeText = "(All Orders)";
  } else if (endOrder === Infinity) {
    rangeText = `(from Order #${startOrder})`;
  } else if (startOrder === 0) {
    rangeText = `(up to Order #${endOrder})`;
  } else {
    rangeText = `(from Order #${startOrder} to #${endOrder})`;
  }

  if (sortedData.length === 0) {
    return `No data found for column "${columnName}" in the specified range ${rangeText}.`;
  }

  let responseMessage = `**${capitalizeFirstLetter(
    columnName,
  )} Stats ${rangeText}**\n\`\`\`\n`;
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

/*
function parseClosingBlock(lines) {
  const bonkersList = [];
  const bonkedUsersData = {
    primary: new Set(),
    secondary: new Set(),
    tertiary: new Set(),
    btertiary: new Set(),
  };
  let manualLink = null;
  let manualType = null;
  let alertoorUser = null;
  let manualFindoor = null;

  const bonkPattern =
    /^(.*?)\s+bonked\s+(.*?)\s+(primary|secondary|tertiary|btertiary)$/i;

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
      else if (type === "btertiary") bonkedUsersData.btertiary.add(victim);
    } else if (lowerCaseLine.startsWith("link:")) {
      manualLink = trimmedLine.substring(5).trim();
    } else if (lowerCaseLine.startsWith("type:")) {
      manualType = trimmedLine.substring(5).trim();
    } else if (lowerCaseLine.startsWith("alertoor:")) {
      alertoorUser = capitalizeFirstLetter(trimmedLine.substring(9).trim());
    } else if (lowerCaseLine.startsWith("findoor:")) {
      manualFindoor = capitalizeFirstLetter(trimmedLine.substring(8).trim());
    }
  }

  return {
    bonkersList,
    bonkedUsersData,
    manualLink,
    manualType,
    alertoorUser,
    manualFindoor,
  };
}
*/

function parseClosingBlock(lines) {
  const bonkersList = [];
  const allBonkedUsers = [];

  let manualLink = null;
  let manualType = null;
  let alertoorUser = null;
  let manualFindoor = null;

  const bonkPattern = /^(.*?)\s+bonked\s+(.*)$/i;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const lowerCaseLine = trimmedLine.toLowerCase();

    if (lowerCaseLine.includes("bonked")) {
      const bonkMatch = trimmedLine.match(bonkPattern);

      if (bonkMatch) {
        const bonker = capitalizeFirstLetter(bonkMatch[1].trim());
        const victimsRaw = bonkMatch[2].trim();
        const victims = victimsRaw
          .split(",")
          .map((v) => capitalizeFirstLetter(v.trim()))
          .filter(Boolean);

        for (const victim of victims) {
          bonkersList.push(bonker);
          allBonkedUsers.push(victim);
        }
        continue;
      }
    }

    if (lowerCaseLine.startsWith("link:")) {
      manualLink = trimmedLine.substring(5).trim();
    } else if (lowerCaseLine.startsWith("type:")) {
      manualType = trimmedLine.substring(5).trim();
    } else if (lowerCaseLine.startsWith("alertoor:")) {
      alertoorUser = capitalizeFirstLetter(trimmedLine.substring(9).trim());
    } else if (lowerCaseLine.startsWith("findoor:")) {
      manualFindoor = capitalizeFirstLetter(trimmedLine.substring(8).trim());
    }
  }

  return {
    bonkersList,
    bonkedUsersData: {
      primary: allBonkedUsers,
      secondary: new Set(),
      tertiary: new Set(),
      btertiary: new Set(),
    },
    manualLink,
    manualType,
    alertoorUser,
    manualFindoor,
  };
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
          `Invalid value for ${key} in config: "${loadedConfig[key]}". Using default.`,
        );
        botConfig[key] = defaultValue;
        changedDuringLoad = true;
      }
    };
    applyOrDefault(
      "autoProcessingEnabled",
      (process.env.ENABLE_AUTO_PROCESSING || "true").toLowerCase() === "true",
      (val) => typeof val === "boolean",
    );
    applyOrDefault(
      "currentPostProcessingAction",
      process.env.DEFAULT_TICKET_POST_ACTION || "none",
      (val) =>
        typeof val === "string" && ["none", "close", "delete"].includes(val),
    );
    applyOrDefault(
      "minTicketAgeForProcessing",
      DEFAULT_MIN_TICKET_AGE_MS,
      (val) => typeof val === "number" && val > 0,
    );
    applyOrDefault(
      "processingIntervalMs",
      DEFAULT_PROCESSING_INTERVAL_MS,
      (val) => typeof val === "number" && val > 0,
    );
    applyOrDefault(
      "errorNotificationUserID",
      process.env.DEFAULT_ERROR_USER_ID || null,
      (val) => typeof val === "string" || val === null,
    );
    applyOrDefault(
      "lastSuccessfulScanTimestamp",
      0,
      (val) => typeof val === "number",
    );

    if (loadedConfig.scanInterval !== undefined) changedDuringLoad = true;

    console.log("Configuration loaded from bot_config.json.");
    if (changedDuringLoad) {
      console.log(
        "Defaults applied or legacy keys found. Saving updated config.",
      );
      await saveConfig(false);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(
        "bot_config.json not found. Initializing with defaults and creating file.",
      );
      await saveConfig(false);
    } else {
      console.error(
        "Error loading bot_config.json. Using hardcoded/env defaults.",
        error,
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
      autoSetPaidToN: botConfig.autoSetPaidToN,
      processingIntervalMs: botConfig.processingIntervalMs,
      errorNotificationUserID: botConfig.errorNotificationUserID,
      lastSuccessfulScanTimestamp: botConfig.lastSuccessfulScanTimestamp,
    };
    await fs.writeFile(
      CONFIG_FILE_PATH,
      JSON.stringify(configToSave, null, 2),
      "utf8",
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
    "Warning: Core Google Sheets environment variables are missing.",
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
  dataWithOrderAndProposal,
) {
  const logPrefix = `[Order #${orderValueToFind}]`;
  if (!googleDoc) {
    console.error(
      `${logPrefix} Error: GoogleSpreadsheet instance not initialized.`,
    );
    return {
      success: false,
      action: "none",
      message: "GoogleSpreadsheet instance not initialized.",
    };
  }
  try {
    await withTimeout(googleDoc.loadInfo(), 30000);
    const sheet = googleDoc.sheetsByTitle[WORKSHEET_TITLE_MAIN];
    if (!sheet) {
      console.error(
        `${logPrefix} Error: Worksheet "${WORKSHEET_TITLE_MAIN}" not found.`,
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
        `${logPrefix} Error: Order Column "${ORDER_COLUMN_HEADER}" not in sheet.`,
      );
      return {
        success: false,
        action: "none",
        message: `Order Column "${ORDER_COLUMN_HEADER}" not found.`,
      };
    }

    const rows = await withTimeout(sheet.getRows(), 30000);
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
      await withTimeout(targetRow.save(), 30000);
      console.log(`${logPrefix} Row updated successfully.`);
      return { success: true, action: "updated" };
    } else {
      console.log(`${logPrefix} No row found. Adding new row...`);
      await withTimeout(sheet.addRow(dataForSheet), 30000);
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

async function upsertRowByOoLink(ooLinkKey, dataToUpsert) {
  const logPrefix = `[Thread: ${ooLinkKey}]`;
  if (!googleDoc) {
    console.error(
      `${logPrefix} Error: GoogleSpreadsheet instance not initialized.`,
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
        `${logPrefix} Error: Worksheet "${WORKSHEET_TITLE_FINDOOR}" not found.`,
      );
      return {
        success: false,
        action: "none",
        message: `Worksheet "${WORKSHEET_TITLE_FINDOOR}" not found.`,
      };
    }
    await sheet.loadHeaderRow();

    const keyColumnHeader = "OO Link";
    if (!sheet.headerValues.includes(keyColumnHeader)) {
      console.error(
        `${logPrefix} Error: Key Column "${keyColumnHeader}" not in sheet. Cannot upsert by OO Link.`,
      );
      return {
        success: false,
        action: "none",
        message: `Key Column "${keyColumnHeader}" not found.`,
      };
    }

    const rows = await sheet.getRows();
    let targetRow = null;

    for (let i = 0; i < rows.length; i++) {
      const cellOoLinkValue = rows[i].get(keyColumnHeader);
      if (
        cellOoLinkValue &&
        cellOoLinkValue.toString().trim() === ooLinkKey.trim()
      ) {
        targetRow = rows[i];
        break;
      }
    }

    const dataForSheet = {};
    for (const key of sheet.headerValues) {
      dataForSheet[key] =
        dataToUpsert[key] === "N/A" || dataToUpsert[key] === undefined
          ? ""
          : dataToUpsert[key];
    }

    dataForSheet[keyColumnHeader] = ooLinkKey;

    if (targetRow) {
      console.log(`${logPrefix} Row found by OO Link. Updating...`);
      for (const key in dataForSheet) {
        if (sheet.headerValues.includes(key))
          targetRow.set(key, dataForSheet[key]);
      }
      await targetRow.save();
      console.log(`${logPrefix} Row updated.`);
      return { success: true, action: "updated" };
    } else {
      console.log(
        `${logPrefix} No row found for OO Link "${ooLinkKey}". Adding new row...`,
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

async function autoArchiveInactiveThreads() {
  const logPrefix = "[Auto-Archive]";
  console.log(`${logPrefix} Starting routine to archive inactive threads...`);

  try {
    const parentChannel = await client.channels.fetch(FAILED_TICKETS_FORUM_ID);
    if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
      console.log(
        `${logPrefix} Could not find the configured text channel. Aborting.`,
      );
      return;
    }

    const activeThreads = await parentChannel.threads.fetchActive();
    if (activeThreads.threads.size === 0) {
      console.log(
        `${logPrefix} No active threads found to check. Routine finished.`,
      );
      return;
    }

    const archiveThresholdMs = 2 * 60 * 60 * 1000;
    const now = Date.now();
    let archivedCount = 0;

    for (const thread of activeThreads.threads.values()) {
      const lastMessages = await thread.messages
        .fetch({ limit: 1 })
        .catch(() => null);

      const lastActivityTimestamp =
        lastMessages?.first()?.createdTimestamp || thread.createdTimestamp;
      const inactivityDuration = now - lastActivityTimestamp;

      if (inactivityDuration > archiveThresholdMs) {
        try {
          if (!thread.archived) {
            await thread.setArchived(
              true,
              "Automatic cleanup of inactive thread",
            );
            console.log(
              `${logPrefix} Successfully archived inactive thread: ${thread.name}`,
            );
            archivedCount++;
            await new Promise((r) => setTimeout(r, 1000));
          }
        } catch (err) {
          console.error(
            `${logPrefix} Failed to archive thread ${thread.name}. Error:`,
            err.message,
          );
        }
      }
    }

    if (archivedCount > 0) {
      console.log(
        `${logPrefix} Routine finished. Archived ${archivedCount} inactive thread(s).`,
      );
    } else {
      console.log(
        `${logPrefix} Routine finished. No threads met the inactivity criteria for archiving.`,
      );
    }
  } catch (error) {
    console.error(
      `${logPrefix} A critical error occurred during the auto-archive routine:`,
      error,
    );
  }
}

async function processTicketChannel(
  channel,
  initiatedBy = "Automatic Scan",
  recordType = "standard",
) {
  const logPrefix = `[${channel.id} | ${channel.name}]`;
  console.log(
    `${logPrefix} Starting processing. Initiated by: ${initiatedBy}, Type: ${recordType}`,
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
  let disputeAlertoor = "";
  const bonkersInMessageText = [];
  const bonkedUsersData = {
    primary: new Set(),
    secondary: new Set(),
    tertiary: new Set(),
    btertiary: new Set(),
  };
  let validationErrorMessages = [];

  const channelNameMatch = channel.name.match(/proposal-(\d+)/i);
  proposalNumber =
    channelNameMatch && channelNameMatch[1]
      ? parseInt(channelNameMatch[1], 10).toString()
      : "";
  if (!proposalNumber) {
    console.log(
      `${logPrefix} Could not extract numeric ID from "${channel.name}". Skipping.`,
    );
    return { success: false, reason: "invalid_proposal_id_format" };
  }
  const orderColumnValue = proposalNumber;
  console.log(
    `${logPrefix} Normalized Proposal Number: ${proposalNumber} (Order #${orderColumnValue})`,
  );

  try {
    const fetchPromise = channel.messages.fetch({ limit: 100 });
    const allMessagesCollection = await withTimeout(fetchPromise, 15000);

    let bonkFound = false;
    let manualClosingMessage = null;
    let botFlagFound = false;

    for (const msg of allMessagesCollection.values()) {
      const lowerContent = msg.content.toLowerCase();

      if (
        initiatedBy === "Automatic Scan" &&
        lowerContent.startsWith("flag:") &&
        msg.author.id !== client.user.id
      ) {
        console.log(
          `${logPrefix} Found manual "Flag:" during automatic scan. Aborting.`,
        );
        return { success: false, reason: "manual_flag_found_on_scan" };
      }

      if (lowerContent.startsWith("ticket data for order")) {
        if (
          msg.author.id === client.user.id &&
          botConfig.currentPostProcessingAction === "delete" &&
          TICKET_TOOL_DELETE_COMMAND_TEXT
        ) {
          console.log(
            `${logPrefix} Found own processing summary, but channel still exists. Re-sending delete command.`,
          );
          try {
            await channel.send(TICKET_TOOL_DELETE_COMMAND_TEXT);
          } catch (e) {
            console.error(`${logPrefix} Failed to re-send delete command:`, e);
          }
          return { success: false, reason: "resent_delete_command" };
        }
        if (initiatedBy === "Automatic Scan") {
          console.log(
            `${logPrefix} Found previous processing summary. Aborting.`,
          );
          return { success: false, reason: "already_processed" };
        }
      }

      if (!manualClosingMessage && lowerContent.startsWith("closing:")) {
        manualClosingMessage = msg;
      }

      if (
        lowerContent.startsWith("flag:") &&
        msg.author.id === client.user.id
      ) {
        botFlagFound = true;
      }

      if (lowerContent.includes("bonk")) {
        bonkFound = true;
      }

      if (!ooLink) {
        let foundLink = findValidLinkIn(msg.content);
        if (msg.embeds && msg.embeds.length > 0) {
          for (const embed of msg.embeds) {
            foundLink =
              foundLink ||
              findValidLinkIn(embed.url) ||
              findValidLinkIn(embed.description);
            if (embed.fields && embed.fields.length > 0) {
              for (const field of embed.fields) {
                foundLink = foundLink || findValidLinkIn(field.value);
              }
            }
          }
        }
        if (foundLink) {
          ooLink = foundLink;
          console.log(`${logPrefix} Link FOUND: ${ooLink}`);
        }
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
      bonkedUsersData.btertiary.clear();
      disputedColumn = "";
      disputeAlertoor = "";
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
    } else {
      closingMessage = manualClosingMessage;
      let autoClosingGenerated = false;

      if (!closingMessage) {
        if (bonkFound) {
          if (!botFlagFound) {
            console.log(
              `${logPrefix} 'Bonk' found and no manual CLOSING message. Flagging for manual review.`,
            );
            let flagMsg = `Flag: "CLOSING:" message not found. Manual review needed.`;
            if (botConfig.errorNotificationUserID)
              flagMsg += ` <@${botConfig.errorNotificationUserID}>`;
            await channel.send(flagMsg);
          } else {
            console.log(
              `${logPrefix} 'Bonk' found, no CLOSING, but bot flag already exists. Skipping.`,
            );
          }
          return { success: false, reason: "no_closing_message_bonk_found" };
        }

        console.log(
          `${logPrefix} No manual CLOSING found and no blockers. Attempting auto-closing.`,
        );

        const allMessages = Array.from(
          allMessagesCollection.values(),
        ).reverse(); // Chronological order

        const ticketToolMessageIndex = allMessages.findIndex(
          (m) => m.author.id === TICKET_TOOL_USER_ID && m.embeds.length > 0,
        );

        if (ticketToolMessageIndex === -1) {
          console.log(
            `${logPrefix} Auto-closing failed: Cannot find Ticket Tool message. Flagging.`,
          );
          let flagMsg = `Flag: Auto-closing failed. Cannot find Ticket Tool message. Manual review needed.`;
          if (botConfig.errorNotificationUserID)
            flagMsg += ` <@${botConfig.errorNotificationUserID}>`;
          await channel.send(flagMsg);
          return { success: false, reason: "auto_close_no_tt_message" };
        }

        const messagesAfterTicketTool = allMessages.slice(
          ticketToolMessageIndex + 1,
        );
        const foundVerifiers = [];
        const foundVerifierIds = new Set();
        for (const msg of messagesAfterTicketTool) {
          if (!msg.content.toLowerCase().startsWith("verification")) continue;
          if (msg.author.bot && !KNOWN_VERIFIER_BOT_IDS.includes(msg.author.id))
            continue;

          if (foundVerifierIds.has(msg.author.id)) continue;

          let verifierName = VERIFIER_ID_MAP[msg.author.id];
          if (!verifierName) {
            // No está en el mapa, usamos el displayName como fallback
            const member =
              msg.member ||
              (await channel.guild.members
                .fetch(msg.author.id)
                .catch(() => null));
            verifierName = member?.displayName ?? msg.author.displayName;
            console.log(
              `${logPrefix} Verifier ID ${msg.author.id} not in map. Using fallback name: ${verifierName}`,
            );
          }

          foundVerifiers.push(verifierName);
          foundVerifierIds.add(msg.author.id);

          if (foundVerifiers.length >= 3) break;
        }

        console.log(
          `${logPrefix} Auto-closing found ${
            foundVerifiers.length
          } verifiers: ${foundVerifiers.join(", ")}`,
        );

        let closingContent = "";
        const isDisputed = allMessages.some((m) =>
          m.content.toLowerCase().includes("disputed"),
        );

        if (isDisputed && foundVerifiers.length === 0) {
          closingContent = "Disputed";
        } else {
          closingContent = foundVerifiers.join(", ");
        }

        closingMessage = {
          content: `CLOSING: ${closingContent}`,
          author: {
            id: client.user.id,
            displayName: client.user.username,
            tag: client.user.tag,
          },
          guild: channel.guild,
          member:
            channel.guild.members.cache.get(client.user.id) ||
            (await channel.guild.members
              .fetch(client.user.id)
              .catch(() => null)),
        };
        autoClosingGenerated = true;
      }

      if (closingMessage) {
        closingBlockFoundAndProcessed = true;
        let member = closingMessage.member;
        if (!member && !autoClosingGenerated) {
          try {
            member = await closingMessage.guild.members.fetch(
              closingMessage.author.id,
            );
          } catch (fetchError) {
            console.error(
              `${logPrefix} Could not fetch member for user ${closingMessage.author.id}.`,
              fetchError,
            );
          }
        }

        const closerId = closingMessage.author.id;
        closerUser =
          VERIFIER_ID_MAP[closerId] ||
          (member?.displayName ?? closingMessage.author.displayName);
        console.log(
          `${logPrefix} Processing 'CLOSING:' block by ${closerUser} (ID: ${closerId})`,
        );

        const lines = closingMessage.content.split("\n");
        const firstLineRaw = lines.shift() || "";
        const contentRaw = firstLineRaw.substring(8).trim();
        const contentLower = contentRaw.toLowerCase();

        if (blockTypes.includes(contentLower)) {
          typeColumn = capitalizeFirstLetter(contentLower);
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
          if (users.length > 3 && !autoClosingGenerated) {
            validationErrorMessages.push(
              `Error: "CLOSING:" line max 3 P/S/T users. Found: ${users.length}.`,
            );
          }
          primaryUser = users[0] || "";
          secondaryUser = users[1] || "";
          terciaryUser = users[2] || "";
        }

        if (!autoClosingGenerated) {
          const closingData = parseClosingBlock(lines);
          bonkedUsersData.primary = closingData.bonkedUsersData.primary;
          bonkedUsersData.secondary = closingData.bonkedUsersData.secondary;
          bonkedUsersData.tertiary = closingData.bonkedUsersData.tertiary;
          bonkedUsersData.btertiary = closingData.bonkedUsersData.btertiary;
          bonkersInMessageText.push(...closingData.bonkersList);

          if (closingData.manualLink) {
            ooLink = closingData.manualLink;
          }
          if (closingData.manualType) {
            typeColumn = closingData.manualType;
          }
          if (closingData.alertoorUser) {
            disputeAlertoor = closingData.alertoorUser;
          }
        }
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
          "; ",
        )}.`,
      );
      let errReply = `Error(s) in CLOSING block (data not saved):\n- ${validationErrorMessages.join(
        "\n- ",
      )}`;
      if (botConfig.errorNotificationUserID)
        errReply += ` <@${botConfig.errorNotificationUserID}>`;
      errReply += "\n\nPlease correct and re-run or wait for scan.";
      await channel.send(errReply);
      return { success: false, reason: "validation_error_in_closing_block" };
    }
    /*
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
    }*/

    const rowData = {
      [ORDER_COLUMN_HEADER]: orderColumnValue,
      [PROPOSAL_COLUMN_HEADER]: proposalNumber,
      "Type (PM / Snap, etc)": typeColumn,
      "OO Link": ooLink,
      Primary: primaryUser,
      Secondary: secondaryUser,
      Tertiary: terciaryUser,
      "fully-verified (3)": "",
      "Complete in liveness (y/n)": "",
      "Disputed? (y?)": disputedColumn,
      "fully verified (y/n)": "",
      "KPI hit? (y/n)": "",
      "dispute alertoor": disputeAlertoor,
      "proposal findoor": "", //Proposal findoor is empty here,
      "bonker 1": bonkersInMessageText[0] || "",
      "bonker 2": bonkersInMessageText[1] || "",
      "bonker 3": bonkersInMessageText[2] || "",
      "bonker 4": bonkersInMessageText[3] || "",
      "bonker 5": bonkersInMessageText[4] || "",
      "bonker 6": bonkersInMessageText[5] || "",
      "bonker 7": bonkersInMessageText[6] || "",
      "bonker 8": bonkersInMessageText[7] || "",
      "bonker 9": bonkersInMessageText[8] || "",
      "bonker 10": bonkersInMessageText[9] || "",
      "bonker 11": bonkersInMessageText.slice(10).join(", ") || "",
      "Paid?": botConfig.autoSetPaidToN ? "N" : "",
      "BONKED 1": Array.from(bonkedUsersData.primary).join(", ") || "",
      "BONKED 2": Array.from(bonkedUsersData.secondary).join(", ") || "",
      "BONKED 3": Array.from(bonkedUsersData.tertiary).join(", ") || "",
      "BONKED 4": Array.from(bonkedUsersData.btertiary).join(", ") || "",
      Closer: closerUser,
      Recorder: recorderUser,
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
          `**BONKED:** P:[${
            Array.from(bonkedUsersData.primary).join(", ") || "N"
          }]`;
      }
      await channel.send(resp);
      if (botConfig.currentPostProcessingAction !== "none") {
        const cmd =
          botConfig.currentPostProcessingAction === "delete"
            ? TICKET_TOOL_DELETE_COMMAND_TEXT
            : TICKET_TOOL_CLOSE_COMMAND_TEXT;
        if (cmd) {
          try {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await channel.send(cmd);
            console.log(`${logPrefix} Sent: ${cmd}`);
          } catch (e) {
            console.error(`${logPrefix} Err sending post-processing cmd:`, e);
            await channel.send(
              "Saved, but failed to send post-processing cmd.",
            );
          }
        } else
          console.log(
            `${logPrefix} No post-processing cmd configured for action: ${botConfig.currentPostProcessingAction}.`,
          );
      }
      return { success: true, action: result.action };
    } else {
      console.error(
        `${logPrefix} Failed to save/update sheet. Message: ${
          result.message || "Unknown"
        }`,
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
  recordType = "standard",
) {
  const logPrefix = `[Thread: ${threadChannel.name} (${threadChannel.id})]`;
  console.log(
    `${logPrefix} Starting processing. Initiated by: ${initiatedByDisplayName}, Type: ${recordType}`,
  );

  let date = "",
    ooLink = "",
    primaryUser = "",
    secondaryUser = "",
    terciaryUser = "",
    typeColumn = capitalizeFirstLetter(blockTypes[0]),
    closerUser = "",
    disputedColumn = "";

  const recorderUser = initiatedByDisplayName;
  const findoorUsers = new Set();
  const bonkersInMessageText = [];
  const bonkedUsersData = {
    primary: new Set(),
    secondary: new Set(),
    tertiary: new Set(),
    btertiary: new Set(),
  };
  let validationErrorMessages = [];

  const starterMessage = await threadChannel
    .fetchStarterMessage()
    .catch(() => null);
  let proposalNameForSheet = threadChannel.name; // Fallback

  if (starterMessage && starterMessage.content) {
    const linkPosition = starterMessage.content.lastIndexOf(
      "https://discord.com/channels/",
    );
    if (linkPosition !== -1) {
      proposalNameForSheet = starterMessage.content
        .substring(0, linkPosition)
        .trim();
    } else {
      proposalNameForSheet = starterMessage.content.trim();
    }
  }
  console.log(
    `${logPrefix} Identified Proposal Name for Sheet: "${proposalNameForSheet}"`,
  );

  const orderColumnValue = proposalNameForSheet;

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
    if (starterMessage) {
      ooLink = findValidLinkIn(starterMessage.content);
      if (!ooLink && starterMessage.embeds.length > 0) {
        for (const embed of starterMessage.embeds) {
          let foundLink =
            findValidLinkIn(embed.url) || findValidLinkIn(embed.description);
          if (foundLink) {
            ooLink = foundLink;
            break;
          }
        }
      }
    }

    if (!ooLink) {
      const referenceLinkMatch = starterMessage.content.match(
        /https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/,
      );
      if (referenceLinkMatch) {
        const [, linkedChannelId, linkedMessageId] = referenceLinkMatch;
        try {
          const linkedChannel = await client.channels.fetch(linkedChannelId);
          if (linkedChannel && linkedChannel.isTextBased()) {
            const feedMessage =
              await linkedChannel.messages.fetch(linkedMessageId);
            let foundLinkInReferenced = findValidLinkIn(feedMessage.content);
            if (!foundLinkInReferenced && feedMessage.embeds.length > 0) {
              for (const embed of feedMessage.embeds) {
                let foundLinkInEmbed =
                  findValidLinkIn(embed.url) ||
                  findValidLinkIn(embed.description);
                if (foundLinkInEmbed) {
                  foundLinkInReferenced = foundLinkInEmbed;
                  break;
                }
              }
            }
            if (foundLinkInReferenced) {
              ooLink = foundLinkInReferenced;
            }
          }
        } catch (err) {
          console.error(
            `${logPrefix} Error fetching referenced message for link:`,
            err,
          );
        }
      }
    }

    const fetchPromise = threadChannel.messages.fetch({ limit: 100 });
    const threadMessagesCollection = await withTimeout(fetchPromise, 15000); 

    let bonkFound = false;
    let manualClosingMessage = null;
    let botFlagFound = false;

    for (const msg of threadMessagesCollection.values()) {
      const lowerContent = msg.content.toLowerCase();

      if (
        lowerContent.startsWith("flag:") &&
        msg.author.id !== client.user.id
      ) {
        console.log(
          `${logPrefix} Found manual "Flag:" during automatic scan. Aborting.`,
        );
        return {
          success: false,
          reason: "manual_flag_found_on_scan",
          status: "flagged",
        };
      }

      if (
        lowerContent.startsWith("thread data for") &&
        initiatedByDisplayName !== "Forced Reprocess by Admin"
      ) {
        return { success: false, reason: "already_processed" };
      }

      // if (
      //   lowerContent.startsWith("thread data for")
      // ) {
      //   console.log(
      //     `${logPrefix} Found previous processing summary. Aborting.`
      //   );
      //   return { success: false, reason: "already_processed" };
      // }

      if (
        lowerContent.startsWith("flag:") &&
        msg.author.id === client.user.id
      ) {
        botFlagFound = true;
      }

      if (/\bbonk\b/.test(lowerContent)) {
        bonkFound = true;
        // --- LOG DE DEPURACIÓN (mantenlo por si acaso) ---
        console.log(
          `[DEBUG - BONK DETECTED] Thread: ${threadChannel.name} | Message ID: ${msg.id} | Author: ${msg.author.tag} | Content: "${msg.content.substring(0, 100).replace(/\n/g, " ")}..."`,
        );
      }

      if (!manualClosingMessage && lowerContent.startsWith("closing:")) {
        manualClosingMessage = msg;
      }
    }

    let closingMessage = null;

    if (blockTypes.includes(recordType)) {
      primaryUser = "";
      secondaryUser = "";
      terciaryUser = "";
      closerUser = recorderUser;

      if (recordType === "assertion") typeColumn = "Assertion";
      else if (recordType === "disputed") {
        typeColumn = "Disputed";
        disputedColumn = "y";
      } else if (recordType === "snapshot") typeColumn = "Snapshot";
      else if (recordType === "polymarket") typeColumn = "Polymarket";
      console.log(`${logPrefix} Processing as ${typeColumn} (manual command).`);
    } else {
      closingMessage = manualClosingMessage;
      let autoClosingGenerated = false;

      if (!closingMessage) {
        if (bonkFound) {
          if (!botFlagFound) {
            console.log(
              `${logPrefix} 'Bonk' found and no manual CLOSING. Flagging.`,
            );
            let flagMsg = `Flag: "CLOSING:" message not found. Manual review needed.`;
            if (botConfig.errorNotificationUserID)
              flagMsg += ` <@${botConfig.errorNotificationUserID}>`;
            await threadChannel.send(flagMsg);
          } else {
            console.log(
              `${logPrefix} 'Bonk' found, no CLOSING, but bot flag already exists. Skipping.`,
            );
          }
          return {
            success: false,
            reason: "no_closing_message_bonk_found",
            status: "flagged",
          };
        }

        console.log(`${logPrefix} No manual CLOSING. Attempting auto-closing.`);

        const allMessages = Array.from(
          threadMessagesCollection.values(),
        ).reverse(); // Chronological

        const foundVerifiers = [];
        const foundVerifierIds = new Set();
        for (const msg of allMessages) {
          if (!msg.content.toLowerCase().startsWith("verification")) continue;
          if (msg.author.bot && !KNOWN_VERIFIER_BOT_IDS.includes(msg.author.id))
            continue;

          if (foundVerifierIds.has(msg.author.id)) continue; // Evitar duplicados

          // --- CORRECCIÓN CLAVE: Lógica de Fallback ---
          let verifierName = VERIFIER_ID_MAP[msg.author.id];
          if (!verifierName) {
            // No está en el mapa, usamos el displayName como fallback
            const member =
              msg.member ||
              (await threadChannel.guild.members
                .fetch(msg.author.id)
                .catch(() => null));
            verifierName = member?.displayName ?? msg.author.displayName;
            console.log(
              `${logPrefix} Verifier ID ${msg.author.id} not in map. Using fallback name: ${verifierName}`,
            );
          }

          foundVerifiers.push(verifierName);
          foundVerifierIds.add(msg.author.id);

          if (foundVerifiers.length >= 3) break;
        }

        console.log(
          `${logPrefix} Auto-closing found ${
            foundVerifiers.length
          } verifiers: ${foundVerifiers.join(", ")}`,
        );

        let closingContent = "";
        const isDisputed = allMessages.some((m) =>
          m.content.toLowerCase().includes("disputed"),
        );

        if (isDisputed && foundVerifiers.length === 0) {
          closingContent = "Disputed";
        } else {
          closingContent = foundVerifiers.join(", ");
        }

        closingMessage = {
          content: `CLOSING: ${closingContent}`,
          author: {
            id: client.user.id,
            displayName: client.user.username,
            tag: client.user.tag,
          },
          guild: threadChannel.guild,
          member:
            threadChannel.guild.members.cache.get(client.user.id) ||
            (await threadChannel.guild.members
              .fetch(client.user.id)
              .catch(() => null)),
        };
        autoClosingGenerated = true;
      }

      if (closingMessage) {
        let member = closingMessage.member;
        if (!member && !autoClosingGenerated) {
          try {
            member = await closingMessage.guild.members.fetch(
              closingMessage.author.id,
            );
          } catch (fetchError) {
            console.error(
              `${logPrefix} Could not fetch member for user ${closingMessage.author.id}.`,
              fetchError,
            );
          }
        }

        const closerId = closingMessage.author.id;
        closerUser =
          VERIFIER_ID_MAP[closerId] ||
          (member?.displayName ?? closingMessage.author.displayName);
        console.log(
          `${logPrefix} Processing 'CLOSING:' block by ${closerUser} (ID: ${closerId})`,
        );

        const messageContentLines = closingMessage.content.split("\n");
        const firstLineRaw = messageContentLines.shift() || "";
        const closingLineContentRaw = firstLineRaw.startsWith("CLOSING:")
          ? firstLineRaw.substring(8).trim()
          : "";
        const closingLineContentLower = closingLineContentRaw.toLowerCase();

        if (blockTypes.includes(closingLineContentLower)) {
          typeColumn = capitalizeFirstLetter(closingLineContentLower);
          if (closingLineContentLower === "disputed") disputedColumn = "y";
        } else {
          const usersRaw = closingLineContentRaw
            ? closingLineContentRaw
                .split(/[.,]/)
                .map((n) => n.trim())
                .filter(Boolean)
            : [];
          if (usersRaw.length > 3 && !autoClosingGenerated) {
            validationErrorMessages.push(
              `Error: "CLOSING:" line max 3 P/S/T users. Found: ${usersRaw.length}.`,
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

        if (!autoClosingGenerated) {
          const closingData = parseClosingBlock(messageContentLines);
          bonkedUsersData.primary = closingData.bonkedUsersData.primary;
          bonkedUsersData.secondary = closingData.bonkedUsersData.secondary;
          bonkedUsersData.tertiary = closingData.bonkedUsersData.tertiary;
          bonkedUsersData.btertiary = closingData.bonkedUsersData.btertiary;
          bonkersInMessageText.push(...closingData.bonkersList);
          if (closingData.manualLink) ooLink = closingData.manualLink;
          if (closingData.manualType) typeColumn = closingData.manualType;
          if (closingData.alertoorUser)
            disputedColumn = `y (Alertoor: ${closingData.alertoorUser})`;
          if (closingData.manualFindoor)
            findoorUsers.add(closingData.manualFindoor);
        }
      }
    }

    if (ooLink === "") {
      console.log(`${logPrefix} OO Link NOT FOUND. Flagging.`);
      let flagMessage = `Flag: OO Link not found. Manual review needed.`;
      if (botConfig.errorNotificationUserID)
        flagMessage += ` <@${botConfig.errorNotificationUserID}>`;
      await threadChannel.send(flagMessage);
      return {
        success: false,
        reason: "oo_link_not_found_and_flagged",
        status: "flagged",
      };
    }

    if (validationErrorMessages.length > 0) {
      console.error(
        `${logPrefix} Validation errors: ${validationErrorMessages.join("; ")}.`,
      );
      let errReply = `Error(s) found (data not saved):\n- ${validationErrorMessages.join(
        "\n- ",
      )}`;
      if (botConfig.errorNotificationUserID)
        errReply += ` <@${botConfig.errorNotificationUserID}>`;
      errReply += "\n\nPlease correct and re-run `!recordt`.";
      await threadChannel.send(errReply);
      return {
        success: false,
        reason: "validation_error_in_closing_block",
        status: "flagged",
      };
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
      "BONKED 4": Array.from(bonkedUsersData.btertiary).join(", ") || "",
      "Type (PM / Snap, etc)": typeColumn,
      "Paid?": botConfig.autoSetPaidToN ? "N" : "",
    };

    if (!googleDoc) {
      console.error(`${logPrefix} Sheets not configured.`);
      await threadChannel.send("Error: Google Sheets not configured.");
      return { success: false, reason: "sheets_not_configured" };
    }

    const result = await upsertRowByOoLink(ooLink, rowData);

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
          `**BONKED:** P:[${
            Array.from(bonkedUsersData.primary).join(", ") || "N"
          }]`;
      }
      await threadChannel.send(resp);
      return { success: true, action: result.action, status: "processed" };
    } else {
      console.error(
        `${logPrefix} Failed to save/update sheet. Message: ${
          result.message || "Unknown"
        }`,
      );
      let errSave = `Error: Issue saving/updating sheet for "${proposalNameForSheet}".`;
      if (botConfig.errorNotificationUserID)
        errSave += ` <@${botConfig.errorNotificationUserID}>`;
      await threadChannel.send(errSave);
      return {
        success: false,
        reason: result.reason || result.action || "sheets_upsert_error",
        status: "flagged",
      };
    }
  } catch (error) {
    console.error(`${logPrefix} Major processing error:`, error);
    let majErr = `Error: Major processing error for "${proposalNameForSheet}". Check logs.`;
    if (botConfig.errorNotificationUserID)
      majErr += ` <@${botConfig.errorNotificationUserID}>`;

    try {
      await threadChannel.send(majErr);
    } catch (sendError) {
      console.error(
        `${logPrefix} CRITICAL: Could not even send error message to thread. Error: ${sendError.message}`,
      );
    }

    return { success: false, reason: "unknown_error", status: "flagged" };
  }
}

async function performMassScan() {
  if (!botConfig.autoProcessingEnabled) {
    console.log(
      `[${new Date().toISOString()}] Auto-processing is disabled. Scan skipped.`,
    );
    scheduleNextScan();
    return;
  }
  if (isMassScanInProgress) {
    console.log(
      `[${new Date().toISOString()}] Mass scan already in progress. Skipping this cycle.`,
    );
    return;
  }

  isMassScanInProgress = true;
  console.log(
    `[${new Date().toISOString()}] Starting scheduled mass ticket scan... Lock acquired.`,
  );

  try {
    const guild = client.guilds.cache.first();
    if (!guild) {
      console.log(
        `[${new Date().toISOString()}] Bot is not in a guild. Scan aborted.`,
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
        } eligible ticket(s) for processing.`,
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
            `Cron: Channel ${channel.name} is already in processing set, skipping this iteration.`,
          );
          continue;
        }

        console.log(
          `[${new Date().toISOString()}] Attempting to process: ${
            channel.name
          } (${i + 1} of ${channelsToProcess.length}).`,
        );
        currentlyProcessingChannels.add(channel.id);
        let processingResult;
        try {
          processingResult = await processTicketChannel(
            channel,
            "Automatic Scan",
            "standard",
          );
        } catch (e) {
          console.error(
            `[${new Date().toISOString()}] Uncaught error processing channel ${
              channel.name
            } in mass scan:`,
            e,
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
            }. Removed from processing set.`,
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
              `Cron: Ticket ${channel.name} resulted in a skip/flag (${processingResult.reason}). Short delay.`,
            );
            await new Promise((r) => setTimeout(r, 500));
          } else {
            console.log(
              `Cron: Staggering for ${
                DELAY_BETWEEN_TICKET_PROCESSING_MS / 1000
              }s before next ticket.`,
            );
            await new Promise((r) =>
              setTimeout(r, DELAY_BETWEEN_TICKET_PROCESSING_MS),
            );
          }
        }
      }
    } else {
      console.log(
        `[${new Date().toISOString()}] No eligible tickets found in this scan cycle.`,
      );
    }
  } catch (scanError) {
    console.error(
      `[${new Date().toISOString()}] Major error during mass scan execution:`,
      scanError,
    );
  } finally {
    botConfig.lastSuccessfulScanTimestamp = Date.now();
    await saveConfig(false);
    isMassScanInProgress = false;
    console.log(
      `[${new Date().toISOString()}] Mass scan finished. Lock released.`,
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
      "Auto-processing disabled, not scheduling next scan via setTimeout.",
    );
    return;
  }
  scanTimeoutId = setTimeout(performMassScan, botConfig.processingIntervalMs);
  console.log(
    `Next mass ticket scan scheduled in ~${Math.round(
      botConfig.processingIntervalMs / 60000,
    )} minutes.`,
  );
}

client.on("messageCreate", async (message) => {
  if (message.channel.id === OO_LIVE_FEED_CHANNEL_ID && message.author.bot) {
    const logPrefix = `[Supervisor][oo-live-feed]`;

    let marketLink = null;
    let fullTextContent = message.content;

    if (message.embeds && message.embeds.length > 0) {
      const embed = message.embeds[0];
      if (embed.description) {
        fullTextContent += " " + embed.description;
        marketLink = findValidLinkIn(embed.description);
      }
      if (!marketLink && embed.url) {
        marketLink = findValidLinkIn(embed.url);
      }
    }

    if (!marketLink) {
      marketLink = findValidLinkIn(message.content);
    }

    if (marketLink) {
      const transactionHashMatch = marketLink.match(/transactionHash=([^&]+)/);
      const eventIndexMatch = marketLink.match(/eventIndex=(\d+)/);
      const titleMatch = fullTextContent.match(
        /q:\s*title:\s*(.*?)(?=\s*,\s*description:)/,
      );

      if (
        transactionHashMatch?.[1] &&
        eventIndexMatch?.[1] &&
        titleMatch?.[1]
      ) {
        const transactionHash = transactionHashMatch[1];
        const eventIndex = eventIndexMatch[1];

        const uniqueId = `${transactionHash}-${eventIndex}`;
        const marketTitle = titleMatch[1].trim();

        let alreadyVerifiedByOTB = false;

        if (otbVerifiedCache.has(uniqueId)) {
          alreadyVerifiedByOTB = true;
          otbVerifiedCache.delete(uniqueId);
        } else {
          for (const [key, item] of otbVerifiedCache.entries()) {
            if (item.title === marketTitle && !item.uniqueId) {
              alreadyVerifiedByOTB = true;
              otbVerifiedCache.delete(key);
              break;
            }
          }
        }

        if (alreadyVerifiedByOTB) {
          console.log(
            `${logPrefix} Ignoring market "${marketTitle}" as it was already handled by OTBV2.`,
          );
          return;
        }

        const existingItem = fallbackQueue.find(
          (item) => item.uniqueId === uniqueId,
        );
        if (existingItem) {
          console.log(
            `${logPrefix} Item with ID ${uniqueId} already in queue. Ignoring.`,
          );
          return;
        }

        console.log(
          `${logPrefix} Detected new market. Adding "${marketTitle}" with ID "${uniqueId}" to fallback queue.`,
        );

        fallbackQueue.push({
          uniqueId: uniqueId,
          messageLink: message.url,
          title: marketTitle,
          timestamp: Date.now(),
        });

        console.log(
          `[Supervisor] Fallback queue size is now: ${fallbackQueue.length}`,
        );
      } else {
        console.log(`${logPrefix} Could not extract full data.
              - Hash found: ${transactionHashMatch?.[1] ? "Yes" : "No"}
              - Index found: ${eventIndexMatch?.[1] ? "Yes" : "No"}
              - Title match found: ${titleMatch?.[1] ? "Yes" : "No"}`);
      }
    }
    return;
  }

  if (
    message.channel.id === OTB_VERIFICATIONS_CHANNEL_ID &&
    message.author.id === OTB_BOT_USER_ID
  ) {
    const logPrefix = `[Supervisor][OTBV2]`;
    console.log(`${logPrefix} Detected a new message from OTB Bot.`);

    const messageContent = message.content;
    let uniqueId = null;
    let marketTitle = null;

    const ooLink = findValidLinkIn(messageContent);
    if (ooLink) {
      const txHashMatch = ooLink.match(/transactionHash=([^&]+)/);
      const eventIndexMatch = ooLink.match(/eventIndex=(\d+)/);
      if (txHashMatch?.[1] && eventIndexMatch?.[1]) {
        uniqueId = `${txHashMatch[1]}-${eventIndexMatch[1]}`;
      }
    }
    if (!uniqueId) {
      const txHashMatch = messageContent.match(
        /transactionHash=?(0x[a-fA-F0-9]{64})/,
      );
      const eventIndexMatch = messageContent.match(/eventIndex=(\d+)/);
      if (txHashMatch?.[1] && eventIndexMatch?.[1]) {
        uniqueId = `${txHashMatch[1]}-${eventIndexMatch[1]}`;
      }
    }

    const titleMatch = messageContent.match(/q:\s*title:\s*([^,]+)/);
    if (titleMatch?.[1]) {
      marketTitle = titleMatch[1].trim();
    }

    let foundInQueue = false;
    if (uniqueId) {
      const indexToRemove = fallbackQueue.findIndex(
        (item) => item.uniqueId === uniqueId,
      );
      if (indexToRemove > -1) {
        const removedItem = fallbackQueue.splice(indexToRemove, 1)[0];
        console.log(
          `${logPrefix} SUCCESS (by ID): Removed "${removedItem.title}" from fallbackQueue.`,
        );
        console.log(
          `[Supervisor] ${fallbackQueue.length} items remaining in fallback queue.`,
        );
        foundInQueue = true;
      }
    }
    if (!foundInQueue && marketTitle) {
      const indexToRemove = fallbackQueue.findIndex(
        (item) => item.title === marketTitle,
      );
      if (indexToRemove > -1) {
        const removedItem = fallbackQueue.splice(indexToRemove, 1)[0];
        console.log(
          `${logPrefix} SUCCESS (by Title): Removed "${removedItem.title}" from fallbackQueue.`,
        );
        console.log(
          `[Supervisor] ${fallbackQueue.length} items remaining in fallback queue.`,
        );
        foundInQueue = true;
      }
    }

    if (!foundInQueue) {
      if (uniqueId || marketTitle) {
        const identifier = marketTitle
          ? `Market "${marketTitle}"`
          : `Market with ID "${uniqueId}"`;
        console.log(
          `${logPrefix} ${identifier} not in fallbackQueue. Adding to OTB cache.`,
        );

        const cacheKey = uniqueId || marketTitle;
        otbVerifiedCache.set(cacheKey, {
          uniqueId: uniqueId,
          title: marketTitle,
          timestamp: Date.now(),
        });
      } else {
        console.log(
          `${logPrefix} FAILED: Could not extract any identifier (ID or Title) from the OTB message.`,
        );
      }
    }
    return;
  }

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
        "Error: !record is just for using on tickets... Use !recordt instead",
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
      `Processing ${message.channel.name} as ${recordType}...`,
    );
    await processTicketChannel(message.channel, initiatedByString, recordType);
  } else if (commandName === "recordt") {
    if (!message.channel.isThread()) {
      await message.reply(
        "Error: !recordt is just for using on threads... Use !record instead",
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

    let actualThreadName = message.channel.name;
    try {
      const starterMessage = await message.channel.fetchStarterMessage();
      if (starterMessage && starterMessage.content) {
        const linkPosition = starterMessage.content.lastIndexOf(
          "https://discord.com/channels/",
        );
        if (linkPosition !== -1) {
          actualThreadName = starterMessage.content
            .substring(0, linkPosition)
            .trim();
        }
      }
    } catch (e) {
      console.error(
        `[recordt] Could not fetch starter message to get real name for thread ${message.channel.id}`,
      );
    }

    const displayName = actualThreadName;

    const processingMessage = await message.reply(
      `Processing thread "${displayName}" as ${recordType}...`,
    );

    const result = await processThread(
      message.channel,
      message.member.displayName,
      recordType,
    );

    if (result) {
      if (result.success) {
      } else {
        if (result.reason === "already_processed") {
          await processingMessage.edit(
            `ℹ️ This thread has already been processed.`,
          );
        } else if (result.reason === "manual_flag_found") {
          await processingMessage.edit(
            `⛔ Processing stopped: A manual flag was found in this thread.`,
          );
        } else {
        }
      }
    }
  } else if (commandName === "processthreads") {
    if (message.author.id !== "907390293316337724") {
      return message.reply("⛔ This command is restricted to the bot owner.");
    }

    const dateString = args[0];
    const timeString = args[1];

    if (!dateString) {
      return message.reply(
        "Please provide a start date. \n**Format:** `!processthreads YYYY-MM-DD [HH:MM]` (time is optional, 24h format, UTC). \n**Example:** `!processthreads 2023-11-29 21:00`",
      );
    }

    let startTimestamp;
    try {
      const fullDateTimeString = timeString
        ? `${dateString}T${timeString}:00Z`
        : `${dateString}T00:00:00Z`;
      const startDate = new Date(fullDateTimeString);

      if (isNaN(startDate.getTime())) {
        throw new Error("Invalid date or time format.");
      }
      startTimestamp = startDate.getTime();

      const feedbackDate = timeString
        ? `${dateString} at ${timeString} UTC`
        : dateString;
      await message.reply(
        `Querying threads created on or after **${feedbackDate}**. Please wait...`,
      );
    } catch (e) {
      return message.reply(
        "Invalid date or time format. Please use `YYYY-MM-DD` and `HH:MM` (optional, 24h UTC).",
      );
    }

    try {
      if (isBacklogProcessRunning) {
        return message.reply(
          "⚠️ A backlog process is already running. Please wait for it to finish or use `!stopbacklog`.",
        );
      }

      isBacklogProcessRunning = true;

      const parentChannel = await client.channels.fetch(
        FAILED_TICKETS_FORUM_ID,
      );
      if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
        return message.channel.send(
          "Error: Could not find the configured text channel for threads.",
        );
      }

      let allThreads = [];
      let lastMessageId = null;
      let fetchMore = true;
      console.log(
        `[Backlog] Starting deep scan for threads newer than ${new Date(startTimestamp).toISOString()}`,
      );

      while (fetchMore) {
        const options = { limit: 100 };
        if (lastMessageId) {
          options.before = lastMessageId;
        }
        const messages = await parentChannel.messages.fetch(options);

        if (messages.size === 0) {
          fetchMore = false;
          break;
        }

        for (const msg of messages.values()) {
          if (msg.createdTimestamp < startTimestamp) {
            fetchMore = false;
            break;
          }
          if (msg.thread) {
            allThreads.push(msg.thread);
          }
        }

        if (fetchMore) {
          lastMessageId = messages.lastKey();
        }
      }

      console.log(
        `[Backlog] Deep scan complete. Found ${allThreads.length} potential threads.`,
      );

      if (allThreads.length === 0) {
        return message.channel.send(
          "No threads found created on or after the specified date and time.",
        );
      }

      allThreads.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      await message.channel.send(
        `Scan complete. Starting backlog process for **${allThreads.length}** threads. Each will be re-archived.`,
      );

      let processedCount = 0;
      let failedCount = 0;
      let flaggedCount = 0;

      for (let i = 0; i < allThreads.length; i++) {
        if (!isBacklogProcessRunning) {
          await message.channel.send("Process stopped by user.");
          break;
        }
        const thread = allThreads[i];
        const progress = `(${i + 1}/${allThreads.length})`;

        let shouldArchive = true;

        try {
          const fetchedThread = await client.channels
            .fetch(thread.id)
            .catch(() => null);
          if (!fetchedThread) {
            console.warn(
              `[Backlog] ${progress} Could not fetch thread ${thread.name}. It might have been deleted. Skipping.`,
            );
            continue;
          }

          const wasArchived = fetchedThread.archived;

          if (wasArchived) {
            await fetchedThread.setArchived(false);
          }

          const lastMessages = await fetchedThread.messages.fetch({
            limit: 10,
          });
          const isProcessed = lastMessages.some(
            (m) =>
              m.author.id === client.user.id &&
              m.content.toLowerCase().startsWith("thread data for"),
          );

          if (!isProcessed) {
            processedCount++;
            console.log(
              `[Backlog] ${progress} Processing thread: ${fetchedThread.name}`,
            );

            const processingResult = await processThread(
              fetchedThread,
              "Manual Backlog Process",
            );

            if (processingResult && processingResult.status === "flagged") {
              shouldArchive = false;
              flaggedCount++;
              console.log(
                `[Backlog] ${progress} Thread ${fetchedThread.name} was flagged for manual review. Leaving it active.`,
              );
            }

            await new Promise((r) =>
              setTimeout(r, DELAY_BETWEEN_TICKET_PROCESSING_MS),
            );
          } else {
            console.log(
              `[Backlog] ${progress} Skipping already processed thread: ${fetchedThread.name}`,
            );
          }

          if (shouldArchive && !fetchedThread.archived) {
            await fetchedThread.setArchived(true, "Backlog processing cleanup");
          }
        } catch (err) {
          failedCount++;
          if (
            err.message
              .toLowerCase()
              .includes("maximum number of active threads")
          ) {
            console.warn(
              `[Backlog] ${progress} Max active threads limit reached. Pausing for 30 seconds...`,
            );
            await message.channel.send(
              `⚠️ Max active threads limit reached. Pausing for 30 seconds to recover...`,
            );
            await new Promise((r) => setTimeout(r, 30000));
            i--;
            continue;
          }
          console.warn(
            `[Backlog] ${progress} Critical error on thread ${thread.name} (${thread.id}). Skipping. Error: ${err.message}`,
          );

          try {
            const errorThread = await client.channels
              .fetch(thread.id)
              .catch(() => null);
            if (errorThread && !errorThread.archived) {
              await errorThread.setArchived(true, "Archiving after error");
            }
          } catch (archiveErr) {}
        }
      }

      await message.channel.send(
        `✅ Backlog processing complete! \n- Processed: **${processedCount}** new threads. \n- Flagged for review: **${flaggedCount}** (left active). \n- Skipped/Failed: **${failedCount}**.`,
      );
    } catch (error) {
      console.error(
        "[Backlog] Major error during thread backlog processing:",
        error,
      );
      await message.channel.send(
        "A critical error occurred during the backlog process. Check the logs.",
      );
    } finally {
        isBacklogProcessRunning = false;
    }
  } else if (commandName === "forcereprocess") {
    if (message.author.id !== "907390293316337724") {
      return message.reply("⛔ This command is restricted to the bot owner.");
    }

    const dateString = args[0];
    const timeString = args[1];

    if (!dateString) {
      return message.reply(
        "Please provide a start date. \n**Format:** `!forcereprocess YYYY-MM-DD [HH:MM]` (time is optional, 24h format, UTC). \n**Example:** `!forcereprocess 2023-12-06 14:30`",
      );
    }

    let startTimestamp;
    try {
      const fullDateTimeString = timeString
        ? `${dateString}T${timeString}:00Z`
        : `${dateString}T00:00:00Z`;
      const startDate = new Date(fullDateTimeString);
      if (isNaN(startDate.getTime())) {
        throw new Error("Invalid date or time format.");
      }
      startTimestamp = startDate.getTime();
    } catch (e) {
      return message.reply(
        "Invalid date or time format. Please use `YYYY-MM-DD` and `HH:MM` (optional, 24h UTC).",
      );
    }

    const feedbackDate = timeString
      ? `${dateString} at ${timeString} UTC`
      : dateString;

    const confirmation = await message.reply(
      `⚠️ **WARNING:** This command will re-process ALL threads created on or after **${feedbackDate}**. It will re-archive each thread. This can take a very long time. Are you sure? Type \`YES\` to confirm.`,
    );

    const filter = (m) =>
      m.author.id === message.author.id && m.content.toUpperCase() === "YES";
    try {
      await message.channel.awaitMessages({
        filter,
        max: 1,
        time: 15000,
        errors: ["time"],
      });
    } catch (e) {
      return confirmation.edit(
        "Confirmation timed out. Reprocessing cancelled.",
      );
    }

    await confirmation.edit(
      `Confirmed. Starting FORCE REPROCESSING for threads since **${feedbackDate}**. Each thread will be re-archived.`,
    );

    try {
      if (isBacklogProcessRunning) {
            return message.reply("⚠️ A backlog process is already running. Please wait for it to finish or use `!stopbacklog`.");
        }
      
      isBacklogProcessRunning = true;
      
      const parentChannel = await client.channels.fetch(
        FAILED_TICKETS_FORUM_ID,
      );
      if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
        return message.channel.send(
          "Error: Could not find the configured text channel.",
        );
      }

      let allThreads = [];
      let lastMessageId = null;
      let fetchMore = true;
      while (fetchMore) {
        const options = { limit: 100 };
        if (lastMessageId) options.before = lastMessageId;
        const messages = await parentChannel.messages.fetch(options);
        if (messages.size === 0) {
          fetchMore = false;
          break;
        }
        for (const msg of messages.values()) {
          if (msg.createdTimestamp < startTimestamp) {
            fetchMore = false;
            break;
          }
          if (msg.thread) allThreads.push(msg.thread);
        }
        if (fetchMore) lastMessageId = messages.lastKey();
      }

      if (allThreads.length === 0) {
        return message.channel.send(
          "No threads found to re-process after the specified date and time.",
        );
      }

      allThreads.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      await message.channel.send(
        `Found **${allThreads.length}** threads to force-reprocess. This will take approximately ${((allThreads.length * (DELAY_BETWEEN_TICKET_PROCESSING_MS + 2000)) / 60000).toFixed(1)} minutes.`,
      );

      for (let i = 0; i < allThreads.length; i++) {
        if (!isBacklogProcessRunning) {
          await message.channel.send("Force reprocess stopped by user.");
          break; 
        }
        const thread = allThreads[i];
        const progress = `(${i + 1}/${allThreads.length})`;

        try {
          const fetchedThread = await client.channels.fetch(thread.id);

          console.log(
            `[Force Reprocess] ${progress} Processing thread: ${fetchedThread.name}`,
          );

          await processThread(fetchedThread, "Forced Reprocess by Admin");

          if (fetchedThread && !fetchedThread.archived) {
            await fetchedThread.setArchived(true, "Forced re-process cleanup");
          }

          await new Promise((r) =>
            setTimeout(r, DELAY_BETWEEN_TICKET_PROCESSING_MS),
          );
        } catch (err) {
          console.warn(
            `[Force Reprocess] ${progress} Failed to re-process thread ${thread.name}. Error: ${err.message}`,
          );
          try {
            const errorThread = await client.channels
              .fetch(thread.id)
              .catch(() => null);
            if (errorThread && !errorThread.archived) {
              await errorThread.setArchived(true, "Archiving after error");
            }
          } catch (archiveErr) {
            /* Ignorar */
          }
        }
      }

      await message.channel.send(
        "✅ **Force reprocessing complete!** The Google Sheet should now be corrected.",
      );
    } catch (error) {
      console.error(
        "[Force Reprocess] Major error during forced reprocessing:",
        error,
      );
      await message.channel.send(
        "A critical error occurred during the forced reprocessing. Check the logs.",
      );
    } finally {
        isBacklogProcessRunning = false;
    }
  } else if (commandName === "archiveallthreads") {
    if (message.author.id !== "907390293316337724") {
      return message.reply("⛔ This command is restricted to the bot owner.");
    }

    const dateString = args[0];
    const timeString = args[1];
    let startTimestamp = 0;

    if (dateString) {
      try {
        const fullDateTimeString = timeString
          ? `${dateString}T${timeString}:00Z`
          : `${dateString}T00:00:00Z`;
        const startDate = new Date(fullDateTimeString);
        if (isNaN(startDate.getTime()))
          throw new Error("Invalid date or time format.");
        startTimestamp = startDate.getTime();
      } catch (e) {
        return message.reply(
          "Invalid date/time format. Use `YYYY-MM-DD` and `HH:MM` (optional, 24h UTC).",
        );
      }
    }

    const feedbackDate = dateString
      ? timeString
        ? `created since ${dateString} at ${timeString} UTC`
        : `created since ${dateString}`
      : "in the channel";
    await message.reply(
      `Starting mass archival of active threads ${feedbackDate}. This may take a few minutes...`,
    );

    try {
      const parentChannel = await client.channels.fetch(
        FAILED_TICKETS_FORUM_ID,
      );
      if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
        return message.channel.send(
          "Error: Could not find the configured text channel for threads.",
        );
      }

      const activeThreadsCollection = await parentChannel.threads.fetchActive();

      const threadsToArchive = Array.from(
        activeThreadsCollection.threads.values(),
      ).filter((t) => t.createdTimestamp >= startTimestamp);

      if (threadsToArchive.length === 0) {
        return message.channel.send(
          `No active threads found ${feedbackDate} to archive.`,
        );
      }

      console.log(
        `[MassArchive] Found ${threadsToArchive.length} active threads to archive matching the time criteria.`,
      );
      await message.channel.send(
        `Found **${threadsToArchive.length}** active threads to archive. Starting process...`,
      );

      let archivedCount = 0;
      for (let i = 0; i < threadsToArchive.length; i++) {
        const thread = threadsToArchive[i];
        const progress = `(${i + 1}/${threadsToArchive.length})`;

        // --- LÓGICA CORREGIDA ---
        try {
          // Simplemente intentamos archivar. No preguntamos primero.
          await thread.setArchived(true);
          archivedCount++;
          console.log(
            `[MassArchive] ${progress} Successfully archived thread: ${thread.name}`,
          );
        } catch (archiveError) {
          // Si falla, el log nos dirá exactamente por qué.
          console.warn(
            `[MassArchive] ${progress} Could not archive thread ${thread.name}. Reason: ${archiveError.message}`,
          );
        }

        // Mantenemos la pausa para no saturar la API
        await new Promise((r) => setTimeout(r, 750));
      }

      await message.channel.send(
        `✅ Mass archival complete! Successfully archived **${archivedCount}** threads.`,
      );
    } catch (error) {
      console.error("[MassArchive] Major error during mass archival:", error);
      await message.channel.send(
        "A critical error occurred during the mass archival process. Check the logs.",
      );
    }
  } else if (commandName === "unarchive") {
    // --- RESTRICCIÓN DE ACCESO ---
    if (message.author.id !== "907390293316337724") {
      return message.reply("⛔ This command is restricted to the bot owner.");
    }

    const dateString = args[0];
    const timeString = args[1];

    if (!dateString) {
      return message.reply(
        "Please provide a start date. \n**Format:** `!unarchive YYYY-MM-DD [HH:MM]` (time is optional, 24h format, UTC). \n**Example:** `!unarchive 2023-12-19 14:00`",
      );
    }

    let startTimestamp;
    try {
      const fullDateTimeString = timeString
        ? `${dateString}T${timeString}:00Z`
        : `${dateString}T00:00:00Z`;
      const startDate = new Date(fullDateTimeString);
      if (isNaN(startDate.getTime())) {
        throw new Error("Invalid date");
      }
      startTimestamp = startDate.getTime();
    } catch (e) {
      return message.reply("Invalid date/time format.");
    }

    const feedbackDate = timeString
      ? `${dateString} at ${timeString} UTC`
      : dateString;
    await message.reply(
      `Searching for archived threads created since **${feedbackDate}** to unarchive. Please wait...`,
    );

    try {
      const parentChannel = await client.channels.fetch(
        FAILED_TICKETS_FORUM_ID,
      );
      if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
        return message.channel.send(
          "Error: Could not find the configured text channel.",
        );
      }

      const archivedThreadsCollection =
        await parentChannel.threads.fetchArchived({ fetchAll: true });

      const threadsToUnarchive = Array.from(
        archivedThreadsCollection.threads.values(),
      ).filter((t) => t.createdTimestamp >= startTimestamp);

      if (threadsToUnarchive.length === 0) {
        return message.channel.send(
          `No archived threads found matching the criteria since ${feedbackDate}.`,
        );
      }

      await message.channel.send(
        `Found **${threadsToUnarchive.length}** archived threads to restore. Starting now...`,
      );

      let unarchivedCount = 0;
      for (let i = 0; i < threadsToUnarchive.length; i++) {
        const thread = threadsToUnarchive[i];
        const progress = `(${i + 1}/${threadsToUnarchive.length})`;

        try {
          if (thread.archived) {
            await thread.setArchived(false);
            unarchivedCount++;
            console.log(
              `[Unarchive] ${progress} Successfully unarchived thread: ${thread.name}`,
            );
          }
        } catch (err) {
          console.warn(
            `[Unarchive] ${progress} Failed to unarchive thread ${thread.name}. Error: ${err.message}`,
          );
        }
        // Pausa para no saturar la API
        await new Promise((r) => setTimeout(r, 1000));
      }

      await message.channel.send(
        `✅ Unarchive process complete! Successfully restored **${unarchivedCount}** threads.`,
      );
    } catch (error) {
      console.error("[Unarchive] Major error during unarchive command:", error);
      await message.channel.send(
        "A critical error occurred during the unarchive process. Check the logs.",
      );
    }
  } else if (commandName === "findduplicates") {
    if (message.author.id !== "907390293316337724") {
      return message.reply("⛔ This command is restricted to the bot owner.");
    }

    await message.reply(
      "🔍 Starting scan for duplicate tickets... This may take a moment as I'm checking both sheets.",
    );

    try {
      await googleDoc.loadInfo();
      const findoorSheet = googleDoc.sheetsByTitle[WORKSHEET_TITLE_FINDOOR];
      const verificationsSheet = googleDoc.sheetsByTitle[WORKSHEET_TITLE_MAIN];

      if (!findoorSheet || !verificationsSheet) {
        return message.channel.send(
          "Error: Could not find the required worksheets ('Findoors' and 'Verifications').",
        );
      }

      // 1. Cargar todos los OO Links de los threads en un Set para una búsqueda rápida
      console.log("[Duplicates] Fetching all OO Links from Findoors sheet...");
      const findoorRows = await findoorSheet.getRows();
      const findoorLinks = new Set(
        findoorRows.map((row) => row.get("OO Link")).filter(Boolean),
      );
      console.log(
        `[Duplicates] Loaded ${findoorLinks.size} unique links from Findoors.`,
      );

      // 2. Revisar la hoja de Verifications y comparar
      console.log("[Duplicates] Scanning Verifications sheet for matches...");
      const verificationsRows = await verificationsSheet.getRows();
      const duplicatesFound = [];

      for (const row of verificationsRows) {
        const ticketLink = row.get("OO Link");
        const primaryValue = row.get("Primary");

        // Es un duplicado si el link está en la lista de threads Y no está ya marcado como "Duplicate"
        if (
          ticketLink &&
          findoorLinks.has(ticketLink) &&
          primaryValue &&
          primaryValue.toLowerCase() !== "duplicate"
        ) {
          duplicatesFound.push({
            order: row.get(ORDER_COLUMN_HEADER),
            link: ticketLink,
          });
        }
      }

      if (duplicatesFound.length === 0) {
        return message.channel.send(
          "✅ No unprocessed duplicate tickets were found.",
        );
      }

      // 3. Enviar los resultados en trozos para evitar el límite de caracteres de Discord
      let response = `**Found ${duplicatesFound.length} potential duplicate tickets to review:**\n`;
      for (let i = 0; i < duplicatesFound.length; i++) {
        const duplicate = duplicatesFound[i];
        const line = `Ticket Order #${duplicate.order}\n`;
        if (response.length + line.length > 1900) {
          await message.channel.send(response);
          response = "";
        }
        response += line;
      }
      await message.channel.send(response);
    } catch (error) {
      console.error("[Duplicates] Error during findduplicates command:", error);
      await message.channel.send(
        "An error occurred while scanning for duplicates. Check the logs.",
      );
    }
  } else if (commandName === "fixduplicates") {
    if (message.author.id !== "907390293316337724") {
      return message.reply("⛔ This command is restricted to the bot owner.");
    }

    if (args[0] !== "confirm") {
      return message.reply(
        "This is a destructive action. To proceed, run the command again with `confirm`.\n**Example:** `!fixduplicates confirm`",
      );
    }

    await message.reply(
      "⚙️ Starting automatic fix for duplicate tickets... This will modify the spreadsheet and may take some time.",
    );

    try {
      await googleDoc.loadInfo();
      const findoorSheet = googleDoc.sheetsByTitle[WORKSHEET_TITLE_FINDOOR];
      const verificationsSheet = googleDoc.sheetsByTitle[WORKSHEET_TITLE_MAIN];
      if (!findoorSheet || !verificationsSheet) {
        /* ... error handling ... */
      }

      console.log(
        "[FixDuplicates] Fetching all OO Links from Findoors sheet...",
      );
      const findoorRows = await findoorSheet.getRows();
      const findoorLinks = new Set(
        findoorRows.map((row) => row.get("OO Link")).filter(Boolean),
      );
      console.log(`[FixDuplicates] Loaded ${findoorLinks.size} unique links.`);

      console.log(
        "[FixDuplicates] Scanning Verifications sheet to find and update matches...",
      );
      const verificationsRows = await verificationsSheet.getRows();
      let updatedCount = 0;

      for (const row of verificationsRows) {
        const ticketLink = row.get("OO Link");
        const primaryValue = row.get("Primary");

        if (
          ticketLink &&
          findoorLinks.has(ticketLink) &&
          primaryValue &&
          primaryValue.toLowerCase() !== "duplicate"
        ) {
          console.log(
            `[FixDuplicates] Updating Order #${row.get(
              ORDER_COLUMN_HEADER,
            )} to "Duplicate".`,
          );
          row.set("Primary", "Duplicate");
          row.set("Secondary", "");
          row.set("Tertiary", "");
          row.set("bonker 1", "");
          row.set("bonker 2", "");
          row.set("bonker 3", "");
          row.set("bonker 4", "");
          row.set("bonker 5", "");
          row.set("bonker 6", "");
          row.set("bonker 7", "");
          row.set("bonker 8", "");
          row.set("bonker 9", "");
          row.set("bonker 10", "");
          row.set("bonker 11", "");
          row.set("BONKED 1", "");
          row.set("BONKED 2", "");
          row.set("BONKED 3", "");
          row.set("BONKED 4", "");

          await row.save(); // Guarda los cambios en la fila
          updatedCount++;

          // Pausa para no sobrecargar la API de Google Sheets
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      if (updatedCount > 0) {
        await message.channel.send(
          `✅ **Fix complete!** Successfully updated **${updatedCount}** duplicate ticket rows.`,
        );
      } else {
        await message.channel.send(
          "✅ No unprocessed duplicate tickets were found to fix.",
        );
      }
    } catch (error) {
      console.error(
        "[FixDuplicates] Error during fixduplicates command:",
        error,
      );
      await message.channel.send(
        "An error occurred while fixing duplicates. Check the logs. Some rows may have been updated.",
      );
    }
  } else if (commandName === "stopbacklog") {
    if (message.author.id !== "907390293316337724") {
      return message.reply("⛔ This command is restricted to the bot owner.");
    }

    if (isBacklogProcessRunning) {
      isBacklogProcessRunning = false;
      await message.reply(
        "🛑 Stop signal received. The current backlog process will stop after completing the current thread. Please wait a moment.",
      );
      console.log(
        `[Backlog] STOP signal received by ${message.author.tag}. Gracefully stopping.`,
      );
    } else {
      await message.reply("ℹ️ No backlog process is currently running.");
    }
  }
});

client.on("channelCreate", async (channel) => {
  if (channel.name.toLowerCase().startsWith("proposal-")) {
    lastTicketToolActivityTimestamp = Date.now();
    const logPrefix = `[Supervisor][${channel.name}]`;
    console.log(
      `${logPrefix} New proposal channel detected. Updated Ticket Tool activity timestamp. Checking for Ticket Tool message in 5s...`,
    );

    setTimeout(async () => {
      try {
        const messages = await channel.messages.fetch({ limit: 20 });
        let ticketToolMessage = null;

        for (const msg of messages.values()) {
          if (msg.author.id === TICKET_TOOL_USER_ID && msg.embeds.length > 0) {
            ticketToolMessage = msg;
            break;
          }
        }

        if (!ticketToolMessage) {
          console.log(
            `${logPrefix} WARNING: Ticket Tool message not found on first check. Adding to re-check list.`,
          );
          channelsToRecheck.add(channel.id);
          return;
        }

        console.log(`${logPrefix} Found Ticket Tool message.`);

        const embedContent = ticketToolMessage.embeds[0].description || "";
        const txHashMatch = embedContent.match(/transactionHash=([^&]+)/);
        const eventIndexMatch = embedContent.match(/eventIndex=(\d+)/);

        if (txHashMatch?.[1] && eventIndexMatch?.[1]) {
          const transactionHash = txHashMatch[1];
          const eventIndex = eventIndexMatch[1];
          const uniqueId = `${transactionHash}-${eventIndex}`;

          console.log(`${logPrefix} Hash: ${transactionHash}`);

          const indexToRemove = fallbackQueue.findIndex(
            (item) => item.uniqueId === uniqueId,
          );
          if (indexToRemove > -1) {
            const removedItem = fallbackQueue.splice(indexToRemove, 1)[0];
            console.log(
              `${logPrefix} SUCCESS: Removed "${removedItem.title}" (ID: ${uniqueId}) from fallback queue.`,
            );
            console.log(
              `[Supervisor] ${fallbackQueue.length} items remaining in fallback queue.`,
            );
            return;
          }

          if (createdFallbackThreads.has(uniqueId)) {
            console.log(
              `${logPrefix} DUPLICATE DETECTED: A fallback thread already exists for ID ${uniqueId}. Closing this ticket.`,
            );

            try {
              await channel.send("CLOSING: Duplicate");
            } catch (e) {
              console.error(`${logPrefix} Error closing duplicate ticket:`, e);
            }

            createdFallbackThreads.delete(uniqueId);
            return;
          }

          console.log(
            `${logPrefix} INFO: Found a unique ID (${uniqueId}), but it was not in the pending queue or fallback thread list.`,
          );
        } else {
          console.log(
            `${logPrefix} WARNING: Could not extract full ID from the Ticket Tool message.`,
          );
          channelsToRecheck.add(channel.id);
        }
      } catch (e) {
        console.error(
          `${logPrefix} Error fetching messages in new channel:`,
          e,
        );
        channelsToRecheck.add(channel.id);
      }
    }, 5 * 1000);
  }
});

async function processFallbackQueue() {
  if (createdFallbackThreads.size > 0) {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [uniqueId, timestamp] of createdFallbackThreads.entries()) {
      if (now - timestamp > FALLBACK_RECORD_EXPIRATION_MS) {
        createdFallbackThreads.delete(uniqueId);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(
        `[Supervisor] Cleaned up ${cleanedCount} expired fallback thread record(s).`,
      );
    }
  }

  if (otbVerifiedCache.size > 0) {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [key, item] of otbVerifiedCache.entries()) {
      if (now - item.timestamp > OTB_CACHE_EXPIRATION_MS) {
        otbVerifiedCache.delete(key);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(
        `[Supervisor] Cleaned up ${cleanedCount} expired OTB cache record(s).`,
      );
    }
  }

  if (
    isProcessingFallbackQueue ||
    (fallbackQueue.length === 0 && channelsToRecheck.size === 0)
  ) {
    return;
  }

  if (channelsToRecheck.size > 0) {
    console.log(
      `[Supervisor] Performing double check on ${channelsToRecheck.size} suspicious channels...`,
    );
    const recheckedIds = new Set(channelsToRecheck);

    for (const channelId of recheckedIds) {
      let foundAndCleared = false;
      try {
        const channel = await client.channels.fetch(channelId);
        const messages = await channel.messages.fetch({ limit: 100 });

        for (const msg of messages.values()) {
          if (msg.author.id === TICKET_TOOL_USER_ID && msg.embeds.length > 0) {
            const embedContent = msg.embeds[0].description || "";
            const txHashMatch = embedContent.match(/transactionHash=([^&]+)/);
            const eventIndexMatch = embedContent.match(/eventIndex=(\d+)/);

            if (txHashMatch?.[1] && eventIndexMatch?.[1]) {
              const uniqueId = `${txHashMatch[1]}-${eventIndexMatch[1]}`;
              const indexToRemove = fallbackQueue.findIndex(
                (item) => item.uniqueId === uniqueId,
              );
              if (indexToRemove > -1) {
                const removedItem = fallbackQueue.splice(indexToRemove, 1)[0];
                console.log(
                  `[Supervisor] DOUBLE CHECK SUCCESS: Cleared "${removedItem.title}" from queue via channel ${channel.name}.`,
                );
                foundAndCleared = true;
                break;
              }
            }
          }
        }

        if (!foundAndCleared) {
          console.log(
            `[Supervisor] DOUBLE CHECK NOTE: No matching pending item was found in the queue for channel with ID ${channelId}.`,
          );
        }
      } catch (error) {
        console.error(
          `[Supervisor] Error during double check for channel ID ${channelId}:`,
          error,
        );
      } finally {
        channelsToRecheck.delete(channelId);
      }
    }
  }

  const now = Date.now();
  const timeSinceLastTTActivity = now - lastTicketToolActivityTimestamp;

  if (timeSinceLastTTActivity > TICKET_TOOL_INACTIVITY_THRESHOLD_MS) {
    const itemsToProcess = fallbackQueue.filter(
      (item) => now - item.timestamp > MIN_AGE_FOR_FALLBACK_CHECK_MS,
    );

    if (itemsToProcess.length === 0) {
      return;
    }

    isProcessingFallbackQueue = true;
    console.log(
      `[Supervisor] Ticket Tool has been inactive for over ${
        TICKET_TOOL_INACTIVITY_THRESHOLD_MS / 60000
      } minutes.`,
    );
    console.log(
      `[Supervisor] Found ${itemsToProcess.length} items older than ${
        MIN_AGE_FOR_FALLBACK_CHECK_MS / 60000
      } minutes. Starting fallback creation...`,
    );

    const idsToProcess = new Set(itemsToProcess.map((item) => item.uniqueId));
    const newFallbackQueue = fallbackQueue.filter(
      (item) => !idsToProcess.has(item.uniqueId),
    );

    fallbackQueue.length = 0;
    fallbackQueue.push(...newFallbackQueue);

    for (const item of itemsToProcess) {
      try {
        const targetChannel = await client.channels.fetch(
          FAILED_TICKETS_FORUM_ID,
        );
        if (
          !targetChannel ||
          (targetChannel.type !== ChannelType.GuildForum &&
            targetChannel.type !== ChannelType.GuildText)
        ) {
          throw new Error(
            "Target channel not found or is not a text/forum channel.",
          );
        }

        console.log(
          `[Supervisor] Attempting to create fallback thread for "${item.title}"...`,
        );

        const threadName = `This ticket did not create after 25 mins`;

        const starterMessageContent = `${item.title} ${item.messageLink}`;

        const starterMessage = await targetChannel.send(starterMessageContent);

        await starterMessage.startThread({
          name: threadName,
        });

        console.log(
          `[Supervisor] SUCCESS: Fallback thread created for "${item.title}".`,
        );
        createdFallbackThreads.set(item.uniqueId, Date.now());
        console.log(
          `[Supervisor] Registered fallback for ID ${item.uniqueId}. Now tracking ${createdFallbackThreads.size} threads.`,
        );

        console.log(
          `[Supervisor] ${fallbackQueue.length} items remaining in fallback queue.`,
        );
      } catch (error) {
        console.error(
          `[Supervisor] ERROR: Failed to create fallback thread for "${item.title}":`,
          error.message,
        );

        const errorMessage = error.message.toLowerCase();
        if (
          errorMessage.includes("maximum number of threads") ||
          errorMessage.includes("maximum number of active threads")
        ) {
          console.log(
            `[Supervisor] Thread limit reached! Triggering an emergency archive routine...`,
          );

          try {
            const logChannel = await client.channels.fetch(
              FAILED_TICKETS_FORUM_ID,
            );
            if (logChannel) {
              await logChannel.send(
                "⚠️ Thread limit reached. Running an emergency cleanup. Failed threads will be re-queued.",
              );
            }
          } catch (logErr) {
            console.error(
              "[Supervisor] Could not send emergency log message.",
              logErr,
            );
          }

          await autoArchiveInactiveThreads();
        }

        console.log(
          `[Supervisor] Re-queuing item "${item.title}" for a later attempt.`,
        );
        fallbackQueue.push(item);
      }

      if (itemsToProcess.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    console.log(
      `[Supervisor] Fallback queue processing finished. ${fallbackQueue.length} items remaining in queue.`,
    );

    isProcessingFallbackQueue = false;
    console.log("[Supervisor] Finished processing fallback queue.");
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  const { commandName } = interaction;
  if (commandName === "config") {
    if (typeof botConfig === "undefined" || typeof saveConfig === "undefined") {
      return interaction.reply({
        content: "Config error.",
        flags: MessageFlags.Ephemeral,
      });
    }
    const subCommand = interaction.options.getSubcommand();
    if (
      !interaction.memberPermissions.has(
        PermissionsBitField.Flags.Administrator,
      )
    ) {
      return interaction.reply({
        content: "Admin only.",
        flags: MessageFlags.Ephemeral,
      });
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
            "Auto-processing enabled by command. Ensuring next scan is scheduled.",
          );
          isMassScanInProgress = false;
          clearTimeout(scanTimeoutId);
          scheduleNextScan();
        } else {
          clearTimeout(scanTimeoutId);
          console.log(
            "Auto-processing disabled by command. Future scans cancelled.",
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
            ms / 60000,
          )}m).`,
          flags: MessageFlags.Ephemeral,
        });
      } else
        await interaction.reply({
          content: `Invalid age: "${ageStr}". Use "2h5m", "30m", "1d", "125" (mins).`,
          flags: MessageFlags.Ephemeral,
        });
    } else if (subCommand === "toggle_paid_column") {
      if (interaction.user.id !== "907390293316337724") {
        return interaction.reply({
          content: "⛔ This subcommand is restricted to the bot owner.",
          ephemeral: true,
        });
      }

      const newState = interaction.options.getBoolean("enabled");
      if (botConfig.autoSetPaidToN !== newState) {
        botConfig.autoSetPaidToN = newState;
        configChanged = true;
      }

      await interaction.reply({
        content: `✅ Automatic setting of "Paid?" to "N" is now **${newState ? "ENABLED" : "DISABLED"}**.`,
        ephemeral: true,
      });
    } else if (subCommand === "set_processing_interval") {
      const intervalString = interaction.options.getString("interval");
      const parsedMs = parseDurationToMs(intervalString);
      if (parsedMs !== null && parsedMs >= 60000) {
        if (botConfig.processingIntervalMs !== parsedMs) {
          botConfig.processingIntervalMs = parsedMs;
          configChanged = true;
          console.log(
            `Processing interval changed to ${parsedMs}ms. Re-scheduling next scan.`,
          );
          scheduleNextScan();
        }
        await interaction.reply({
          content: `Ticket processing interval set to: **${intervalString}** (~${Math.round(
            parsedMs / 60000,
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
            timeRemainingMs,
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
          `- Automatic "Paid?" to "N" is **${botConfig.autoSetPaidToN}**\n` +
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
        PermissionsBitField.Flags.ManageMessages,
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
        PermissionsBitField.Flags.ManageMessages,
      )
    ) {
      return interaction.reply({
        content: "You do not have sufficient permissions.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const subCommand = interaction.options.getSubcommand();

    if (subCommand === "pending_tickets_queue") {
      let response = `**Fallback Thread Creation Queue Status**\n\n`;

      if (isProcessingFallbackQueue) {
        response += "🔹 **Status:** Currently processing the queue.\n";
      } else {
        response += "🔹 **Status:** Idle, waiting for new items.\n";
      }

      response += `🔹 **Items in Queue:** ${fallbackQueue.length}\n\n`;

      if (fallbackQueue.length > 0) {
        response += "```\n";
        for (let i = 0; i < Math.min(fallbackQueue.length, 10); i++) {
          response += `${i + 1}. ${fallbackQueue[i].title}\n`;
        }
        response += "```";
        if (fallbackQueue.length > 10) {
          response += `\n*...and ${fallbackQueue.length - 10} more.*`;
        }
      }

      return interaction.reply({ content: response, ephemeral: true });
    }

    const startOrder = interaction.options.getInteger("start_order") ?? 0;
    const endOrder = interaction.options.getInteger("end_order") ?? Infinity;

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
          startOrder,
          endOrder,
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
      }`,
    );
    console.log(
      `Initial processing interval: ${
        botConfig.processingIntervalMs / 60000
      } minutes`,
    );

    if (botConfig.autoProcessingEnabled) {
      console.log(
        "Auto-processing is enabled. Performing an initial scan immediately upon startup.",
      );
      performMassScan();
    } else {
      console.log(
        "Auto-processing is initially disabled. No scan will run until enabled via command.",
      );
    }
  });

  cron.schedule("0 */4 * * *", () => {
    console.log(
      "[Cron] Triggering scheduled inactive thread archival routine.",
    );
    autoArchiveInactiveThreads();
  });
  console.log("Scheduled inactive thread archival to run every 4 hours.");

  setInterval(processFallbackQueue, FALLBACK_QUEUE_PROCESS_INTERVAL_MS);
  console.log(
    `[Supervisor] Fallback queue processor started. Checking every ${
      FALLBACK_QUEUE_PROCESS_INTERVAL_MS / 1000
    } seconds.`,
  );

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
