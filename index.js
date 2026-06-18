const config = require('./src/config');
const { StateStore } = require('./src/state');
const { DiscordBot } = require('./src/bot');

async function main() {
  const stateStore = new StateStore(config);
  const bot = new DiscordBot(config, stateStore);
  await bot.start();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
