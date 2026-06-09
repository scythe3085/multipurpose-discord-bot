// deploy-commands.js
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
  } else {
    console.log(`[WARN] The command at ${filePath} is missing "data" or "execute".`);
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    // 1) GLOBAL COMMANDS: apply clean set (NO /vs)
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Successfully reloaded GLOBAL application (/) commands.');

    // 2) OPTIONAL: clear leftover GUILD commands on your main guild
    if (process.env.GUILD_ID) {
      console.log(`Clearing leftover guild commands for guild ${process.env.GUILD_ID}...`);
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: [] }, // empty array = delete all guild commands
      );
      console.log('✅ Guild commands cleared for main guild.');
    }
  } catch (error) {
    console.error('Failed to deploy commands:', error);
  }
})();
