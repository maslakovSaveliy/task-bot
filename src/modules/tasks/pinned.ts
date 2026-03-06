import type { BotContext } from '../../types/index.js';
import { buildTaskListKeyboard } from './keyboard.js';
import { renderTaskList } from './renderer.js';
import { ensureUser, getActiveTasks, updatePinnedMessageId } from './service.js';

interface RefreshOptions {
	resend?: boolean;
}

async function buildTaskMessage(userId: number, timezone: string) {
	const tasks = await getActiveTasks(userId);
	const text = renderTaskList(tasks, timezone);
	return { text, tasks };
}

async function sendNewPinnedMessage(
	ctx: BotContext,
	chatId: number,
	userId: number,
	text: string,
	keyboard: ReturnType<typeof buildTaskListKeyboard> | undefined,
) {
	const sent = await ctx.api.sendMessage(chatId, text, {
		parse_mode: 'Markdown',
		reply_markup: keyboard,
	});

	await updatePinnedMessageId(userId, sent.message_id);

	try {
		await ctx.api.pinChatMessage(chatId, sent.message_id, {
			disable_notification: true,
		});
	} catch {
		// bot may not have pin permissions
	}
}

export async function refreshPinnedMessage(
	ctx: BotContext,
	telegramId: bigint,
	chatId: bigint,
	options: RefreshOptions = {},
) {
	const { resend = false } = options;
	const user = await ensureUser(telegramId, chatId);
	const { text, tasks } = await buildTaskMessage(user.id, user.timezone);
	const keyboard =
		tasks.length > 0 ? buildTaskListKeyboard(tasks, ctx.session.taskListEditMode) : undefined;
	const numericChatId = Number(chatId);

	if (!resend && user.pinnedMessageId) {
		try {
			await ctx.api.editMessageText(numericChatId, user.pinnedMessageId, text, {
				parse_mode: 'Markdown',
				reply_markup: keyboard,
			});
			return;
		} catch {
			// message unavailable, fall through to create new
		}
	}

	if (resend && user.pinnedMessageId) {
		try {
			await ctx.api.deleteMessage(numericChatId, user.pinnedMessageId);
		} catch {
			// old message already deleted
		}
	}

	await sendNewPinnedMessage(ctx, numericChatId, user.id, text, keyboard);
}
