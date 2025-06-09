// index.js
require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
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
const WORKSHEET_TITLE = process.env.WORKSHEET_TITLE || "Sheet1";
const PROPOSAL_COLUMN_HEADER = "Proposal";
const ORDER_COLUMN_HEADER = "#";

const CRON_WAKE_INTERVAL =
  process.env.CRON_WAKE_INTERVAL_EXPRESSION || "* * * * *";
const TICKET_TOOL_CLOSE_COMMAND_TEXT =
  process.env.TICKET_TOOL_CLOSE_COMMAND || "$close";
const TICKET_TOOL_DELETE_COMMAND_TEXT =
  process.env.TICKET_TOOL_DELETE_COMMAND || "$delete";
const DEFAULT_MIN_TICKET_AGE_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;
const DEFAULT_PROCESSING_INTERVAL_MS = 30 * 60 * 1000;

const CONFIG_FILE_PATH = path.join(__dirname, "bot_config.json");
let botConfig = {
  autoProcessingEnabled:
    (process.env.ENABLE_AUTO_PROCESSING || "true").toLowerCase() === "true",
  currentPostProcessingAction:
    process.env.DEFAULT_TICKET_CLOSE_ACTION || "none",
  minTicketAgeForProcessing: DEFAULT_MIN_TICKET_AGE_MS,
  processingIntervalMs: DEFAULT_PROCESSING_INTERVAL_MS,
  lastSuccessfulScanTimestamp: 0,
  errorNotificationUserID: process.env.DEFAULT_ERROR_USER_ID || null,
};

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
  if (ms < 0) ms = 0;
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
  if (seconds > 0 && parts.length < 2) parts.push(`${seconds}s`);

  if (parts.length === 0) return "approx. now or very soon";
  return `approx. ${parts.join(" ")}`;
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
      } else if (loadedConfig[key] === undefined) {
        botConfig[key] = defaultValue;
        changedDuringLoad = true;
      } else if (validator && !validator(loadedConfig[key])) {
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
      process.env.DEFAULT_TICKET_CLOSE_ACTION || "none",
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
      "lastSuccessfulScanTimestamp",
      0,
      (val) => typeof val === "number"
    );
    applyOrDefault(
      "errorNotificationUserID",
      process.env.DEFAULT_ERROR_USER_ID || null,
      (val) => typeof val === "string" || val === null
    );

    console.log("Configuration loaded from bot_config.json.");
    if (changedDuringLoad) {
      console.log(
        "Default values applied for some missing/invalid config keys. Saving updated config."
      );
      await saveConfig(false);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(
        "bot_config.json not found. Initializing with default values and creating file."
      );
      await saveConfig(false);
    } else {
      console.error(
        "Error loading bot_config.json. Using hardcoded/env default values.",
        error
      );
      botConfig = {
        autoProcessingEnabled:
          (process.env.ENABLE_AUTO_PROCESSING || "true").toLowerCase() ===
          "true",
        currentPostProcessingAction:
          process.env.DEFAULT_TICKET_CLOSE_ACTION || "none",
        minTicketAgeForProcessing: DEFAULT_MIN_TICKET_AGE_MS,
        processingIntervalMs: DEFAULT_PROCESSING_INTERVAL_MS,
        lastSuccessfulScanTimestamp: 0,
        errorNotificationUserID: process.env.DEFAULT_ERROR_USER_ID || null,
      };
    }
  }
}

async function saveConfig(logFullObject = true) {
  try {
    await fs.writeFile(
      CONFIG_FILE_PATH,
      JSON.stringify(botConfig, null, 2),
      "utf8"
    );
    if (logFullObject)
      console.log("Configuration saved to bot_config.json:", botConfig);
    else console.log("Configuration saved to bot_config.json.");
  } catch (error) {
    console.error("Error saving bot_config.json:", error);
  }
}

let doc;
if (GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY && GOOGLE_SHEET_ID) {
  try {
    const serviceAccountAuth = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
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
  partials: [Partials.Channel],
});

async function upsertRowByOrderValue(
  orderValueToFind,
  dataWithOrderAndProposal
) {
  const logPrefix = `[Order #${orderValueToFind}]`;
  if (!doc) {
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
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle[WORKSHEET_TITLE];
    if (!sheet) {
      console.error(
        `${logPrefix} Error: Worksheet "${WORKSHEET_TITLE}" not found.`
      );
      return {
        success: false,
        action: "none",
        message: `Worksheet "${WORKSHEET_TITLE}" not found.`,
      };
    }

    await sheet.loadHeaderRow();
    if (!sheet.headerValues.includes(ORDER_COLUMN_HEADER)) {
      console.error(
        `${logPrefix} Error: Order Column "${ORDER_COLUMN_HEADER}" not in sheet. Cannot upsert by order.`
      );
      return {
        success: false,
        action: "none",
        message: `Order Column "${ORDER_COLUMN_HEADER}" not found.`,
      };
    }
    if (
      !sheet.headerValues.includes(PROPOSAL_COLUMN_HEADER) &&
      dataWithOrderAndProposal[PROPOSAL_COLUMN_HEADER]
    ) {
      console.warn(
        `${logPrefix} Warning: Proposal Column "${PROPOSAL_COLUMN_HEADER}" not in sheet. Proposal ID might not be set if adding new row.`
      );
    }

    const rows = await sheet.getRows();
    let targetRow = null;
    const orderValueString = orderValueToFind.toString();

    for (let i = 0; i < rows.length; i++) {
      let cellOrderValue = rows[i].get(ORDER_COLUMN_HEADER);
      if (cellOrderValue !== null && cellOrderValue !== undefined) {
        if (cellOrderValue.toString() === orderValueString) {
          targetRow = rows[i];
          break;
        }
      }
    }

    const dataForSheet = {};
    for (const key of sheet.headerValues) {
      dataForSheet[key] =
        dataWithOrderAndProposal[key] === "N/A" ||
        dataWithOrderAndProposal[key] === undefined
          ? ""
          : dataWithOrderAndProposal[key];
    }

    dataForSheet[ORDER_COLUMN_HEADER] = orderValueString;

    if (targetRow) {
      console.log(`${logPrefix} Row found by Order Column. Updating...`);
      for (const key in dataForSheet) {
        if (sheet.headerValues.includes(key)) {
          targetRow.set(key, dataForSheet[key]);
        }
      }
      await targetRow.save();
      console.log(`${logPrefix} Row updated successfully.`);
      return { success: true, action: "updated" };
    } else {
      console.log(
        `${logPrefix} No row found with Order Column value "${orderValueToFind}". Adding new row...`
      );
      await sheet.addRow(dataForSheet);
      console.log(`${logPrefix} New row added.`);
      return { success: true, action: "added" };
    }
  } catch (error) {
    console.error(`${logPrefix} Error upserting row by order value:`, error);
    return {
      success: false,
      action: "none",
      error: error,
      message: "An error occurred during sheet operation.",
    };
  }
}

// --- MAIN TICKET PROCESSING FUNCTION ---
async function processTicketChannel(
  channel,
  initiatedBy = "Automatic Scan",
  recordType = "standard"
) {
  const logPrefix = `[${channel.id} | ${channel.name}]`;
  let proposalNumber = "",
    typeColumn = "",
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

  const channelNameMatch = channel.name.match(/ticket-(\d+)/i);
  proposalNumber =
    channelNameMatch && channelNameMatch[1]
      ? parseInt(channelNameMatch[1], 10).toString()
      : "";

  if (!proposalNumber) {
    console.log(
      `${logPrefix} Could not extract a numeric ticket ID from channel name "${channel.name}". Skipping.`
    );
    return { success: false, reason: "invalid_proposal_id_format" };
  }
  const orderColumnValue = proposalNumber;

  console.log(
    `${logPrefix} Starting processing for Proposal #${proposalNumber} (Order #${orderColumnValue}). Initiated by: ${initiatedBy}, Type: ${recordType}`
  );

  try {
    const allMessages = await channel.messages.fetch({ limit: 100 });
    if (initiatedBy.startsWith("Automatic")) {
      for (const msg of Array.from(allMessages.values())) {
        if (
          msg.content.toLowerCase().startsWith("flag:") ||
          msg.content.toLowerCase().startsWith("ticket data for order")
        ) {
          console.log(
            `${logPrefix} Found "Flag:" message or ticket already processed. Skipping.`
          );
          return { success: false, reason: "flagged_explicitly" };
        }
      }
    }
    for (const msg of Array.from(allMessages.values())) {
      if (msg.content.includes("https://oracle.uma.xyz/")) {
        const linkMatch = msg.content.match(
          /(https:\/\/oracle\.uma\.xyz\/[^\s<>()]+)/
        );
        if (linkMatch && linkMatch[1]) {
          ooLink = linkMatch[1];
          console.log(`${logPrefix} OO Link: ${ooLink}`);
          break;
        }
      }
    }
    let closingBlockFoundAndProcessed = false;
    if (recordType === "assertion") {
      typeColumn = "Assertion";
      console.log(`${logPrefix} Processing as Assertion.`);
      primaryUser = "";
      secondaryUser = "";
      terciaryUser = "";
      closerUser = "";
      bonkersInMessageText.length = 0;
      bonkedUsersData.primary.clear();
      bonkedUsersData.secondary.clear();
      bonkedUsersData.tertiary.clear();
      disputedColumn = "";
      closingBlockFoundAndProcessed = true;
    } else if (recordType === "disputed_manual") {
      disputedColumn = "y";
      typeColumn = "Disputed";
      console.log(`${logPrefix} Processing as Disputed (manual).`);
      primaryUser = "";
      secondaryUser = "";
      terciaryUser = "";
      closerUser = recorderUser;
      bonkersInMessageText.length = 0;
      bonkedUsersData.primary.clear();
      bonkedUsersData.secondary.clear();
      bonkedUsersData.tertiary.clear();
      closingBlockFoundAndProcessed = true;
    } else {
      for (const msg of Array.from(allMessages.values())) {
        const lines = msg.content.split("\n");
        if (lines.length === 0) continue;
        const firstLineLower = lines[0].toLowerCase();
        if (firstLineLower.startsWith("closing:")) {
          console.log(
            `${logPrefix} 'CLOSING:' block by ${msg.author.displayName}`
          );
          closerUser = msg.author.displayName;
          // const memberCloser = channel.guild.members.cache.get(msg.author.id);
          // closerUser = memberCloser
          //   ? memberCloser.displayName
          //   : msg.author.username;
          const contentRaw = lines[0].substring(8).trim();
          const contentLower = contentRaw.toLowerCase();
          if (contentLower === "disputed") {
            console.log(`${logPrefix} Disputed mode.`);
            disputedColumn = "y";
            primaryUser = "";
            secondaryUser = "";
            terciaryUser = "";
            bonkersInMessageText.length = 0;
            bonkedUsersData.primary.clear();
            bonkedUsersData.secondary.clear();
            bonkedUsersData.tertiary.clear();
            closingBlockFoundAndProcessed = true;
            break;
          } else if (contentLower === "assertion") {
            console.log(`${logPrefix} Assertion mode from CLOSING line.`);
            typeColumn = "Assertion";
            primaryUser = "";
            secondaryUser = "";
            terciaryUser = "";
            bonkersInMessageText.length = 0;
            bonkedUsersData.primary.clear();
            bonkedUsersData.secondary.clear();
            bonkedUsersData.tertiary.clear();
            disputedColumn = "";
            closingBlockFoundAndProcessed = true;
            break;
          }
          const users = contentRaw
            ? contentRaw
                .split(",")
                .map((n) => n.trim())
                .filter(Boolean)
            : [];
          if (users.length > 3) {
            validationErrorMessages.push(
              `Error: "CLOSING:" max 3 users. Found: ${users.length}.`
            );
          }
          primaryUser = users[0] || "";
          secondaryUser = users[1] || "";
          terciaryUser = users[2] || "";
          console.log(
            `${logPrefix} P/S/T: ${primaryUser || "-"}/${
              secondaryUser || "-"
            }/${terciaryUser || "-"}. Closer: ${closerUser}`
          );
          const bonkPattern =
            /^(.*?)\s+bonked\s+(.*?)\s+(primary|secondary|tertiary)$/i;
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const match = line.match(bonkPattern);
            if (match) {
              const bonker = match[1].trim(),
                victim = match[2].trim(),
                type = match[3].toLowerCase();
              if (bonkersInMessageText.length < 5)
                bonkersInMessageText.push(bonker);
              if (type === "primary") bonkedUsersData.primary.add(victim);
              else if (type === "secondary")
                bonkedUsersData.secondary.add(victim);
              else if (type === "tertiary")
                bonkedUsersData.tertiary.add(victim);
            } else console.log(`${logPrefix} Line not bonk: "${line}"`);
          }
          closingBlockFoundAndProcessed = true;
          break;
        }
      }
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
      console.log(`${logPrefix} "CLOSING:" not found. Flagging.`);
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
      "bonker 5": bonkersInMessageText[4] || "",
      "BONKED 1": Array.from(bonkedUsersData.primary).join(", ") || "",
      "BONKED 2": Array.from(bonkedUsersData.secondary).join(", ") || "",
      "BONKED 3": Array.from(bonkedUsersData.tertiary).join(", ") || "",
    };
    if (!doc) {
      console.error(`${logPrefix} Sheets not configured.`);
      await channel.send("Error: Google Sheets not configured.");
      return { success: false, reason: "sheets_not_configured" };
    }

    const result = await upsertRowByOrderValue(orderColumnValue, rowData);

    if (result.success) {
      console.log(`${logPrefix} Data ${result.action}.`);
      const ooLinkFmt = ooLink === "" ? "Not found" : `[here](${ooLink})`;
      let actionTxt = result.action; // 'updated' or 'added'
      let resp = `Ticket data for Order #${orderColumnValue} ${actionTxt}!\n**Proposal:** ${proposalNumber}\n`;
      if (typeColumn) resp += `**Type:** ${typeColumn}\n`;
      resp += `**OO Link:** ${ooLinkFmt}\n`;
      if (recordType === "disputed_manual" || disputedColumn === "y")
        resp += `**Disputed:** ${disputedColumn}\n`;
      else if (recordType !== "assertion" && !typeColumn.toLowerCase().includes("assertion")) {
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
      if (botConfig.currentPostProcessingAction != "none") {
        const cmd =
          botConfig.currentPostProcessingAction === "delete"
            ? TICKET_TOOL_DELETE_COMMAND_TEXT
            : TICKET_TOOL_CLOSE_COMMAND_TEXT;
        if (cmd) {
          try {
            await channel.send(cmd);
            console.log(`${logPrefix} Sent: ${cmd}`);
          } catch (e) {
            console.error(`${logPrefix} Err sending close cmd:`, e);
            await channel.send("Saved, but failed to send close cmd.");
          }
        } else console.log(`${logPrefix} No close/delete cmd configured.`);
      }
      return { success: true, action: result.action };
    } else {
      console.error(
        `${logPrefix} Failed to save/update sheet for Order #${orderColumnValue}. Reason: ${
          result.message || "Unknown"
        }`
      );
      let errSave =
        result.action === "not_found"
          ? `Flag: Row for Order #${orderColumnValue} not found. A new row was NOT created. Ensure sheet is pre-filled or check order number.`
          : `Error: Issue saving/updating sheet for Order #${orderColumnValue}. Details: ${
              result.message || "Check logs."
            }`;
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

// --- CRON JOB SCHEDULER ---
let scheduledTask;
function scheduleTicketScan() {
  if (scheduledTask) {
    scheduledTask.stop();
    console.log("Previous task stopped.");
  }
  if (cron.validate(CRON_WAKE_INTERVAL)) {
    scheduledTask = cron.schedule(CRON_WAKE_INTERVAL, async () => {
      if (!botConfig.autoProcessingEnabled) {
        return;
      }
      const now = Date.now();
      if (
        now - (botConfig.lastSuccessfulScanTimestamp || 0) <
        botConfig.processingIntervalMs
      ) {
        return;
      }
      console.log(
        `[${new Date().toISOString()}] Cron Wake Up: Time for full ticket scan.`
      );
      const guild = client.guilds.cache.first();
      if (!guild) {
        return;
      }
      console.log(`Cron: Scanning guild: ${guild.name}`);
      const channels = guild.channels.cache;
      let processedAnyThisRun = false;
      for (const [_id, ch] of channels) {
        if (
          (ch.type === ChannelType.GuildText ||
            ch.type === ChannelType.PublicThread ||
            ch.type === ChannelType.PrivateThread) &&
          ch.name.toLowerCase().startsWith("ticket-")
        ) {
          const age = Date.now() - ch.createdTimestamp;
          if (age >= botConfig.minTicketAgeForProcessing) {
            console.log(`Cron: Eligible ticket: ${ch.name}`);
            const result = await processTicketChannel(
              ch,
              "Automatic Scan",
              "standard"
            );
            if (
              result.success ||
              [
                "flagged_explicitly",
                "no_closing_message_and_flagged",
                "validation_error_in_closing_block",
                "invalid_proposal_id_format",
              ].includes(result.reason)
            ) {
              processedAnyThisRun = true;
            }
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
      if (
        processedAnyThisRun ||
        (botConfig.lastSuccessfulScanTimestamp === 0 && channels.size > 0)
      ) {
        botConfig.lastSuccessfulScanTimestamp = Date.now();
        await saveConfig(false);
        console.log(
          `[${new Date().toISOString()}] Updated lastSuccessfulScanTimestamp.`
        );
      }
      console.log(`[${new Date().toISOString()}] Cron: Scan finished.`);
    });
    console.log(
      `Scanner master cron task scheduled: ${CRON_WAKE_INTERVAL}. Processing interval: ~${
        botConfig.processingIntervalMs / 60000
      }m.`
    );
  } else
    console.error(
      `Invalid CRON_WAKE_INTERVAL: "${CRON_WAKE_INTERVAL}". Task not run.`
    );
}

// --- DISCORD COMMAND HANDLERS ---
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

    const subCommand = (args[0] || "").toLowerCase();
    let recordType = "standard"; // Default
    let initiatedByString = `Manual Record by ${message.member.displayName}`;

    if (subCommand === "assertion") {
      recordType = "assertion";
      initiatedByString = `Manual Assertion by ${message.member.displayName}`;
    } else if (subCommand === "disputed") {
      recordType = "disputed_manual";
      initiatedByString = `Manual Disputed Record by ${message.member.displayName}`;
    }

    await message.reply(
      `Processing ${message.channel.name} as ${recordType}...`
    );
    await processTicketChannel(message.channel, initiatedByString, recordType);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  const { commandName } = interaction;
  if (commandName === "config") {
    if (typeof botConfig === "undefined" || typeof saveConfig === "undefined") {
      return interaction.reply({ content: "Config error.", ephemeral: true });
    }
    const subCommand = interaction.options.getSubcommand();
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator
      )
    )
      return interaction.reply({ content: "Admin only.", ephemeral: true });
    let configChanged = false;

    if (subCommand === "set_post_processing_action") {
      const act = interaction.options.getString("action");
      if (botConfig.currentPostProcessingAction !== act) {
        botConfig.currentPostProcessingAction = act;
        configChanged = true;
      }
      await interaction.reply({
        content: `Post processing action: **${botConfig.currentPostProcessingAction}**.`,
        ephemeral: true,
      });
    } else if (subCommand === "toggle_auto_processing") {
      const state = interaction.options.getBoolean("enabled");
      if (botConfig.autoProcessingEnabled !== state) {
        botConfig.autoProcessingEnabled = state;
        configChanged = true;
      }
      await interaction.reply({
        content: `Auto processing: **${
          botConfig.autoProcessingEnabled ? "on" : "off"
        }**.`,
        ephemeral: true,
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
          ephemeral: true,
        });
      } else
        await interaction.reply({
          content: `Invalid age: "${ageStr}". Use "2h5m", "30m", "1d", "125" (mins).`,
          ephemeral: true,
        });
    } else if (subCommand === "set_processing_interval") {
      const intervalString = interaction.options.getString("interval");
      const parsedMs = parseDurationToMs(intervalString);
      if (parsedMs !== null && parsedMs >= 60000) {
        if (botConfig.processingIntervalMs !== parsedMs) {
          botConfig.processingIntervalMs = parsedMs;
          configChanged = true;
        }
        await interaction.reply({
          content: `Ticket processing interval: **${intervalString}** (~${Math.round(
            parsedMs / 60000
          )}m). Bot checks at \`${CRON_WAKE_INTERVAL}\`.`,
          ephemeral: true,
        });
      } else
        await interaction.reply({
          content: `Invalid interval: "${intervalString}". Use "30m", "1h", etc. Min 1 minute.`,
          ephemeral: true,
        });
    } else if (subCommand === "set_error_user") {
      const user = interaction.options.getUser("user");
      if (user) {
        if (botConfig.errorNotificationUserID !== user.id) {
          botConfig.errorNotificationUserID = user.id;
          configChanged = true;
        }
        await interaction.reply({
          content: `Error pings will target: **${user.tag}** (<@${user.id}>).`,
          ephemeral: true,
        });
      } else {
        if (botConfig.errorNotificationUserID !== null) {
          botConfig.errorNotificationUserID = null;
          configChanged = true;
        }
        await interaction.reply({
          content: `Error ping user cleared.`,
          ephemeral: true,
        });
      }
    } else if (subCommand === "view_settings") {
      const ageInMinutes = Math.round(
        botConfig.minTicketAgeForProcessing / 60000
      );
      const processingIntervalMinutes = Math.round(
        botConfig.processingIntervalMs / 60000
      );
      const errorUser = botConfig.errorNotificationUserID
        ? `<@${botConfig.errorNotificationUserID}>`
        : "Not set";
      let timeToNextScanMs =
        botConfig.lastSuccessfulScanTimestamp +
        botConfig.processingIntervalMs -
        Date.now();
      if (!botConfig.autoProcessingEnabled) {
        timeToNextScanMs = -1;
      }
      const nextScanTimeReadable = botConfig.autoProcessingEnabled
        ? formatMsToHumanReadable(timeToNextScanMs > 0 ? timeToNextScanMs : 0)
        : "Auto-processing disabled";

      await interaction.reply({
        content:
          `Current Bot Configuration:\n` +
          `- Cron Wake Interval: \`${CRON_WAKE_INTERVAL}\` (from .env)\n` +
          `- Ticket Processing Interval: **${processingIntervalMinutes} minutes**\n` +
          `- Automatic Processing: **${
            botConfig.autoProcessingEnabled ? "Enabled" : "Disabled"
          }**\n` +
          `- Next Full Scan In: **${nextScanTimeReadable}**\n` +
          `- Default Post Processing Action: **${botConfig.currentPostProcessingAction}**\n` +
          `- Min Ticket Age for Auto-Processing: **${ageInMinutes} minutes**\n` +
          `- Error Notification User: **${errorUser}**`,
        ephemeral: true,
      });
    } else
      await interaction.reply({
        content: "Unknown config subcmd.",
        ephemeral: true,
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
        ephemeral: true,
      });
    }

    if (!botConfig.autoProcessingEnabled) {
      return interaction.reply({
        content: "Automatic ticket processing is currently **disabled**.",
        ephemeral: true,
      });
    }

    const nextScanTimestamp =
      botConfig.lastSuccessfulScanTimestamp + botConfig.processingIntervalMs;
    const timeRemainingMs = nextScanTimestamp - Date.now();

    if (timeRemainingMs <= 0) {
      await interaction.reply({
        content: `A full ticket scan should occur on the next cron wake-up (within the next minute if wake interval is \`${CRON_WAKE_INTERVAL}\`).`,
        ephemeral: true,
      });
    } else {
      const timeRemainingReadable = formatMsToHumanReadable(timeRemainingMs);
      await interaction.reply({
        content: `Next full ticket scan scheduled in: **${timeRemainingReadable}**.`,
        ephemeral: true,
      });
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
    scheduleTicketScan();
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