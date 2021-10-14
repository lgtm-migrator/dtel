import { MessageEmbedOptions } from "discord.js";
import { Schema } from "mongoose";

export interface DTelNumber {
	_id: string,
	channel: string,
	blocked: string[],
	contacts: string[],
	expiry: Date,
	promote: Promote,
	vip: {
		expiry: Date,
		hidden: boolean,
		name: string,
	},
	waiting: boolean,
}

interface Promote {
	embed: MessageEmbedOptions,
	lastEdited: Date,
	lastPromoted: Date,
	lastMsg: string,
	lastUsr: Date,
}

export default new Schema<DTelNumber>({
	_id: {
		required: true,
		type: String,
	},
	channel: {
		required: true,
		type: String,
	},
	blocked: [{
		default: [],
		type: Schema.Types.Array,
	}],
	contacts: [{
		default: [],
		type: Schema.Types.Array,
	}],
	expiry: [{
		default: Schema.Types.Date,
		required: true,
	}],
	promote: {
		embed: Schema.Types.Array,
		lastEdited: Date,
		lastPromoted: Date,
		lastMsg: String,
		lastUsr: Date,
	},
	vip: {
		expiry: Date,
		hidden: Boolean,
		name: String,
	},
	waiting: Boolean,
});
