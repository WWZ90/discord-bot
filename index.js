require('dotenv').config();
const { Client, GatewayIntentBits, Partials, PermissionsBitField } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// --- Discord Bot Configuration ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel]
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.COMMAND_PREFIX || '!';

// --- Google Sheets Configuration ---
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY_RAW = process.env.GOOGLE_PRIVATE_KEY;
const GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY_RAW ? GOOGLE_PRIVATE_KEY_RAW.replace(/\\n/g, '\n') : undefined;
const WORKSHEET_TITLE = process.env.WORKSHEET_TITLE || 'Sheet1';
const PROPOSAL_COLUMN_HEADER = 'Proposal';

let doc;
if (GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY && GOOGLE_SHEET_ID) {
    try {
        const serviceAccountAuth = new JWT({
            email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: GOOGLE_PRIVATE_KEY,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
        console.log("GoogleSpreadsheet instance created.");
    } catch (error) {
        console.error("Error creating JWT or GoogleSpreadsheet instance:", error);
        console.warn("Warning: Google Sheets credentials missing or incorrect. Spreadsheet functionality will be disabled.");
    }
} else {
    console.warn("Warning: Environment variables for Google Sheets are missing. Spreadsheet functionality will be disabled.");
}

async function upsertSpreadsheetRow(proposalId, data) {
    if (!doc) {
        console.error("Error: GoogleSpreadsheet instance is not initialized.");
        return { success: false, action: 'none' };
    }
    try {
        await doc.loadInfo();
        const sheet = doc.sheetsByTitle[WORKSHEET_TITLE];
        if (!sheet) {
            console.error(`Error: Worksheet titled "${WORKSHEET_TITLE}" not found.`);
            if (doc.sheetCount > 0) {
                const availableSheetTitles = doc.sheetsByIndex.map(s => s.title);
                console.log(`Available sheets: ${availableSheetTitles.join(', ')}`);
            } else {
                console.log("The document does not seem to have any sheets.");
            }
            return { success: false, action: 'none' };
        }
        console.log(`Worksheet found: "${sheet.title}"`);

        await sheet.loadHeaderRow();
        if (!sheet.headerValues.includes(PROPOSAL_COLUMN_HEADER)) {
            console.error(`Error: Column "${PROPOSAL_COLUMN_HEADER}" does not exist in the sheet. Please check headers.`);
            return { success: false, action: 'none' };
        }

        const rows = await sheet.getRows();
        let existingRow = null;

        for (let i = 0; i < rows.length; i++) {
            let cellValue = rows[i].get(PROPOSAL_COLUMN_HEADER);
            let normalizedCellValue = "";

            if (cellValue !== null && cellValue !== undefined) {
                if (typeof cellValue === 'number') {
                    normalizedCellValue = cellValue.toString();
                } else if (typeof cellValue === 'string') {
                    const trimmedCellValue = cellValue.trim();
                    const parsedNum = parseInt(trimmedCellValue, 10);
                    if (!isNaN(parsedNum) && parsedNum.toString() === trimmedCellValue.replace(/^0+/, '')) {
                        normalizedCellValue = parsedNum.toString();
                    } else {
                        normalizedCellValue = trimmedCellValue; 
                    }
                }
            }
            
            if (normalizedCellValue === proposalId) {
                existingRow = rows[i];
                break;
            }
        }

        if (existingRow) {
            console.log(`Existing row found for Proposal ${proposalId}. Updating...`);
            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    if (sheet.headerValues.includes(key)) {
                        existingRow.set(key, data[key] === "N/A" ? "" : data[key]);
                    } else {
                        console.warn(`Warning: Column "${key}" does not exist in the sheet and will not be updated.`);
                    }
                }
            }
            await existingRow.save();
            console.log('Row updated in Google Sheets for Proposal:', proposalId);
            return { success: true, action: 'updated' };
        } else {
            console.log(`No row found for Proposal ${proposalId}. Adding new row...`);
            const newRowData = {};
            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    newRowData[key] = data[key] === "N/A" ? "" : data[key];
                }
            }
            await sheet.addRow(newRowData);
            console.log('New row added to Google Sheets for Proposal:', proposalId);
            return { success: true, action: 'added' };
        }
    } catch (error) {
        console.error('Error upserting row in Google Sheets:', error);
        return { success: false, action: 'none', error: error };
    }
}


client.once('ready', () => {
    console.log(`${client.user.tag} has connected to Discord!`);
    console.log(`Bot is ready. Use "${PREFIX}record" or "${PREFIX}record assertion".`);
});

client.on('messageCreate', async message => {
    if (message.author.bot && message.author.id !== client.user.id) return;
    if (!message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const contentArgs = message.content.slice(PREFIX.length).trim().split(/ +/);
    const commandName = contentArgs.shift().toLowerCase();

    if (commandName === 'record') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
            return message.reply('You do not have permission to use this command.');
        }

        const subCommand = (contentArgs[0] || "").toLowerCase();
        const isAssertionRecord = subCommand === 'assertion';
        
        await message.reply(`Processing ${isAssertionRecord ? 'assertion record' : 'record'} for: ${message.channel.name}...`);

        let proposalNumber = "";
        let typeColumn = "";
        let ooLink = "";
        let primaryUser = "";
        let secondaryUser = "";
        let terciaryUser = "";
        let closerUser = "";
        const recorderUser = message.member.displayName;
        let disputedColumn = "";
        const bonkersInMessageText = [];
        const bonkedUsersData = { primary: new Set(), secondary: new Set(), tertiary: new Set() };
        let validationErrorMessages = [];

        const channelNameMatch = message.channel.name.match(/ticket-(\d+)/i);
        if (channelNameMatch && channelNameMatch[1]) {
            proposalNumber = parseInt(channelNameMatch[1], 10).toString(); 
        } else {
            proposalNumber = message.channel.name;
        }
        console.log(`Normalized Proposal Number: ${proposalNumber}`);

        try {
            const fetchedMessagesForOO = await message.channel.messages.fetch({ limit: 100 });
            for (const msg of Array.from(fetchedMessagesForOO.values())) {
                if (msg.content.includes("https://oracle.uma.xyz/")) {
                    const linkMatch = msg.content.match(/(https:\/\/oracle\.uma\.xyz\/[^\s<>()]+)/);
                    if (linkMatch && linkMatch[1]) {
                        ooLink = linkMatch[1];
                        console.log(`OO Link (most recent): ${ooLink}`);
                        break;
                    }
                }
            }

            if (isAssertionRecord) {
                typeColumn = "Assertion";
                console.log("Assertion mode.");
            } else {
                const fetchedMessagesForFinal = await message.channel.messages.fetch({ limit: 100 });
                let finalBlockFoundAndProcessed = false;

                for (const msg of Array.from(fetchedMessagesForFinal.values())) {
                    const messageContentLines = msg.content.split('\n');
                    if (messageContentLines.length === 0) continue;
                    const firstLineOfMessageLower = messageContentLines[0].toLowerCase();

                    if (firstLineOfMessageLower.startsWith('final:')) {
                        console.log(`Latest 'Final:' block found in msg ID: ${msg.id} by ${msg.author.username}`);
                        const memberCloser = msg.guild.members.cache.get(msg.author.id);
                        closerUser = memberCloser ? memberCloser.displayName : msg.author.username;
                        const finalLineContent = messageContentLines[0].substring(6).trim();

                        if (finalLineContent.toLowerCase() === 'disputed') {
                            console.log("Disputed mode detected.");
                            disputedColumn = "y";
                            primaryUser = ""; secondaryUser = ""; terciaryUser = "";
                            bonkersInMessageText.length = 0;
                            bonkedUsersData.primary.clear(); bonkedUsersData.secondary.clear(); bonkedUsersData.tertiary.clear();
                            finalBlockFoundAndProcessed = true;
                            break;
                        }

                        const finalLineUsersArray = finalLineContent ? finalLineContent.split(/\s+/) : [];
                        if (finalLineUsersArray.length > 3) {
                            validationErrorMessages.push(`Error: "Final:" line max 3 users. Found: ${finalLineUsersArray.length}.`);
                            break;
                        }
                        
                        const usersFromFinalLineForValidation = new Set();
                        primaryUser = finalLineUsersArray[0] || "";
                        if (primaryUser) usersFromFinalLineForValidation.add(primaryUser.toLowerCase());
                        secondaryUser = finalLineUsersArray[1] || "";
                        if (secondaryUser) usersFromFinalLineForValidation.add(secondaryUser.toLowerCase());
                        terciaryUser = finalLineUsersArray[2] || "";
                        if (terciaryUser) usersFromFinalLineForValidation.add(terciaryUser.toLowerCase());
                        console.log(`P/S/T Users: ${primaryUser || '-'}/${secondaryUser || '-'}/${terciaryUser || '-'}. Closer: ${closerUser}`);

                        const bonkPattern = /(\S+)\s+bonked\s+(\S+)\s+(primary|secondary|tertiary)/i;
                        for (let i = 1; i < messageContentLines.length; i++) {
                            const currentBonkLine = messageContentLines[i].trim();
                            if (!currentBonkLine) continue;
                            const bonkMatchResult = currentBonkLine.match(bonkPattern);
                            if (bonkMatchResult) {
                                const bonkerNameInText = bonkMatchResult[1];
                                const bonkedVictimName = bonkMatchResult[2];
                                const bonkCategory = bonkMatchResult[3].toLowerCase();
                                if (usersFromFinalLineForValidation.has(bonkedVictimName.toLowerCase())) {
                                    validationErrorMessages.push(`Error: User "${bonkedVictimName}" in "Final:" list cannot be "bonked".`);
                                    continue;
                                }
                                if (bonkersInMessageText.length < 5) bonkersInMessageText.push(bonkerNameInText);
                                if (bonkCategory === 'primary') bonkedUsersData.primary.add(bonkedVictimName);
                                else if (bonkCategory === 'secondary') bonkedUsersData.secondary.add(bonkedVictimName);
                                else if (bonkCategory === 'tertiary') bonkedUsersData.tertiary.add(bonkedVictimName);
                                console.log(`Bonk: ${bonkerNameInText} bonked ${bonkedVictimName} (${bonkCategory})`);
                            } else if (currentBonkLine) console.log(`Line not bonk: "${currentBonkLine}"`);
                        }
                        finalBlockFoundAndProcessed = true;
                        break;
                    }
                }

                if (validationErrorMessages.length > 0) {
                    await message.channel.send(`Errors found:\n- ${validationErrorMessages.join('\n- ')}\n\nPlease correct and retry. Nothing saved.`);
                    return;
                }
                if (!isAssertionRecord && !finalBlockFoundAndProcessed && validationErrorMessages.length === 0) {
                    await message.channel.send('"Final:" message not found for normal record. Nothing processed (OO Link might be found).');
                }
            }

            const rowData = {
                [PROPOSAL_COLUMN_HEADER]: proposalNumber,
                'Type (PM / Snap, etc)': typeColumn,
                'OO Link': ooLink,
                'Primary': primaryUser,
                'Secondary': secondaryUser,
                'Tertiary': terciaryUser,
                'Closer': closerUser,
                'Recorder': recorderUser,
                'Disputed? (y?)': disputedColumn,
                'bonker 1': bonkersInMessageText[0] || "",
                'bonker 2': bonkersInMessageText[1] || "", 
                'bonker 3': bonkersInMessageText[2] || "",
                'bonker 4': bonkersInMessageText[3] || "",
                'bonker 5': bonkersInMessageText[4] || "",
                'BONKED 1': Array.from(bonkedUsersData.primary).join(', ') || "",
                'BONKED 2': Array.from(bonkedUsersData.secondary).join(', ') || "",
                'BONKED 3': Array.from(bonkedUsersData.tertiary).join(', ') || ""
            };
            
            if (!doc) {
                await message.channel.send("Error: Google Sheets connection not configured.");
                return;
            }

            const result = await upsertSpreadsheetRow(proposalNumber, rowData);
            if (result.success) {
                const ooLinkDiscordFormat = ooLink === "" ? "Not found" : `[here](${ooLink})`;
                let actionMsg = result.action === 'updated' ? 'updated' : 'added';
                let response = `Ticket data ${actionMsg} in Google Sheets!\n**Proposal:** ${proposalNumber}\n`;
                if (typeColumn) response += `**Type:** ${typeColumn}\n`;
                response += `**OO Link:** ${ooLinkDiscordFormat}\n`;
                if (disputedColumn === 'y') response += `**Disputed:** ${disputedColumn}\n`;
                else if (!isAssertionRecord) {
                    response += `**P/S/T:** ${primaryUser||'-'}/${secondaryUser||'-'}/${terciaryUser||'-'}\n` +
                                `**Closer:** ${closerUser||'-'}, **Recorder:** ${recorderUser}\n` +
                                `**Bonkers:** ${bonkersInMessageText.join(', ')||'None'}\n` +
                                `**BONKED P:** ${Array.from(bonkedUsersData.primary).join(', ')||'None'}\n` +
                                `**BONKED S:** ${Array.from(bonkedUsersData.secondary).join(', ')||'None'}\n` +
                                `**BONKED T:** ${Array.from(bonkedUsersData.tertiary).join(', ')||'None'}`;
                }
                await message.channel.send(response);
                const ticketToolCloseCommand = process.env.TICKET_TOOL_CLOSE_COMMAND;
                if (ticketToolCloseCommand) {
                    try {
                        await message.channel.send(ticketToolCloseCommand);
                        console.log(`Sent TT close command: ${ticketToolCloseCommand}`);
                    } catch (closeCmdError) {
                        console.error('Error sending TT close command:', closeCmdError);
                        await message.channel.send("Saved to sheet, but failed to send close command.");
                    }
                } else console.log("TICKET_TOOL_CLOSE_COMMAND not in .env.");
            } else await message.channel.send("Error saving to Google Sheets. Check bot console.");
        } catch (error) {
            console.error('Error processing record command:', error);
            await message.channel.send('Major error during command processing.');
        }
    }
});

// Login to Discord
if (DISCORD_TOKEN && GOOGLE_SHEET_ID && GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY) {
    client.login(DISCORD_TOKEN)
        .then(() => console.log('Successfully logged into Discord.'))
        .catch(err => {
            console.error('Failed to log into Discord:', err);
            if (err.code==='TokenInvalid' || (err.message && err.message.includes('Privileged Intents')))
                console.error("CHECK TOKEN & INTENTS (GUILD_MESSAGES, MESSAGE_CONTENT) IN DISCORD DEV PORTAL.");
        });
} else {
    let missing = [];
    if (!DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
    if (!GOOGLE_SHEET_ID) missing.push("GOOGLE_SHEET_ID");
    if (!GOOGLE_SERVICE_ACCOUNT_EMAIL) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL");
    if (!GOOGLE_PRIVATE_KEY) missing.push("GOOGLE_PRIVATE_KEY");
    console.error(`Error: Critical env vars missing: ${missing.join(', ')}.`);
    if (!doc) console.error("Bot cannot interact with Google Sheets.");
}