// deploy-commands.js
require("dotenv").config();
const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");

const BOT_ID = process.env.BOT_ID; // Client ID
const GUILD_ID = process.env.GUILD_ID; // Optional: Client ID for testing
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!BOT_ID || !DISCORD_TOKEN) {
  console.error(
    "Error: BOT_ID or DISCORD_TOKEN is missing in .env for deploy-commands.js."
  );
  process.exit(1);
}

const configCommand = new SlashCommandBuilder()
  .setName("config")
  .setDescription("Configure bot settings for this server.")
  .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set_processing_interval")
      .setDescription(
        "Set how often tickets are processed (e.g., 30m, 1h, 2h30m)."
      )
      .addStringOption((option) =>
        option
          .setName("interval")
          .setDescription(
            "Processing interval (e.g., '30m', '1h', '90m'). Min 1 minute."
          )
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set_post_processing_action")
      .setDescription("Set the default action when a ticket is processed.")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription('The action to perform: "none", "close" or "delete".')
          .setRequired(true)
          .addChoices(
            { name: "Do nothing", value: "none" },
            { name: "Close Ticket ($close)", value: "close" },
            { name: "Delete Ticket ($delete)", value: "delete" }
          )
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("toggle_auto_processing")
      .setDescription("Enable or disable automatic ticket processing.")
      .addBooleanOption((option) =>
        option
          .setName("enabled")
          .setDescription("Set to true to enable, false to disable.")
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set_min_ticket_age")
      .setDescription(
        "Set min ticket age for auto-processing (e.g., 30m, 2h5m, 1d)."
      )
      .addStringOption((option) =>
        option
          .setName("age")
          .setDescription("Minimum age (e.g., 30m,  2h5m, 125m, 1d).")
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set_error_user")
      .setDescription(
        "Set the user to ping when an error occurs during processing."
      )
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("The user to notify on errors.")
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("view_settings")
      .setDescription("View the current bot configuration for this server.")
  );

const scanStatusCommand = new SlashCommandBuilder()
  .setName("scan_status")
  .setDescription("Shows when the next automatic ticket scan is scheduled.")
  .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator);

const statsCommand = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Get statistics from the processed data.")
  .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("closers")
      .setDescription("Counts how many tickets each user has closed.")
      .addIntegerOption((option) =>
        option
          .setName("start_order")
          .setDescription("Optional: The order # to start counting from.")
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName("end_order")
          .setDescription("Optional: The order # to end counting at.")
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("primary")
      .setDescription("Counts how many tickets each user has participated in as Primary.")
      .addIntegerOption((option) =>
        option
          .setName("start_order")
          .setDescription("Optional: The order # to start counting from.")
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName("end_order")
          .setDescription("Optional: The order # to end counting at.")
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("secondary")
      .setDescription("Counts how many tickets each user has participated in as Secondary.")
      .addIntegerOption((option) =>
        option
          .setName("start_order")
          .setDescription("Optional: The order # to start counting from.")
          .setRequired(false)
      )
      .addIntegerOption((option) => 
        option
          .setName("end_order")
          .setDescription("Optional: The order # to end counting at.")
          .setRequired(false)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("tertiary")
      .setDescription("Counts how many tickets each user has participated in as Tertiary.")
      .addIntegerOption((option) =>
        option
          .setName("start_order")
          .setDescription("Optional: The order # to start counting from.")
          .setRequired(false)
      )
      .addIntegerOption((option) =>
        option
          .setName("end_order")
          .setDescription("Optional: The order # to end counting at.")
          .setRequired(false)
      )
  );

const commands = [configCommand.toJSON(), scanStatusCommand.toJSON(), statsCommand.toJSON()];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log(
      `Started refreshing ${commands.length} application (/) commands.`
    );

    if (GUILD_ID) {
      // For testing: More faster
      console.log(`Registering commands for guild: ${GUILD_ID}`);
      await rest.put(Routes.applicationGuildCommands(BOT_ID, GUILD_ID), {
        body: commands,
      });
      console.log(`Successfully registered commands for guild ${GUILD_ID}.`);
    } else {
      // For production: need at least 1 hour to propagate
      console.log("Registering commands globally.");
      await rest.put(Routes.applicationCommands(BOT_ID), { body: commands });
      console.log("Successfully registered commands globally.");
    }
  } catch (error) {
    console.error("Error reloading application (/) commands:", error);
  }
})();
