// File needs a better name

import { MessageComponentInteraction } from "discord.js";
import DTelClient from "./client";
import Processor from "./processor";
import i18n, { TFunction } from "i18next";

abstract class ComponentProcessor extends Processor {
	interaction: MessageComponentInteraction;
	t: TFunction;

	constructor(client: DTelClient, interaction: MessageComponentInteraction) {
		super(client, interaction);
		this.interaction = interaction;

		this.t = i18n.getFixedT(interaction.locale, null, `commands.${interaction.customId.split("-")[0]}`);
	}
	abstract run(): void;
}
export default ComponentProcessor;
