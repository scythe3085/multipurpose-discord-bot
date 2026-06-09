// commands/alerts.js
const { SlashCommandBuilder } = require('discord.js');
const {
  alertsAdd,
  alertsList,
  alertsRemove,
  alertsRoles,
  alertsTemplateSet,
  alertsTemplateReset,
  alertsTemplatePreview,
} = require('../systems/alerts/alerts.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('alerts')
    .setDescription('Configure YouTube/Twitch alerts for this server')

    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Add a YouTube or Twitch alert subscription')
        .addStringOption(opt =>
          opt
            .setName('provider')
            .setDescription('Pick provider')
            .setRequired(true)
            .addChoices({ name: 'YouTube', value: 'youtube' }, { name: 'Twitch', value: 'twitch' }),
        )
        .addStringOption(opt =>
          opt
            .setName('channel')
            .setDescription(
              'YouTube: channelId (UC...), @handle, or channel URL. Twitch: login or twitch.tv/name',
            )
            .setRequired(true),
        )
        .addStringOption(opt =>
          opt
            .setName('types')
            .setDescription('Comma separated: youtube=vid,live,shorts | twitch=live')
            .setRequired(true),
        )
        .addChannelOption(opt =>
          opt
            .setName('post_to')
            .setDescription('Where to post the notifications')
            .setRequired(true),
        ),
    )

    .addSubcommand(sub => sub.setName('list').setDescription('List configured alert subscriptions'))

    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove a subscription by ID')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Subscription ID from /alerts list').setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub
        .setName('roles')
        .setDescription('Edit the roles mentioned for a subscription')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Subscription ID from /alerts list').setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub
        .setName('template')
        .setDescription('Set a custom message template for a subscription')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Subscription ID from /alerts list').setRequired(true),
        )
        .addStringOption(opt =>
          opt
            .setName('template')
            .setDescription('Use {title} {url} {name} {type}')
            .setRequired(true),
        ),
    )

    .addSubcommand(sub =>
      sub
        .setName('template-reset')
        .setDescription('Reset a subscription to the default template')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Subscription ID from /alerts list').setRequired(true),
        ),
    )

    // NEW
    .addSubcommand(sub =>
      sub
        .setName('template-preview')
        .setDescription('Preview what the template will look like for a subscription')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Subscription ID from /alerts list').setRequired(true),
        ),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'add') return alertsAdd(interaction);
    if (sub === 'list') return alertsList(interaction);
    if (sub === 'remove') return alertsRemove(interaction);
    if (sub === 'roles') return alertsRoles(interaction);
    if (sub === 'template') return alertsTemplateSet(interaction);
    if (sub === 'template-reset') return alertsTemplateReset(interaction);
    if (sub === 'template-preview') return alertsTemplatePreview(interaction);
  },
};
