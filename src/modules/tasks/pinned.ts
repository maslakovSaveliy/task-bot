import type { BotContext } from '../../types/index.js';
import { buildTaskListKeyboard } from './keyboard.js';
import { renderTaskList } from './renderer.js';
import { ensureUser, getActiveTasks, updatePinnedMessageId } from './service.js';

export async function refreshPinnedMessage(ctx: BotContext, telegramId: bigint, chatId: bigint) {
	const user = await ensureUser(telegramId, chatId);
	const tasks = await getActiveTasks(user.id);
	const text = renderTaskList(tasks);
	const keyboard = tasks.length > 0 ? buildTaskListKeyboard(tasks) : undefined;

	if (user.pinnedMessageId) {
		try {
			await ctx.api.editMessageText(Number(chatId), user.pinnedMessageId, text, {
				parse_mode: 'Markdown',
				reply_markup: keyboard,
			});
			return;
		} catch {
			// pinned message was deleted or unavailable, create a new one
		}
	}

	const sent = await ctx.api.sendMessage(Number(chatId), text, {
		parse_mode: 'Markdown',
		reply_markup: keyboard,
	});

	await updatePinnedMessageId(user.id, sent.message_id);

	try {
		await ctx.api.pinChatMessage(Number(chatId), sent.message_id, {
			disable_notification: true,
		});
	} catch {
		// bot may not have pin permissions
	}
}
