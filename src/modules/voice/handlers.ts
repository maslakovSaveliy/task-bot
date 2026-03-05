import { Composer } from 'grammy';
import { parseUserMessage } from '../../services/ai.js';
import { isSTTConfigured, transcribeAudio } from '../../services/stt.js';
import type { BotContext } from '../../types/index.js';
import { resolveAndExecuteActions } from '../tasks/actions.js';
import { refreshPinnedMessage } from '../tasks/pinned.js';
import { addTaskFromParsed, ensureUser, getActiveTasks } from '../tasks/service.js';

export const voiceModule = new Composer<BotContext>();

voiceModule.on('message:voice', async (ctx) => {
	if (!isSTTConfigured()) {
		await ctx.reply('🎤 Распознавание голоса не настроено. Отправьте текстовое сообщение.');
		return;
	}

	const telegramId = BigInt(ctx.from.id);
	const chatId = BigInt(ctx.chat.id);

	const processingMsg = await ctx.reply('🎤 Распознаю голосовое сообщение...');

	try {
		const file = await ctx.getFile();
		const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

		const response = await fetch(fileUrl);
		const audioBuffer = await response.arrayBuffer();

		const transcribedText = await transcribeAudio(audioBuffer, 'voice.ogg');

		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			`🎤 Распознано: "${transcribedText}"\n⏳ Обрабатываю...`,
		);

		const user = await ensureUser(telegramId, chatId);
		const currentTasks = await getActiveTasks(user.id);
		const result = await parseUserMessage(transcribedText, user.timezone, currentTasks);

		if (result.intent === 'actions') {
			const actionResults = await resolveAndExecuteActions(result.actions, user.id, user.timezone);
			const lines = actionResults.map((r) => (r.success ? r.message : `⚠️ ${r.message}`));
			await ctx.api.editMessageText(
				Number(chatId),
				processingMsg.message_id,
				`${lines.join('\n')}\n\n🎤 _"${transcribedText}"_`,
				{ parse_mode: 'Markdown' },
			);
			await refreshPinnedMessage(ctx, telegramId, chatId, { resend: true });
			return;
		}

		const resultLines: string[] = [];
		for (const parsed of result.tasks) {
			await addTaskFromParsed(
				telegramId,
				chatId,
				parsed.task,
				parsed.project,
				parsed.dueDate,
				parsed.remindAt,
			);
			resultLines.push(`📁 ${parsed.project}\n📝 ${parsed.task}`);
		}

		const header =
			result.tasks.length === 1
				? '✅ Задача добавлена!'
				: `✅ Добавлено задач: ${result.tasks.length}`;

		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			`${header}\n\n${resultLines.join('\n\n')}\n\n🎤 _"${transcribedText}"_`,
			{ parse_mode: 'Markdown' },
		);

		await refreshPinnedMessage(ctx, telegramId, chatId, { resend: true });
	} catch (error) {
		console.error('Error processing voice message:', error);
		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			'❌ Не удалось обработать голосовое сообщение. Попробуйте ещё раз.',
		);
	}
});
