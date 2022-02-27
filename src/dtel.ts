import { Interaction } from "discord.js";
import i18next from "i18next";

import config from "./config/config";
import init, { DTelDatabase } from "./database/database";
import i18ndata from "./internationalization/i18n";
import Client from "./internals/client";
import Console from "./internals/console";

import ReadyEvent from "./events/ready";
import InteractionEvent from "./events/interaction";

const winston = Console(`Shard ${process.env.SHARDS}`);

let db: DTelDatabase;

try {
	db = init();
	winston.info("Initialized database.");
} catch (err) {
	console.error(`Failed to connect to MongoDB.\n ${err.stack}`);
	process.exit(-1);
}


i18next.init({
	debug: config.devMode,
	fallbackLng: "en-US",
	preload: ["en-US"],

	returnObjects: true,
	resources: i18ndata,
});

const client = new Client({
	intents: [
		"GUILD_MESSAGES",
		"GUILDS",
		"GUILD_VOICE_STATES",
		"DIRECT_MESSAGES",
	],
	partials: ["CHANNEL"],

	constantVariables: {
		db,
		winston,
	},
});


client.on("ready", () => ReadyEvent(client));

// client.on("messageCreate", (msg: Message) => MessageCreateEvent(msg));
client.on("interactionCreate", (interaction: Interaction) => InteractionEvent(client, interaction));
// client.on("guildCreate", (guild: Guild) => GuildCreateEvent(guild));
// client.on("guildDelete", (guild: Guild) => GuildDeleteEvent(guild));

client.login(process.env.TOKEN);