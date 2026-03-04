import { Composer } from 'grammy';
import type { Recurrence } from '../../../generated/prisma/index.js';
import type { BotContext } from '../../types/index.js';
import { ensureUser } from '../tasks/service.js';
import { buildRecurringListKeyboard, parseRecurringCallback } from './keyboard.js';
import {
	deactivateRecurringTask,
	deleteRecurringTask,
	getActiveRecurringTasks,
} from './service.js';

export const recurringModule = new Composer<BotContext>();

const RECURRENCE_LABELS: Record<Recurrence, string> = {
	WEEKLY: 'Еженедельно',
	MONTHLY: 'Ежемесячно',
	YEARLY: 'Ежегодно',
};

const DAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'] as const;

recurringModule.command('recurring', async (ctx) => {
	const telegramId = BigInt(ctx.from?.id ?? 0);
	const chatId = BigInt(ctx.chat.id);
	const user = await ensureUser(telegramId, chatId);

	const tasks = await getActiveRecurringTasks(user.id);

	if (tasks.length === 0) {
		await ctx.reply(
			'🔁 У вас нет повторяющихся напоминаний.\n\n' +
				'Отправьте сообщение вида "каждую пятницу в 10:00 созвон" чтобы создать.',
		);
		return;
	}

	const lines = ['🔁 *Повторяющиеся напоминания*\n'];

	for (const task of tasks) {
		const timeStr = `${String(task.hour).padStart(2, '0')}:${String(task.minute).padStart(2, '0')}`;
		const periodLabel = RECURRENCE_LABELS[task.recurrence];

		let dayInfo = '';
		if (task.recurrence === 'WEEKLY' && task.dayOfWeek !== null) {
			dayInfo = `, ${DAY_NAMES[task.dayOfWeek] ?? ''}`;
		} else if (task.recurrence === 'MONTHLY' && task.dayOfMonth !== null) {
			dayInfo = `, ${task.dayOfMonth}-е число`;
		} else if (task.recurrence === 'YEARLY' && task.dayOfMonth !== null) {
			dayInfo = `, ${task.dayOfMonth}-е число`;
		}

		lines.push(`  ${task.id}. ${task.title}`);
		lines.push(`     ${periodLabel}${dayInfo}, ${timeStr}`);
	}

	await ctx.reply(lines.join('\n'), {
		parse_mode: 'Markdown',
		reply_markup: buildRecurringListKeyboard(tasks),
	});
});

recurringModule.on('callback_query:data', async (ctx, next) => {
	const data = ctx.callbackQuery.data;
	const parsed = parseRecurringCallback(data);

	if (!parsed) {
		return next();
	}

	const telegramId = BigInt(ctx.from.id);
	const chatId = BigInt(ctx.callbackQuery.message?.chat.id ?? 0);
	const user = await ensureUser(telegramId, chatId);

	switch (parsed.action) {
		case 'pause':
			await deactivateRecurringTask(parsed.taskId, user.id);
			await ctx.answerCallbackQuery({ text: '⏸ Напоминание приостановлено' });
			break;
		case 'delete':
			await deleteRecurringTask(parsed.taskId, user.id);
			await ctx.answerCallbackQuery({ text: '🗑 Напоминание удалено' });
			break;
	}

	const tasks = await getActiveRecurringTasks(user.id);
	if (tasks.length === 0) {
		await ctx.editMessageText('🔁 Все повторяющиеся напоминания удалены/приостановлены.');
	} else {
		const lines = ['🔁 *Повторяющиеся напоминания*\n'];
		for (const task of tasks) {
			const timeStr = `${String(task.hour).padStart(2, '0')}:${String(task.minute).padStart(2, '0')}`;
			const periodLabel = RECURRENCE_LABELS[task.recurrence];
			lines.push(`  ${task.id}. ${task.title} — ${periodLabel}, ${timeStr}`);
		}
		await ctx.editMessageText(lines.join('\n'), {
			parse_mode: 'Markdown',
			reply_markup: buildRecurringListKeyboard(tasks),
		});
	}
});
