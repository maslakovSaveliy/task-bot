import { Bot, GrammyError, HttpError, session } from 'grammy';
import { config } from './config.js';
import { projectsModule } from './modules/projects/handlers.js';
import { recurringModule } from './modules/recurring/handlers.js';
import { tasksModule } from './modules/tasks/handlers.js';
import { voiceModule } from './modules/voice/handlers.js';
import type { BotContext, SessionData } from './types/index.js';

function initialSession(): SessionData {
	return { awaitingInput: false, taskListEditMode: false };
}

export function createBot(): Bot<BotContext> {
	const bot = new Bot<BotContext>(config.botToken);

	bot.use(session({ initial: initialSession }));

	bot.use(tasksModule);
	bot.use(recurringModule);
	bot.use(projectsModule);
	bot.use(voiceModule);

	bot.catch((err) => {
		const ctx = err.ctx;
		const e = err.error;

		console.error(`Error while handling update ${ctx.update.update_id}:`);

		if (e instanceof GrammyError) {
			console.error('Error in request:', e.description);
		} else if (e instanceof HttpError) {
			console.error('Could not contact Telegram:', e);
		} else {
			console.error('Unknown error:', e);
		}
	});

	return bot;
}
