import DTelClient from "./client";
import { getFixedT, TFunction } from "i18next";
import { v4 as uuidv4 } from "uuid";
import { ActionRowBuilder, ButtonBuilder, Client, CommandInteraction, EmbedBuilder, Message, MessageComponentInteraction, PermissionsBitField, Typing, MessageCreateOptions } from "discord.js";
import { PermissionLevel } from "../interfaces/commandData";
import { Calls, Numbers, atAndBy, CallMessages, onHold } from "@prisma/client";
import { db } from "../database/db";
import config from "../config/config";
import { APIEmbed, APIMessage, ButtonStyle, RESTGetAPIChannelMessageResult } from "discord-api-types/v10";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { parseNumber } from "./utils";
import { NumbersWithGuilds } from "../interfaces/numbersWithGuilds";
import { winston } from "../dtel";

dayjs.extend(relativeTime);

type CallSide = "from" | "to";

interface CallOptions {
	from: string,
	to: string,
	random: boolean,
	startedBy: string,
	vip?: {
		expiry: Date,
		hiddenNumberDisplay: boolean,
		customCallerDisplay: string
	}
}

type CallsWithNumbers = Calls & {
	to: Numbers,
	from: Numbers,
};

interface ClientCallParticipant extends NumbersWithGuilds {
	locale: string,
	t: TFunction,
}

type CallsWithNumbersAndGuilds = Calls & {
	to: NumbersWithGuilds,
	from: NumbersWithGuilds,
};


export { CallsWithNumbers };

export default class CallClient implements CallsWithNumbers {
	primary = false;

	id: string = uuidv4();
	toNum = "";
	fromNum = "";
	to!: ClientCallParticipant;
	from!: ClientCallParticipant;
	pickedUp: atAndBy | null = null;
	randomCall = false;
	started!: { at: Date, by: string };
	ended: atAndBy | null = null;
	hold: onHold = {
		onHold: false,
		holdingSide: null,
	};
	active = true;

	// Map of original message ID to message object
	// Will normally cache only messages handled by this shard unless a restart occurs
	messageCache = new Map<string, CallMessages>();
	otherSideShardID = 0;

	client: DTelClient;

	constructor(client: DTelClient, options?: CallOptions, dbCallDoc?: Calls) {
		this.client = client;

		if (dbCallDoc) {
			Object.assign(this, dbCallDoc);

			if (!this.pickedUp?.by) this.setupPickupTimer();

			return;
		}
		options = options as CallOptions; // Strict mode avoider

		this.fromNum = options.from;
		this.toNum = options.to;

		this.randomCall = options.random;
		this.started = {
			by: options.startedBy,
			at: new Date(),
		};
	}

	static async byID(client: DTelClient, options: { id?: string, doc?: callMissingChannel | null, side: CallSide }): Promise<CallClient> {
		if (!options.doc) {
			options.doc = await client.db.calls.findUnique({
				where: {
					id: options.id,
				},
				include: {
					to: {
						include: {
							guild: true,
						},
					},
					from: {
						include: {
							guild: true,
						},
					},
				},
			});
		}

		if (!options.doc) {
			throw new Error("Call not found or not provided");
		}

		if (!options.doc.to || !options.doc.from) {
			await CallClient.prematureEnd(options.doc);
		}

		// Preflight checks done, we are sure there's a call and that we know about both number
		const callDoc = options.doc as CallsWithNumbersAndGuilds;

		const callManager = new CallClient(client, undefined, callDoc);
		callManager.primary = options.side === "from";
		callManager.otherSideShardID = await client.shardIdForChannelId(options.side === "from" ? callDoc.to.channelID : callDoc.from.channelID);


		const toLocale = callDoc.to.guild?.locale || "en-US";
		const fromLocale = callDoc.from.guild?.locale || "en-US";

		callManager.to.t = getFixedT(toLocale, undefined, "commands.call");
		callManager.from.t = getFixedT(fromLocale, undefined, "commands.call");

		callManager.to.locale = toLocale;
		callManager.from.locale = fromLocale;

		const allMessages = await db.callMessages.findMany({
			where: {
				callID: callDoc.id,
			},
		});

		for (const msg of allMessages) {
			callManager.messageCache.set(msg.originalMessageID, msg);
		}

		return callManager;
	}

	get timeElapsed(): string {
		return dayjs(this.started.at).fromNow(true);
	}

	toSend(payload: MessageCreateOptions): Promise<APIMessage> {
		return this.client.sendCrossShard(payload, this.to.channelID);
	}
	fromSend(payload: MessageCreateOptions): Promise<APIMessage> {
		return this.client.sendCrossShard(payload, this.from.channelID);
	}

	async initiate(): Promise<void> {
		this.primary = true;

		// Get the number in the correct format for DB query (all numbers)
		this.toNum = parseNumber(this.toNum);
		const aliasNumbers = config.aliasNumbers as { [key: string] : string };
		if (aliasNumbers[this.toNum]) this.toNum = aliasNumbers[this.toNum];
		if (this.toNum.length != 11) throw new Error("numberInvalid");

		if (this.fromNum === this.toNum) throw new Error("callingSelf");

		// Get both numbers in one query (clean code)
		const participants = await db.numbers.findMany({
			where: {
				OR: [{
					number: this.toNum,
				}, {
					number: this.fromNum,
				}],
			},
			include: {
				incomingCalls: {
					where: {
						active: true,
					},
				},
				outgoingCalls: {
					where: {
						active: true,
					},
				},
				guild: true,
			},
		});


		const fromNumber = participants.find(p => p.number === this.fromNum);
		if (!fromNumber) throw new Error("invalidFrom");
		this.from = {
			...fromNumber,

			locale: fromNumber.guild?.locale || "en-US",
			t: getFixedT(fromNumber.guild?.locale || "en-US", undefined, "commands.call"),
		};

		if (this.from.expiry < new Date()) throw new Error("thisSideExpired");

		const toNumber = participants.find(p => p.number === this.toNum);

		// Preflight checks
		if (!toNumber) throw new Error("otherSideNotFound");
		if (toNumber.expiry < new Date()) throw new Error("otherSideExpired");
		if (toNumber.blocked.includes(this.from.number)) throw new Error("otherSideBlockedYou");

		if (toNumber.incomingCalls.length > 0 || toNumber.outgoingCalls.length > 0) {
			throw new Error("otherSideInCall");
		}

		this.to = {
			...toNumber,

			locale: toNumber.guild?.locale || "en-US",
			t: getFixedT(toNumber.guild?.locale || "en-US", undefined, "commands.call"),
		};

		// TODO: Check for pre-existing calls and do embed stuff
		// and that includes stuff like call-waiting

		// Don't bother sending it if we can find it on this shard
		try {
			await this.client.channels.fetch(this.to.channelID);
		} catch {
			// Send the call to another shard if required
			// This is probably the best way to do it as it tells us if it was successful
			this.otherSideShardID = await this.client.shardIdForChannelId(this.to.channelID);

			if (!this.otherSideShardID) {
				await db.calls.delete({
					where: {
						id: this.id,
					},
				});
				throw new Error("numberMissingChannel");
			}

			// THIS CAN THROW callNotFound
			await this.client.shard?.broadcastEval<void, string>(async(_client: Client, context: string): Promise<void> => {
				const client = _client as DTelClient;
				client.calls.set(context, await require(`${__dirname}/../internals/callClient`).default.byID(client, {
					id: context,
					side: "to",
				}));
			}, {
				shard: this.otherSideShardID,
				context: this.id,
			});
		}

		let fromCallerDisplay = this.from.number;
		if (Number(this.from.vip?.expiry) > Date.now()) {
			if (this.from.vip?.name) fromCallerDisplay = this.from.vip?.name;
			else if (this.from.vip?.hidden) fromCallerDisplay = "Hidden";
		}

		let notificationMessageID: string;
		try {
			notificationMessageID = (await this.toSend({
				content: this.to.number === config.aliasNumbers["*611"] ? `<@${config.supportGuild.roles.customerSupport}>` : "",

				embeds: [{
					color: this.client.config.colors.info,

					...(this.to.t("incomingCall", {
						number: fromCallerDisplay,
						callID: this.id,
					}) as APIEmbed),
				}],
				components: [
					new ActionRowBuilder<ButtonBuilder>()
						.addComponents([
							new ButtonBuilder({
								customId: "call-pickup",
								label: this.to.t("pickup")!,
								style: ButtonStyle.Primary,
								emoji: "📞",
							}),
							new ButtonBuilder({
								customId: "call-hangup",
								label: this.to.t("hangup")!,
								style: ButtonStyle.Secondary,
								emoji: "☎️",
							}),
						]),
				],
			})).id;
		} catch (err: unknown) {
			this.fromSend({
				embeds: [
					this.client.errorEmbed(this.from.t("errors.couldntReachOtherSide")),
				],
			});

			return;
		}

		await db.calls.create({
			data: {
				...this,
				client: undefined,
				otherSideShardID: undefined,
				primary: undefined,
				to: undefined,
				from: undefined,
				messages: undefined,
				messageCache: undefined,
			},
		});
		this.client.calls.set(this.id, this);

		if (!this.primary || config.shardCount == 1) this.setupPickupTimer(notificationMessageID);
	}


	async setupPickupTimer(callNotifMsgID?: string): Promise<void> {
		setTimeout(async() => {
			if (this.pickedUp?.by) return;

			try {
				if (callNotifMsgID) {
					const callMsg = await this.client.rest.get(`/channels/${this.to.channelID}/messages/${callNotifMsgID}`) as RESTGetAPIChannelMessageResult;
					await this.client.editCrossShard({
						embeds: callMsg.embeds,
						components: [],
					}, this.to.channelID, callNotifMsgID);
				}

				this.toSend({
					embeds: [this.to.t("missedCall.toSide") as APIEmbed],
				});

				const fromEmbed = EmbedBuilder.from(this.from.t("missedCall.fromSide") as APIEmbed);
				const toMailbox = await db.mailbox.findFirst({
					where: {
						number: this.to.number,
					},
				});

				if (toMailbox) {
					const mailboxFull = toMailbox?.messages.length > 25;

					let reply = `${toMailbox.autoreply}`;

					if (mailboxFull) reply += " (Mailbox full)";

					fromEmbed.addFields([{
						name: this.from.t("answeringMachine"),
						value: reply,
					}]);
				}

				const canSendMessage = toMailbox?.receiving && toMailbox?.messages.length < 25;

				this.fromSend({
					embeds: [fromEmbed],
					components: canSendMessage ? [new ActionRowBuilder<ButtonBuilder>().addComponents([
						new ButtonBuilder()
							.setCustomId(`mailbox-send-initiate-${this.toNum}`)
							.setEmoji("📬")
							.setLabel(this.from.t("sendMessage"))
							.setStyle(ButtonStyle.Primary),
					])] : undefined,
				});
			} catch {
				// Ignore
			}

			this.endHandler("missed");
		// }, 2 * 60 * 1000);
		}, 0.001 * 60 * 1000);
	}

	async pickup(interaction: MessageComponentInteraction): Promise<void> {
		this.pickedUp = {
			at: new Date(),
			by: interaction.user.id,
		};

		await this.client.editCrossShard({
			embeds: interaction.message.embeds,
			components: [],
		}, interaction.channelId, interaction.message.id).catch(() => null);


		if (this.otherSideShardID) {
			type ctx = { callID: string, pickedUp: atAndBy };
			await this.client.shard?.broadcastEval<void, ctx>(async(_client, context): Promise<void> => {
				const client = _client as DTelClient;
				const callHandler = client.calls.find(c => c.id === context.callID);
				if (!callHandler) throw new Error("No handler");

				callHandler.pickedUp = {
					at: new Date(context.pickedUp.at),
					by: context.pickedUp.by,
				};
			}, {
				shard: this.otherSideShardID,
				context: {
					callID: this.id,
					pickedUp: this.pickedUp,
				},
			});
		}

		await db.calls.update({
			where: {
				id: this.id,
			},
			data: {
				pickedUp: this.pickedUp,
			},
		});

		interaction.reply({
			embeds: [{
				color: this.client.config.colors.success,

				...(this.from.t("pickedUp.toSide", {
					lng: this.to.locale,
					callID: this.id,
				}) as APIEmbed),
			}],
		});

		this.fromSend({
			embeds: [{
				color: this.client.config.colors.success,

				...(this.to.t("pickedUp.fromSide", {
					callID: this.id,
				}) as APIEmbed),
			}],
		});
	}

	async processContent(message: Message, sideToSendTo: ClientCallParticipant): Promise<MessageCreateOptions> {
		const userPerms = await this.client.getPerms(message.author.id);

		const toSend: MessageCreateOptions = { content: `**${message.author.tag}`, embeds: [] };

		if (sideToSendTo.number === this.client.config.supportGuild.supportNumber) {
			toSend.content += `(${message.author.id})`;
		}

		const { callPhones } = this.client.config;
		let phone = "";

		if (userPerms < PermissionLevel.customerSupport && message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
			phone = callPhones.admin;
		} else {
			switch (userPerms) {
				default: {
					phone = callPhones.default;
					break;
				}

				case PermissionLevel.donator: {
					phone = callPhones.donator;
					break;
				}

				case PermissionLevel.maintainer:
				case PermissionLevel.customerSupport: {
					phone = callPhones.support;
					break;
				}

				case PermissionLevel.contributor: {
					phone = callPhones.contributor;
					break;
				}
			}
		}

		toSend.content += `** ${phone} `;
		toSend.content += message.content;

		if (message.attachments.size != 0) {
			for (const i of message.attachments.values()) {
				if (i.contentType?.startsWith("image/")) {
					toSend.embeds?.push({
						image: {
							url: i.url,
						},
					});
				} else {
					toSend.embeds?.push({
						color: config.colors.yellowbook,
						description: `File: **[${i.name}](${i.url})**`,
						footer: {
							text: sideToSendTo.t("dontTrustStrangers"),
						},
					});
				}
			}
		}

		return toSend;
	}

	async messageCreate(message: Message): Promise<void> {
		if (!this.pickedUp?.by) return;
		const sideToSendTo = this.getOtherSideByChannel(message.channel.id)!;

		const toSend = await this.processContent(message, sideToSendTo);

		const forwardedMessageID = await this.client.sendCrossShard(toSend, sideToSendTo.channelID);

		const msgDoc = await this.client.db.callMessages.create({
			data: {
				callID: this.id,
				forwardedMessageID: forwardedMessageID.id,
				originalMessageID: message.id,
				sender: message.author.id,
				sentAt: new Date(),
			},
		});

		this.messageCache.set(msgDoc.originalMessageID, msgDoc);
	}

	async messageUpdate(before: Message, after: Message): Promise<void> {
		if (!this.pickedUp) return;
		const msgDoc = this.messageCache.get(after.id);
		if (!msgDoc) return; // Not a message in this call so ignore

		const otherSide = this.getOtherSideByChannel(before.channelId);
		if (!otherSide) {
			winston.info(`Couldn't find other side for edited messaged in call ${this.id}`);
			return;
		}

		const toSend = await this.processContent(after, otherSide);

		try {
			await this.client.editCrossShard(toSend, otherSide.channelID, msgDoc.forwardedMessageID);
		} catch {
			try {
				toSend.reply = {
					messageReference: msgDoc.forwardedMessageID,
					failIfNotExists: false,
				};
				toSend.content += " (edited)";

				await this.client.sendCrossShard(toSend, otherSide.channelID);
			} catch {
				CallClient.prematureEnd(this);
			}
		}
	}

	async messageDelete(msg: Message): Promise<void> {
		if (!this.pickedUp) return;
		const msgDoc = this.messageCache.get(msg.id);
		if (!msgDoc) return; // Not a message in this call so ignore

		const otherSide = this.getOtherSideByChannel(msg.channelId);
		if (!otherSide) {
			winston.info(`Couldn't find other side for delete messaged in call ${this.id}`);
			return;
		}

		try {
			await this.client.deleteCrossShard(otherSide.channelID, msgDoc.forwardedMessageID);
		} catch {
			await this.client.sendCrossShard({
				content: this.getThisSideByChannel(msg.channelId)!.t("errors.messageDeleted"),
				reply: {
					messageReference: msgDoc.forwardedMessageID,
				},
			}, otherSide.channelID).catch(() => null);
		}

		this.messageCache.delete(msg.id);
	}

	getThisSideByChannel(id: string) {
		if (this.from.channelID === id) return this.from;
		if (this.to.channelID === id) return this.to;
		return null;
	}
	getOtherSideByChannel(id: string) {
		if (this.from.channelID === id) return this.to;
		if (this.to.channelID === id) return this.from;
		return null;
	}

	async hangup(interaction: CommandInteraction|MessageComponentInteraction): Promise<void> {
		const sideInitiatingHangup: CallSide = this.from.channelID === interaction.channelId ? "from" : "to";
		const thisSide = sideInitiatingHangup === "from" ? this.from : this.to;
		const otherSide = thisSide === this.from ? this.to : this.from;

		const thisSideT = getFixedT(thisSide.locale, undefined, "commands.hangup");
		const otherSideT = getFixedT(otherSide.locale, undefined, "commands.hangup");

		const callLength = this.timeElapsed;

		// Should convert this to context at some point
		let thisSideDesc: string, otherSideDesc: string;
		if (this.pickedUp) {
			thisSideDesc = thisSideT("descriptions.pickedUp.thisSide", { time: callLength });
			otherSideDesc = otherSideT("descriptions.pickedUp.otherSide", { time: callLength });
		} else {
			thisSideDesc = thisSideT("descriptions.notPickedUp.otherSide", { time: callLength });
			otherSideDesc = otherSideT("descriptions.notPickedUp.otherSide", { time: callLength });
		}

		interaction.reply({
			embeds: [{
				...(thisSideT("baseEmbed", {
					callID: this.id,
				}) as APIEmbed),
				description: thisSideDesc,
			}],
		});

		this.client.sendCrossShard({
			embeds: [{
				...(otherSideT("baseEmbed", {
					callID: this.id,
					time: callLength,
				}) as APIEmbed),
				description: otherSideDesc,
			}],
		}, otherSide.channelID);

		this.endHandler(interaction.user.id);
	}

	async typingStart(typing: Typing): Promise<void> {
		// Get other side
		const otherSide = this.getOtherSideByChannel(typing.channel.id);

		this.client.rest.post(`/channels/${otherSide}/typing`).catch(() => null);
	}

	async countMessages(): Promise<number> { // cannot use cache -- cache is incomplete
		return (await db.callMessages.aggregate({
			where: {
				callID: this.id,
			},
			_count: {
				_all: true,
			},
		}))._count._all;
	}

	getSide(channelID: string): ClientCallParticipant {
		return this.to.channelID === channelID ? this.to : this.from;
	}

	getOtherSide(channelID: string): ClientCallParticipant {
		return this.to.channelID === channelID ? this.from : this.to;
	}

	// TODO: i18n
	async putOnHold(interaction: CommandInteraction): Promise<void> {
		if (!this.pickedUp) {
			interaction.reply({
				embeds: [this.client.errorEmbed("You can't hold a call that hasn't been picked up yet!")],
			});
			return;
		}

		const baseEmbed = {
			color: config.colors.info,
		};

		const thisSideEmbed = EmbedBuilder.from(baseEmbed);
		const otherSideEmbed = EmbedBuilder.from(baseEmbed);
		// Hold call
		if (!this.hold.onHold) {
			this.hold = {
				onHold: true,
				holdingSide: interaction.channelId,
			};
			thisSideEmbed.setDescription("You have put the call on hold. Use `/hold` to resume the call.");
			otherSideEmbed.setDescription("The other side have put you on hold. Please wait...");
		// Unhold call
		} else {
			console.log(this.hold.holdingSide);
			console.log(interaction.channelId);
			if (this.hold.holdingSide != interaction.channelId) {
				interaction.reply({
					embeds: [this.client.errorEmbed("You can't release the hold if you didn't start it!")],
				});
				return;
			}

			this.hold = {
				onHold: false,
				holdingSide: null,
			};
			thisSideEmbed.setDescription("You have released the hold on this call");
			otherSideEmbed.setDescription("The other side have ended the hold!");
		}

		thisSideEmbed.setTitle(`⏳ Call ${this.hold.onHold ? "held" : "resumed"}`);
		otherSideEmbed.setTitle(`⏳ Call ${this.hold.onHold ? "held" : "resumed"}`);

		// Send the embeds
		await interaction.reply({
			embeds: [thisSideEmbed],
		});
		await this.client.sendCrossShard({
			embeds: [otherSideEmbed],
		}, this.getOtherSide(interaction.channelId).channelID);

		const newObject = await db.calls.update({
			where: {
				id: this.id,
			},
			data: {
				hold: this.hold,
			},
		});

		// Propagate the hold status to the other side
		this.repropagate(newObject);
	}

	async endHandler(endedBy = "system - number lost"): Promise<void> {
		CallClient.endInDB(this.id, endedBy);

		this.client.calls.delete(this.id);

		if (this.otherSideShardID) {
			this.client.shard!.send({
				msg: "callEnded",
				callID: this.id,
				endedBy: endedBy,
			});
		}
	}

	static async endInDB(id: string, endedBy = ""): Promise<void> {
		db.calls.update({
			where: {
				id: id,
			},
			data: {
				active: false,
				ended: {
					at: new Date(),
					by: endedBy ? endedBy : "system",
				},
			},
		}).catch(() => null);
	}

	async repropagate(call: Calls) {
		if (!this.otherSideShardID) return;

		this.client.shard!.send({
			msg: "callRepropagate",
			callID: this.id,
			call,
		});
	}
	handleReprop(call: Calls) {
		Object.assign(this, call);
	}

	static async prematureEnd(callDoc: callMissingChannel): Promise<void> {
		CallClient.endInDB(callDoc.id, "system - number lost");
	}
}

type callMissingChannel = Calls & { to: Numbers | null, from: Numbers | null};
