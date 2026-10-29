const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

function commandData() {
  return [
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Удалить последние сообщения')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addIntegerOption(o => o.setName('amount').setDescription('Сколько удалить').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption(o => o.setName('user').setDescription('Удалять только сообщения этого пользователя'))
      .toJSON(),
  ];
}

const COMMAND_NAMES = new Set(commandData().map(c => c.name));

class Moderation {
  handles(name) {
    return COMMAND_NAMES.has(name);
  }

  async handleCommand(interaction) {
    if (interaction.commandName === 'clear') return this.cmdClear(interaction);
  }

  async cmdClear(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Эта команда только для админов.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const amount = interaction.options.getInteger('amount', true);
    const target = interaction.options.getUser('user');
    let count = 0;

    if (!target) {
      const deleted = await interaction.channel.bulkDelete(amount, true).catch(() => null);
      count = deleted ? (typeof deleted === 'number' ? deleted : deleted.size) : 0;
    } else {
      // Фильтр по пользователю: берём последние 100 сообщений и удаляем только его.
      const fetched = await interaction.channel.messages.fetch({ limit: 100 }).catch(() => null);
      const mine = fetched ? [...fetched.values()].filter(m => m.author.id === target.id).slice(0, amount) : [];
      const deleted = mine.length ? await interaction.channel.bulkDelete(mine, true).catch(() => null) : null;
      count = deleted ? deleted.size : 0;
    }

    return interaction.editReply({ content: `🧹 Удалено сообщений: ${count}.` });
  }
}

module.exports = { Moderation, commandData, COMMAND_NAMES };
