import { createBot } from './bot.js';
import { prisma } from './db/client.js';
import { startReminderScheduler } from './modules/reminders/scheduler.js';

async function main() {
	const bot = createBot();

	startReminderScheduler(bot);

	console.log('Bot is starting...');
	await bot.start({
		onStart: () => console.log('Bot is running!'),
	});
}

main().catch(async (error) => {
	console.error('Fatal error:', error);
	await prisma.$disconnect();
	process.exit(1);
});

async function shutdown() {
	console.log('Shutting down...');
	await prisma.$disconnect();
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
