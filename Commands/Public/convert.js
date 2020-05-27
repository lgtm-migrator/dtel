const Discoin = require("@discoin/scambio").default;

module.exports = async(client, msg, suffix) => {
	const DClient = new Discoin(require("../../Configuration/auth.js").discoinToken, "DTS");
	let error;
	let amount = suffix.split(" ")[0];
	let currency = suffix.split(" ")[1];
	if (!amount || !currency) {
		try {
			let currencies = await Discoin.currencies.getMany("filter=name||$excl||Test&sort=id,ASC"),
				emojis = client.guilds.cache.get("347859709711089674").emojis.cache,
				dts = currencies.find(c => c.id === "DTS");
			currencies.splice(currencies.indexOf(dts), 1);
			const content = { embed: {
				color: config.colors.info,
				title: "Command usage",
				description: `\`>convert [amount] [3-letter currency code]\`\nSee the [docs](${config.discoinLink}) or \`>dial 0800DISCOIN\` for info.\n1 DTS = ${dts.value}`,
				fields: [],
			} };
			currencies.forEach(curr => {
				let emoji = emojis.find(e => e.name === curr.id).toString();
				content.embed.fields.push({ name: `${emoji} ${curr.id} @ ${client.format(curr.value)} D$`, value: `1 ${dts.id} = ${client.format(Math.round((dts.value / curr.value) * 100) / 100)} ${curr.id}`, inline: true });
			});
			return msg.channel.send(content);
		} catch (err) {
			error = err;
			return msg.channel.send({ embed: { color: config.colors.error, title: "API error", description: `\`\`\`\n${err}\n\`\`\`` } });
		}
	}
	amount = parseFloat(parseFloat(amount).toFixed(2));
	currency = currency.toUpperCase();

	let account = await msg.author.account();

	if (isNaN(amount)) return msg.channel.send({ embed: { color: config.colors.error, title: "Syntax error", description: "That's not a number..." } });
	if (account.balance < amount) return msg.channel.send({ embed: { color: config.colors.error, title: "Payment error", description: `Insufficient balance! You have ${account.balance} credits.` } });

	let newTransaction;
	try {
		newTransaction = await DClient.transactions.create({
			to: currency,
			amount: amount,
			user: msg.author.id,
		});
	} catch (err) {
		error = err;
		return msg.channel.send({ embed: { color: config.colors.error, title: "API error", description: `\`\`\`json\n${err}\n\`\`\`` } });
	} finally {
		if (!error) {
			account.balance -= amount;
			await r.table("Accounts").get(account.id).update({ balance: account.balance });

			let embed = {
				color: config.colors.receipt,
				title: "Converted!",
				description: `Succesfully converted <:DTS:668551813317787659>${amount} into ${newTransaction.payout} ${currency}. You may track your transaction [here](https://dash.discoin.zws.im/#/transactions/${newTransaction.id}/show).`,
				author: {
					name: msg.author.tag,
					icon_url: msg.author.displayAvatarURL(),
				},
				timestamp: new Date(),
			};
			msg.channel.send({ embed: embed });
			client.log(`${msg.author.username} converted <:DTS:668551813317787659>${amount} into ${newTransaction.payout} ${currency} using Discoin.`);
		}
	}
};
