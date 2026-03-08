import { Composer } from 'grammy';
import { parseUserMessage } from '../../services/ai.js';
import { isSTTConfigured, transcribeAudio } from '../../services/stt.js';
import type { BotContext } from '../../types/index.js';
import { getContextWindow, getRecentActions } from '../action-log/service.js';
import { executeParsedMessage } from '../tasks/message-flow.js';
import { refreshPinnedMessage } from '../tasks/pinned.js';
import { ensureUser, getActiveTasks } from '../tasks/service.js';

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

		const transcription = await transcribeAudio(audioBuffer, 'voice.ogg');
		console.log(
			'[Voice transcription]',
			JSON.stringify({
				model: transcription.model,
				fallbackReason: transcription.fallbackReason,
				rawText: transcription.rawText,
				normalizedText: transcription.normalizedText,
			}),
		);

		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			`🎤 Распознано: "${transcription.text}"\n⏳ Обрабатываю...`,
		);

		const user = await ensureUser(telegramId, chatId);
		const contextWindow = getContextWindow(transcription.text);
		const [currentTasks, recentActions] = await Promise.all([
			getActiveTasks(user.id),
			getRecentActions(user.id, contextWindow),
		]);
		const result = await parseUserMessage(
			transcription.text,
			user.timezone,
			currentTasks,
			recentActions,
		);
		const execution = await executeParsedMessage({
			result,
			telegramId,
			chatId,
			userId: user.id,
			timezone: user.timezone,
		});

		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			`${execution.text}\n\n🎤 _"${transcription.text}"_`,
			{ parse_mode: 'Markdown' },
		);

		if (execution.shouldRefresh) {
			await refreshPinnedMessage(ctx, telegramId, chatId, { resend: true });
		}
	} catch (error) {
		console.error('Error processing voice message:', error);
		await ctx.api.editMessageText(
			Number(chatId),
			processingMsg.message_id,
			'❌ Не удалось обработать голосовое сообщение. Попробуйте ещё раз.',
		);
	}
});
