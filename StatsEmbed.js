const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

class StatsEmbed {
  constructor(config) {
    this.config = config;
    this.name = "StatsEmbed Plugin";
    this.interval = null;
    this.serverInstance = null;
    this.discordClient = null;
    this.channel = null;
    this.message = null;
    this.statsTable = null;
    this.playersTable = null;
    this.ignoreList = []; // Holds the array of playerUIDs to ignore.
  }

  async prepareToMount(serverInstance, discordClient) {
    logger.verbose(`[${this.name}] Preparing to mount...`);
    this.serverInstance = serverInstance;
    this.discordClient = discordClient;

    try {
      if (!process.mysqlPool) {
        logger.error(`[${this.name}] MySQL pool is not available.`);
        return;
      }

      // Validate StatsEmbed configuration.
      const pluginConfig = this.config.plugins.find(p => p.plugin === "StatsEmbed");
      if (!pluginConfig || !pluginConfig.enabled) {
        logger.warn(`[${this.name}] Plugin is disabled in the configuration.`);
        return;
      }
      if (!pluginConfig.channel) {
        logger.error(`[${this.name}] No channel ID provided in the configuration.`);
        return;
      }
      this.channelId = pluginConfig.channel;

      // Retrieve table names from configuration.
      if (!pluginConfig.statsTable) {
        logger.error(`[${this.name}] statsTable not specified in configuration.`);
        return;
      }
      if (!pluginConfig.playersTable) {
        logger.error(`[${this.name}] playersTable not specified in configuration.`);
        return;
      }
      this.statsTable = pluginConfig.statsTable;
      this.playersTable = pluginConfig.playersTable;

      // Retrieve the ignore list from configuration (if provided).
      this.ignoreList = pluginConfig.ignoreList || [];

      // Check that the required tables exist.
      let [playersTableResult] = await process.mysqlPool.query("SHOW TABLES LIKE ?", [this.playersTable]);
      if (!playersTableResult || playersTableResult.length === 0) {
        logger.error(`[${this.name}] Required table '${this.playersTable}' does not exist.`);
        return;
      }
      let [statsTableResult] = await process.mysqlPool.query("SHOW TABLES LIKE ?", [this.statsTable]);
      if (!statsTableResult || statsTableResult.length === 0) {
        logger.error(`[${this.name}] Required table '${this.statsTable}' does not exist.`);
        return;
      }

      // Fetch the guild and channel/thread.
      const guild = await this.discordClient.guilds.fetch(
        this.config.connectors.discord.guildId,
        { cache: true, force: true }
      );
      const channelOrThread = await guild.channels.fetch(this.channelId);
      if (!channelOrThread) {
        logger.error(`[${this.name}] Unable to find channel or thread with ID ${this.channelId}.`);
        return;
      }
      if (channelOrThread.isThread()) {
        this.channel = channelOrThread;
      } else if (channelOrThread.isTextBased()) {
        this.channel = channelOrThread;
      } else {
        logger.error(`[${this.name}] The specified channel is not a valid text channel or thread.`);
        return;
      }

      // Check bot permissions.
      const permissions = this.channel.permissionsFor(this.discordClient.user);
      if (!permissions) {
        logger.error(`[${this.name}] Unable to determine bot permissions for the channel.`);
        return;
      }
      const requiredPermissions = ["ViewChannel", "SendMessages", "EmbedLinks"];
      const missingPermissions = requiredPermissions.filter(perm => !permissions.has(perm));
      if (missingPermissions.length > 0) {
        logger.error(
          `[${this.name}] Bot is missing the following permissions: ${missingPermissions.join(", ")}.`
        );
        return;
      }

      // Handle message ID: if a non-empty messageID exists, try to fetch it.
      // Otherwise, post a new embed.
      if (pluginConfig.messageID && pluginConfig.messageID.trim().length > 0) {
        try {
          this.message = await this.channel.messages.fetch(pluginConfig.messageID);
        } catch (error) {
          logger.warn(`[${this.name}] Message with ID ${pluginConfig.messageID} not found. Posting a new one.`);
          this.message = await this.postInitialEmbed();
        }
      } else {
        this.message = await this.postInitialEmbed();
      }

      // Immediately update the embed.
      await this.updateEmbed();

      // Start the update interval.
      const intervalMinutes = pluginConfig.interval || 5;
      this.interval = setInterval(() => this.updateEmbed(), intervalMinutes * 60 * 1000);
      logger.info(`[${this.name}] Initialized and updating embed every ${intervalMinutes} minutes.`);
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization: ${error.message}`);
    }
  }

  async postInitialEmbed() {
    try {
      const pluginConfig = this.config.plugins.find(p => p.plugin === "StatsEmbed");
      const embedConfig = pluginConfig.embed || {};
      const embed = new EmbedBuilder()
        .setTitle(embedConfig.title || "Stats Leaderboard")
        .setDescription("Loading stats...")
        .setColor(embedConfig.color || "#FFA500")
        .addFields(
          { name: "**Most Playtime**", value: "Loading...", inline: true },
          { name: "**Most Kills**", value: "Loading...", inline: true },
          { name: "**Most Deaths**", value: "Loading...", inline: true },
          { name: "\u200B", value: "\u200B", inline: false },
          { name: "**Most Roadkills**", value: "Loading...", inline: true },
          { name: "**Best Medics**", value: "Loading...", inline: true },
          { name: "**Professional Bus Drivers**", value: "Loading...", inline: true }
        );
      if (embedConfig.footer) {
        embed.setFooter({ text: embedConfig.footer });
      }
      if (embedConfig.thumbnail && embedConfig.thumbnailURL) {
        embed.setThumbnail(embedConfig.thumbnailURL);
      }
      const message = await this.channel.send({ embeds: [embed] });
      logger.verbose(`[${this.name}] Posted initial embed with message ID: ${message.id}`);
      // Save the message ID to the config.
      if (pluginConfig) {
        pluginConfig.messageID = message.id;
        await this.saveConfig();
      }
      return message;
    } catch (error) {
      logger.error(`[${this.name}] Failed to post initial embed: ${error.message}`);
      throw error;
    }
  }

  async saveConfig() {
    try {
      const configPath = path.resolve(__dirname, "../../config.json");
      const updatedConfig = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(configPath, updatedConfig, "utf8");
      logger.info(`[${this.name}] Configuration updated and saved.`);
    } catch (error) {
      logger.error(`[${this.name}] Failed to save configuration: ${error.message}`);
    }
  }

  async updateEmbed() {
    try {
      // Helper function to format numbers with commas.
      const formatNumber = (num) => Number(num).toLocaleString('en-US');

      // Retrieve overall stats.
      const [playersRows] = await process.mysqlPool.query(
        `SELECT COUNT(*) AS total_players FROM \`${this.playersTable}\``
      );
      const [killsRows] = await process.mysqlPool.query(
        `SELECT SUM(kills) AS total_player_kills FROM \`${this.statsTable}\``
      );
      const [deathsRows] = await process.mysqlPool.query(
        `SELECT SUM(deaths) AS total_player_deaths FROM \`${this.statsTable}\``
      );
      const [aiKillsRows] = await process.mysqlPool.query(
        `SELECT SUM(ai_kills) AS total_ai_kills FROM \`${this.statsTable}\``
      );
      const [shotsRows] = await process.mysqlPool.query(
        `SELECT SUM(shots) AS total_shots FROM \`${this.statsTable}\``
      );
      const [distanceRows] = await process.mysqlPool.query(
        `SELECT SUM(distance_walked) AS total_distance FROM \`${this.statsTable}\``
      );

      const totalPlayers = playersRows[0].total_players || 0;
      const totalPlayerKills = killsRows[0].total_player_kills || 0;
      const totalPlayerDeaths = deathsRows[0].total_player_deaths || 0;
      const totalAIKills = aiKillsRows[0].total_ai_kills || 0;
      const totalShots = shotsRows[0].total_shots || 0;
      const totalDistanceMeters = distanceRows[0].total_distance || 0;
      const totalDistanceKm = (totalDistanceMeters / 1000).toFixed(2);

      // Format overall stats with commas.
      const totalPlayersFormatted = formatNumber(totalPlayers);
      const totalPlayerKillsFormatted = formatNumber(totalPlayerKills);
      const totalPlayerDeathsFormatted = formatNumber(totalPlayerDeaths);
      const totalAIKillsFormatted = formatNumber(totalAIKills);
      const totalShotsFormatted = formatNumber(totalShots);
      const totalDistanceKmFormatted = totalDistanceKm; // Keep two decimals

      // Build the ignore clause and parameters for SQL queries.
      const ignoreClause = (this.ignoreList && this.ignoreList.length > 0)
        ? `WHERE playerUID NOT IN (${this.ignoreList.map(() => '?').join(',')})`
        : "";
      const ignoreParams = (this.ignoreList && this.ignoreList.length > 0)
        ? this.ignoreList
        : [];

      // Retrieve top 5 players for each stat category, applying the ignore list.
      const [playtimeResults] = await process.mysqlPool.query(
        `SELECT playerUID, session_duration FROM \`${this.statsTable}\` ${ignoreClause} ORDER BY session_duration DESC LIMIT 5`,
        ignoreParams
      );
      const [topKillsResults] = await process.mysqlPool.query(
        `SELECT playerUID, kills FROM \`${this.statsTable}\` ${ignoreClause} ORDER BY kills DESC LIMIT 5`,
        ignoreParams
      );
      const [topDeathsResults] = await process.mysqlPool.query(
        `SELECT playerUID, deaths FROM \`${this.statsTable}\` ${ignoreClause} ORDER BY deaths DESC LIMIT 5`,
        ignoreParams
      );
      const [topRoadkillsResults] = await process.mysqlPool.query(
        `SELECT playerUID, roadkills FROM \`${this.statsTable}\` ${ignoreClause} ORDER BY roadkills DESC LIMIT 5`,
        ignoreParams
      );
      const [medicsResults] = await process.mysqlPool.query(
        `SELECT playerUID, (bandage_friendlies + tourniquet_friendlies + saline_friendlies + morphine_friendlies) AS medics FROM \`${this.statsTable}\` ${ignoreClause} ORDER BY medics DESC LIMIT 5`,
        ignoreParams
      );
      const [busDriverResults] = await process.mysqlPool.query(
        `SELECT playerUID, points_as_driver_of_players FROM \`${this.statsTable}\` ${ignoreClause} ORDER BY points_as_driver_of_players DESC LIMIT 5`,
        ignoreParams
      );

      // Helper: get player name.
      const playersTable = this.playersTable;
      const getPlayerName = async (playerUID) => {
        try {
          const [rows] = await process.mysqlPool.query(
            `SELECT playerName FROM \`${playersTable}\` WHERE playerUID = ?`,
            [playerUID]
          );
          return rows.length > 0 && rows[0].playerName ? rows[0].playerName : "Unknown";
        } catch (err) {
          return "Unknown";
        }
      };

      // Helper: convert seconds to HH:MM:SS.
      const secondsToHMS = (seconds) => {
        seconds = Number(seconds);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return [h, m, s].map(v => v < 10 ? "0" + v : v).join(":");
      };

      // Helper: build field string.
      const buildFieldString = async (results, statKey, label, isTime = false) => {
        let lines = [];
        let rank = 1;
        for (const row of results) {
          const playerName = await getPlayerName(row.playerUID);
          let statValue = row[statKey];
          if (isTime) {
            statValue = secondsToHMS(statValue);
          } else if (typeof statValue === 'number') {
            statValue = formatNumber(statValue);
          }
          lines.push(`**#${rank}** - ${label}: ${statValue} - ${playerName}`);
          rank++;
        }
        return lines.join("\n");
      };

      const playtimeField = await buildFieldString(playtimeResults, "session_duration", "Time", true);
      const killsField = await buildFieldString(topKillsResults, "kills", "Kills");
      const deathsField = await buildFieldString(topDeathsResults, "deaths", "Deaths");
      const roadkillsField = await buildFieldString(topRoadkillsResults, "roadkills", "Kills");
      const medicsField = await buildFieldString(medicsResults, "medics", "Points");
      const busDriversField = await buildFieldString(busDriverResults, "points_as_driver_of_players", "Points");

      // Add descriptions for the last three fields.
      const roadkillsDescription = "*Enemies killed with a vehicle*";
      const medicsDescription = "*Points for healing Friendlies*";
      const busDriversDescription = "*Points for driving other players*";

      // Construct embed description.
      const description = `**Global Stats**\n---------------\n**🔸 Total Players:** ${totalPlayersFormatted}\n**🔸 Total Player Kills:** ${totalPlayerKillsFormatted}\n**🔸 Total Player Deaths:** ${totalPlayerDeathsFormatted}\n**🔸 Total AI Kills:** ${totalAIKillsFormatted}\n**🔸 Round Fired:** ${totalShotsFormatted}\n**🔸 Distance Walked:** ${totalDistanceKmFormatted} Km\n`;

      // Build the embed.
      const embed = new EmbedBuilder()
        .setDescription(description)
        .addFields(
          { name: "**Most Playtime**", value: playtimeField || "No Data", inline: true },
          { name: "**Most Kills**", value: killsField || "No Data", inline: true },
          { name: "**Most Deaths**", value: deathsField || "No Data", inline: true },
          { name: "\u200B", value: "\u200B", inline: false },
          { name: "**Most Roadkills**", value: roadkillsDescription + "\n" + (roadkillsField || "No Data"), inline: true },
          { name: "**Best Medics**", value: medicsDescription + "\n" + (medicsField || "No Data"), inline: true },
          { name: "**Bus Drivers**", value: busDriversDescription + "\n" + (busDriversField || "No Data"), inline: true }
        )
        .setTimestamp();

      // Apply embed configuration options.
      const embedConfig = this.config.plugins.find(p => p.plugin === "StatsEmbed").embed || {};
      if (embedConfig.title) {
        embed.setTitle(embedConfig.title);
      }
      if (embedConfig.color) {
        embed.setColor(embedConfig.color);
      }
      if (embedConfig.footer) {
        embed.setFooter({ text: embedConfig.footer });
      }
      if (embedConfig.thumbnail && embedConfig.thumbnailURL) {
        embed.setThumbnail(embedConfig.thumbnailURL);
      }

      await this.message.edit({ embeds: [embed] });
      logger.verbose(`[${this.name}] Updated stats embed.`);
    } catch (error) {
      logger.error(`[${this.name}] Error updating embed: ${error.message}`);
    }
  }

  async cleanup() {
    logger.verbose(`[${this.name}] Cleaning up...`);
    if (this.interval) {
      clearInterval(this.interval);
      logger.verbose(`[${this.name}] Cleared update interval.`);
    }
    logger.info(`[${this.name}] Cleanup completed.`);
  }
}

module.exports = StatsEmbed;
