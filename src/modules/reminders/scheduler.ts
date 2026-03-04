import type { Bot } from 'grammy';
import cron from 'node-cron';
import { REMINDER_CHECK_CRON } from '../../config.js';
import type { BotContext } from '../../types/index.js';
import { advanceRecurringTask, getPendingRecurringTasks } from '../recurring/service.js';
import { getPendingReminders, markAsReminded } from '../tasks/service.js';

async function processOneTimeReminders(bot: Bot<BotContext>) {
	const reminders = await getPendingReminders();

	for (const task of reminders) {
		const chatId = Number(task.user.chatId);

		const dueDateStr = task.dueDate
			? `\nСрок: ${task.dueDate.toLocaleString('ru-RU', { timeZone: task.user.timezone })}`
			: '';

		await bot.api.sendMessage(
			chatId,
			`⏰ Напоминание!\n📁 ${task.project.name}\n📝 ${task.title}${dueDateStr}`,
		);

		await markAsReminded(task.id);
	}
}

async function processRecurringReminders(bot: Bot<BotContext>) {
	const recurringTasks = await getPendingRecurringTasks();

	for (const task of recurringTasks) {
		const chatId = Number(task.user.chatId);

		await bot.api.sendMessage(chatId, `🔁 Напоминание!\n📝 ${task.title}`);

		await advanceRecurringTask(task.id, task.user.timezone);
	}
}

export function startReminderScheduler(bot: Bot<BotContext>) {
	cron.schedule(REMINDER_CHECK_CRON, async () => {
		try {
			await processOneTimeReminders(bot);
			await processRecurringReminders(bot);
		} catch (error) {
			console.error('Reminder scheduler error:', error);
		}
	});

	console.log('Reminder scheduler started');
}
