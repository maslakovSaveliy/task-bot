import { Composer } from 'grammy';
import { parseTaskMessage } from '../../services/ai.js';
import { transcribeAudio } from '../../services/stt.js';
import type { BotContext } from '../../types/index.js';
import { refreshPinnedMessage } from '../tasks/pinned.js';
import { addTaskFromParsed, ensureUser } from '../tasks/service.js';

export const voiceModule = new Composer<BotContext>();

voiceModule.on('message:voice', async (ctx) => {
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
			`🎤 Распознано: "${transcribedText}"\n⏳ Обрабатываю задачу...`,
		);

		const user = await ensureUser(telegramId, chatId);
		const tasks = await parseTaskMessage(transcribedText, user.timezone);

		const resultLines: string[] = [];
		for (const parsed of tasks) {
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
			tasks.length === 1 ? '✅ Задача добавлена!' : `✅ Добавлено задач: ${tasks.length}`;

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
