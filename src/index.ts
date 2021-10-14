import { ShardingManager } from "discord.js";
import auth from "./config/auth";
import config from "./config/config";
import Console from "./Internals/Console";

// Master process -- assigned a variable as it will come in handy later
// Main IPC process
const sharder = new ShardingManager("./DTel", {
	totalShards: config.shardCount,
	token: auth.discord.token,
});

const winston = Console("Master");

sharder.on("shardCreate", shard => {
	winston.info(`Spawned shard ID: ${shard.id}`);
});

winston.info("Spawning shards...");
sharder.spawn();
