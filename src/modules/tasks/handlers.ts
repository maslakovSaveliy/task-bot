import { Composer, InlineKeyboard } from 'grammy';
import { parseTaskMessage } from '../../services/ai.js';
import type { BotContext } from '../../types/index.js';
import { parseCallbackData } from './keyboard.js';
import { refreshPinnedMessage } from './pinned.js';
import {
	addTaskFromParsed,
	completeTask,
	deleteTask,
	ensureUser,
	updateUserTimezone,
} from './service.js';

export const tasksModule = new Composer<BotContext>();

const TIMEZONE_OPTIONS = [
	{ label: 'Москва (UTC+3)', value: 'Europe/Moscow' },
	{ label: 'Киев (UTC+2)', value: 'Europe/Kiev' },
	{ label: 'Минск (UTC+3)', value: 'Europe/Minsk' },
	{ label: 'Алматы (UTC+6)', value: 'Asia/Almaty' },
	{ label: 'Ташкент (UTC+5)', value: 'Asia/Tashkent' },
	{ label: 'Тбилиси (UTC+4)', value: 'Asia/Tbilisi' },
] as const;

const CALLBACK_TZ_PREFIX = 'tz:';

function buildTimezoneKeyboard(): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (const tz of TIMEZONE_OPTIONS) {
		kb.text(tz.label, `${CALLBACK_TZ_PREFIX}${tz.value}`).row();
	}
	return kb;
}

tasksModule.command('start', async (ctx) => {
	const telegramId = BigInt(ctx.from?.id ?? 0);
	const chatId = BigInt(ctx.chat.id);
	const user = await ensureUser(telegramId, chatId);

	if (!user.isOnboarded) {
		await ctx.reply(
			'Привет! Я бот для управления задачами.\n\n' +
				'Для начала выбери свой часовой пояс, чтобы напоминания приходили вовремя:',
			{ reply_markup: buildTimezoneKeyboard() },
		);
		return;
	}

	await ctx.reply(
		'Привет! Я бот для управления задачами.\n\n' +
			'Просто отправь мне текст или голосовое сообщение с описанием задачи, ' +
			'и я добавлю её в список.\n\n' +
			'Команды:\n' +
			'/tasks — показать список задач\n' +
			'/projects — список проектов\n' +
			'/recurring — повторяющиеся напоминания\n' +
			'/timezone — сменить часовой пояс\n',
	);

	await refreshPinnedMessage(ctx, telegramId, chatId);
});

tasksModule.command('timezone', async (ctx) => {
	await ctx.reply('Выбери свой часовой пояс:', {
		reply_markup: buildTimezoneKeyboard(),
	});
});

tasksModule.command('tasks', async (ctx) => {
	const telegramId = BigInt(ctx.from?.id ?? 0);
	const chatId = BigInt(ctx.chat.id);
	await refreshPinnedMessage(ctx, telegramId, chatId);
});

tasksModule.on('callback_query:data', async (ctx) => {
	const data = ctx.callbackQuery.data;

	if (data.startsWith(CALLBACK_TZ_PREFIX)) {
		const timezone = data.slice(CALLBACK_TZ_PREFIX.length);
		const telegramId = BigInt(ctx.from.id);
		const chatId = BigInt(ctx.callbackQuery.message?.chat.id ?? 0);
		const user = await ensureUser(telegramId, chatId);

		await updateUserTimezone(user.id, timezone);

		const label = TIMEZONE_OPTIONS.find((tz) => tz.value === timezone)?.label ?? timezone;
		await ctx.editMessageText(`Часовой пояс установлен: ${label}`);
		await ctx.answerCallbackQuery({ text: 'Часовой пояс сохранён!' });

		await ctx.reply(
			'Отлично! Теперь отправь мне текст или голосовое с описанием задачи.\n\n' +
				'Команды:\n' +
				'/tasks — показать список задач\n' +
				'/projects — список проектов\n' +
				'/recurring — повторяющиеся напоминания\n' +
				'/timezone — сменить часовой пояс\n',
		);

		await refreshPinnedMessage(ctx, telegramId, chatId);
		return;
	}

	const parsed = parseCallbackData(data);

	if (!parsed) {
		await ctx.answerCallbackQuery({ text: 'Неизвестное действие' });
		return;
	}

	const telegramId = BigInt(ctx.from.id);
	const chatId = BigInt(ctx.callbackQuery.message?.chat.id ?? 0);
	const user = await ensureUser(telegramId, chatId);

	switch (parsed.action) {
		case 'done':
			await completeTask(parsed.taskId, user.id);
			await ctx.answerCallbackQuery({ text: '✅ Задача выполнена!' });
			break;
		case 'delete':
			await deleteTask(parsed.taskId, user.id);
			await ctx.answerCallbackQuery({ text: '🗑 Задача удалена!' });
			break;
		case 'refresh':
			await ctx.answerCallbackQuery({ text: '🔄 Обновлено!' });
			break;
	}

	await refreshPinnedMessage(ctx, telegramId, chatId);
});

tasksModule.on('message:text', async (ctx) => {
	const text = ctx.message.text;

	if (text.startsWith('/')) return;

	const telegramId = BigInt(ctx.from.id);
	const chatId = BigInt(ctx.chat.id);

	const processingMsg = await ctx.reply('⏳ Обрабатываю задачу...');

	try {
		const user = await ensureUser(telegramId, chatId);
		const parsed = await parseTaskMessage(text, user.timezone);

		if (parsed.recurrence) {
			const { createRecurringFromParsed } = await import('../recurring/service.js');
			const recurring = await createRecurringFromParsed(user.id, user.timezone, parsed);

			const periodLabels: Record<string, string> = {
				weekly: 'Еженедельно',
				monthly: 'Ежемесячно',
				yearly: 'Ежегодно',
			};
			const periodLabel = periodLabels[parsed.recurrence] ?? parsed.recurrence;
			const timeStr = `${String(recurring.hour).padStart(2, '0')}:${String(recurring.minute).padStart(2, '0')}`;

			await ctx.api.editMessageText(
				Number(chatId),
				processingMsg.message_id,
				`🔁 Повторяющееся напоминание создано!\n📝 ${parsed.task}\n⏰ ${periodLabel}, ${timeStr}`,
			);
			return;
		}

		await addTaskFromParsed(
			telegramId,
			chatId,
			parsed.task,
			parsed.project,
			parsed.dueDate,
			parsed.remindAt,
		);

		const dateInfo = parsed.dueDate
			? `\nСрок: ${new Date(parsed.dueDate).toLocaleString('ru-RU', { timeZone: user.timezone })}`
			: '';

		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			`✅ Задача добавлена!\n📁 ${parsed.project}\n📝 ${parsed.task}${dateInfo}`,
		);

		await refreshPinnedMessage(ctx, telegramId, chatId);
	} catch (error) {
		console.error('Error processing text task:', error);
		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			'❌ Не удалось обработать задачу. Попробуйте ещё раз.',
		);
	}
});
