import { find as findTimezone } from 'geo-tz';
import { Composer, InlineKeyboard } from 'grammy';
import { parseUserMessage } from '../../services/ai.js';
import type { BotContext } from '../../types/index.js';
import { resolveAndExecuteActions } from './actions.js';
import { parseCallbackData } from './keyboard.js';
import { refreshPinnedMessage } from './pinned.js';
import {
	addTaskFromParsed,
	completeTask,
	deleteTask,
	ensureUser,
	getActiveTasks,
	updateUserTimezone,
} from './service.js';

export const tasksModule = new Composer<BotContext>();

interface TimezoneOption {
	label: string;
	value: string;
}

const TIMEZONE_OPTIONS: TimezoneOption[] = [
	// Russia
	{ label: 'Калининград +2', value: 'Europe/Kaliningrad' },
	{ label: 'Москва +3', value: 'Europe/Moscow' },
	{ label: 'Самара +4', value: 'Europe/Samara' },
	{ label: 'Екатеринбург +5', value: 'Asia/Yekaterinburg' },
	{ label: 'Омск +6', value: 'Asia/Omsk' },
	{ label: 'Красноярск +7', value: 'Asia/Krasnoyarsk' },
	{ label: 'Иркутск +8', value: 'Asia/Irkutsk' },
	{ label: 'Якутск +9', value: 'Asia/Yakutsk' },
	{ label: 'Владивосток +10', value: 'Asia/Vladivostok' },
	{ label: 'Магадан +11', value: 'Asia/Magadan' },
	{ label: 'Камчатка +12', value: 'Asia/Kamchatka' },
	// CIS
	{ label: 'Минск +3', value: 'Europe/Minsk' },
	{ label: 'Киев +2', value: 'Europe/Kiev' },
	{ label: 'Тбилиси +4', value: 'Asia/Tbilisi' },
	{ label: 'Баку +4', value: 'Asia/Baku' },
	{ label: 'Ташкент +5', value: 'Asia/Tashkent' },
	{ label: 'Алматы +6', value: 'Asia/Almaty' },
	// International
	{ label: 'Стамбул +3', value: 'Europe/Istanbul' },
	{ label: 'Дубай +4', value: 'Asia/Dubai' },
	{ label: 'Бангкок +7', value: 'Asia/Bangkok' },
	{ label: 'Токио +9', value: 'Asia/Tokyo' },
	{ label: 'Лондон +0', value: 'Europe/London' },
	{ label: 'Берлин +1', value: 'Europe/Berlin' },
];

const CALLBACK_TZ_PREFIX = 'tz:';

const TIMEZONE_PROMPT =
	'Выбери свой часовой пояс из списка ниже.\n\n' +
	'📍 Или отправь геолокацию (скрепка → Геопозиция) для автоматического определения.';

function getUtcOffset(timezone: string): string {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		timeZoneName: 'shortOffset',
	});
	const parts = formatter.formatToParts(new Date());
	const tzPart = parts.find((p) => p.type === 'timeZoneName');
	return tzPart?.value?.replace('GMT', '') ?? '';
}

function formatTimezoneName(timezone: string): string {
	return timezone.split('/').pop()?.replace(/_/g, ' ') ?? timezone;
}

function buildTimezoneKeyboard(): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (let i = 0; i < TIMEZONE_OPTIONS.length; i += 2) {
		const first = TIMEZONE_OPTIONS[i];
		if (first) {
			kb.text(first.label, `${CALLBACK_TZ_PREFIX}${first.value}`);
		}
		const second = TIMEZONE_OPTIONS[i + 1];
		if (second) {
			kb.text(second.label, `${CALLBACK_TZ_PREFIX}${second.value}`);
		}
		kb.row();
	}
	return kb;
}

const WELCOME_COMMANDS =
	'Команды:\n' +
	'/tasks — показать список задач\n' +
	'/projects — список проектов\n' +
	'/recurring — повторяющиеся напоминания\n' +
	'/timezone — сменить часовой пояс\n';

tasksModule.command('start', async (ctx) => {
	const telegramId = BigInt(ctx.from?.id ?? 0);
	const chatId = BigInt(ctx.chat.id);
	const user = await ensureUser(telegramId, chatId);

	if (!user.isOnboarded) {
		await ctx.reply(
			'Привет! Я бот для управления задачами.\n\n' +
				'Для начала выбери свой часовой пояс, чтобы напоминания приходили вовремя.\n\n' +
				TIMEZONE_PROMPT,
			{ reply_markup: buildTimezoneKeyboard() },
		);
		return;
	}

	await ctx.reply(
		`Привет! Я бот для управления задачами.\n\nПросто отправь мне текст или голосовое сообщение с описанием задачи, и я добавлю её в список.\n\n${WELCOME_COMMANDS}`,
	);

	await refreshPinnedMessage(ctx, telegramId, chatId);
});

tasksModule.command('help', async (ctx) => {
	await ctx.reply(
		'📋 *Task Manager Bot — Справка*\n\n' +
			'*Как добавить задачу:*\n' +
			'Просто отправь текстовое или голосовое сообщение\\. ' +
			'AI автоматически распознает название задачи, проект, дату и время\\.\n\n' +
			'*Примеры добавления:*\n' +
			'• "Написать отчёт проект Work до пятницы"\n' +
			'• "Купить молоко завтра в 10:00"\n' +
			'• "Через 2 часа созвон с командой"\n' +
			'• "Каждую пятницу в 10:00 стендап" \\(повторяющаяся\\)\n' +
			'• "Раз в месяц 1 числа оплата квартиры"\n\n' +
			'*Управление задачами текстом/голосом:*\n' +
			'• "удали задачу 3"\n' +
			'• "задача купить молоко готова"\n' +
			'• "переименуй задачу 1 в Позвонить маме"\n' +
			'• "перенеси задачу 2 в проект Работа"\n' +
			'• "перенеси дедлайн задачи 1 на завтра"\n' +
			'• "удали задачи 1 и 3"\n\n' +
			'*Команды:*\n' +
			'/start — запуск бота и выбор часового пояса\n' +
			'/tasks — показать список активных задач\n' +
			'/projects — список проектов с количеством задач\n' +
			'/recurring — управление повторяющимися напоминаниями\n' +
			'/timezone — сменить часовой пояс\n' +
			'/help — эта справка\n\n' +
			'*Кнопки в закреплённом сообщении:*\n' +
			'✅ — отметить выполненной\n' +
			'🗑 — удалить задачу\n' +
			'🔄 — обновить список\n\n' +
			'*Повторяющиеся напоминания:*\n' +
			'Еженедельные, ежемесячные и ежегодные\\. ' +
			'Не показываются в основном списке — просто приходят уведомлением\\.\n' +
			'Управлять: /recurring',
		{ parse_mode: 'MarkdownV2' },
	);
});

tasksModule.command('timezone', async (ctx) => {
	await ctx.reply(TIMEZONE_PROMPT, {
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

		const offset = getUtcOffset(timezone);
		const cityName =
			TIMEZONE_OPTIONS.find((tz) => tz.value === timezone)?.label ?? formatTimezoneName(timezone);
		await ctx.editMessageText(`✅ Часовой пояс установлен: ${cityName} (UTC${offset})`);
		await ctx.answerCallbackQuery({ text: 'Часовой пояс сохранён!' });

		await ctx.reply(
			`Отлично! Теперь отправь мне текст или голосовое с описанием задачи.\n\n${WELCOME_COMMANDS}`,
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

tasksModule.on('message:location', async (ctx) => {
	const { latitude, longitude } = ctx.message.location;
	const telegramId = BigInt(ctx.from.id);
	const chatId = BigInt(ctx.chat.id);

	const timezones = findTimezone(latitude, longitude);
	const timezone = timezones[0];

	if (!timezone) {
		await ctx.reply('Не удалось определить часовой пояс. Выбери вручную:', {
			reply_markup: buildTimezoneKeyboard(),
		});
		return;
	}

	const user = await ensureUser(telegramId, chatId);
	await updateUserTimezone(user.id, timezone);

	const offset = getUtcOffset(timezone);
	const cityName = formatTimezoneName(timezone);

	await ctx.reply(
		`✅ Часовой пояс определён: ${cityName} (UTC${offset})\n\nТеперь отправь мне текст или голосовое с описанием задачи.\n\n${WELCOME_COMMANDS}`,
	);

	await refreshPinnedMessage(ctx, telegramId, chatId);
});

tasksModule.on('message:text', async (ctx) => {
	const text = ctx.message.text;

	if (text.startsWith('/')) return;

	const telegramId = BigInt(ctx.from.id);
	const chatId = BigInt(ctx.chat.id);

	const processingMsg = await ctx.reply('⏳ Обрабатываю...');

	try {
		const user = await ensureUser(telegramId, chatId);
		const currentTasks = await getActiveTasks(user.id);
		const result = await parseUserMessage(text, user.timezone, currentTasks);

		if (result.intent === 'actions') {
			const actionResults = await resolveAndExecuteActions(result.actions, user.id, user.timezone);
			const lines = actionResults.map((r) => (r.success ? r.message : `⚠️ ${r.message}`));
			await ctx.api.editMessageText(Number(chatId), processingMsg.message_id, lines.join('\n'));
			await refreshPinnedMessage(ctx, telegramId, chatId, { resend: true });
			return;
		}

		const resultLines: string[] = [];
		let recurringCount = 0;
		let regularCount = 0;

		for (const parsed of result.tasks) {
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
				resultLines.push(`🔁 ${parsed.task} (${periodLabel}, ${timeStr})`);
				recurringCount++;
			} else {
				await addTaskFromParsed(
					telegramId,
					chatId,
					parsed.task,
					parsed.project,
					parsed.dueDate,
					parsed.remindAt,
				);

				let taskLine = `📁 ${parsed.project}\n📝 ${parsed.task}`;
				const dateFmtOpts: Intl.DateTimeFormatOptions = {
					timeZone: user.timezone,
					day: '2-digit',
					month: '2-digit',
					year: 'numeric',
					hour: '2-digit',
					minute: '2-digit',
				};
				if (parsed.dueDate) {
					const dateStr = new Date(parsed.dueDate).toLocaleString('ru-RU', dateFmtOpts);
					taskLine += `\n📅 Срок: ${dateStr}`;
				}
				if (parsed.remindAt) {
					const remindStr = new Date(parsed.remindAt).toLocaleString('ru-RU', dateFmtOpts);
					taskLine += `\n🔔 Напомню заранее: ${remindStr}`;
				}
				resultLines.push(taskLine);
				regularCount++;
			}
		}

		const totalCount = regularCount + recurringCount;
		const header =
			totalCount === 1
				? regularCount === 1
					? '✅ Задача добавлена!'
					: '✅ Напоминание создано!'
				: `✅ Добавлено задач: ${totalCount}`;

		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			`${header}\n\n${resultLines.join('\n\n')}`,
		);

		await refreshPinnedMessage(ctx, telegramId, chatId, { resend: true });
	} catch (error) {
		console.error('Error processing text task:', error);
		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			'❌ Не удалось обработать сообщение. Попробуйте ещё раз.',
		);
	}
});
