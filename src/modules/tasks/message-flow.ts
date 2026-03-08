import type { UserMessageResult } from '../../services/ai.js';
import { logAction } from '../action-log/service.js';
import { resolveAndExecuteActions } from './actions.js';
import { addTaskFromParsed } from './service.js';

interface ExecuteParsedMessageParams {
	result: UserMessageResult;
	telegramId: bigint;
	chatId: bigint;
	userId: number;
	timezone: string;
}

function formatDateTime(date: string, timezone: string): string {
	return new Date(date).toLocaleString('ru-RU', {
		timeZone: timezone,
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

async function createTaskLines(
	telegramId: bigint,
	chatId: bigint,
	userId: number,
	timezone: string,
	result: Extract<UserMessageResult, { intent: 'new_tasks' | 'mixed' }>,
): Promise<{ lines: string[]; regularCount: number; recurringCount: number }> {
	const lines: string[] = [];
	let regularCount = 0;
	let recurringCount = 0;

	for (const parsed of result.tasks) {
		if (parsed.recurrence) {
			const { createRecurringFromParsed } = await import('../recurring/service.js');
			const recurring = await createRecurringFromParsed(userId, timezone, parsed);
			const periodLabels: Record<string, string> = {
				weekly: 'Еженедельно',
				monthly: 'Ежемесячно',
				yearly: 'Ежегодно',
			};
			const periodLabel = periodLabels[parsed.recurrence] ?? parsed.recurrence;
			const timeStr = `${String(recurring.hour).padStart(2, '0')}:${String(recurring.minute).padStart(2, '0')}`;
			lines.push(`🔁 ${parsed.task} (${periodLabel}, ${timeStr})`);
			recurringCount++;
			continue;
		}

		const createdTask = await addTaskFromParsed(
			telegramId,
			chatId,
			parsed.task,
			parsed.project,
			parsed.dueDate,
			parsed.remindAt,
		);

		await logAction(userId, 'create', createdTask.id, parsed.task, parsed.project, {
			dueDate: parsed.dueDate,
			remindAt: parsed.remindAt,
		});

		let taskLine = `📁 ${parsed.project}\n📝 ${parsed.task}`;
		if (parsed.dueDate) {
			taskLine += `\n📅 Срок: ${formatDateTime(parsed.dueDate, timezone)}`;
		}
		if (parsed.remindAt) {
			taskLine += `\n🔔 Напомню заранее: ${formatDateTime(parsed.remindAt, timezone)}`;
		}
		lines.push(taskLine);
		regularCount++;
	}

	return { lines, regularCount, recurringCount };
}

export async function executeParsedMessage(
	params: ExecuteParsedMessageParams,
): Promise<{ text: string; shouldRefresh: boolean }> {
	const { result, telegramId, chatId, userId, timezone } = params;

	if (result.intent === 'clarify') {
		return { text: `⚠️ ${result.message}`, shouldRefresh: false };
	}

	const sections: string[] = [];
	let shouldRefresh = false;

	if (result.intent === 'actions' || result.intent === 'mixed') {
		const actionResults = await resolveAndExecuteActions(result.actions, userId, timezone);
		console.log('[Executor actions]', JSON.stringify(actionResults));
		sections.push(
			actionResults
				.map((entry) => (entry.success ? entry.message : `⚠️ ${entry.message}`))
				.join('\n'),
		);
		shouldRefresh = true;
	}

	if (result.intent === 'new_tasks' || result.intent === 'mixed') {
		const created = await createTaskLines(telegramId, chatId, userId, timezone, result);
		const totalCount = created.regularCount + created.recurringCount;
		const header =
			totalCount === 1
				? created.regularCount === 1
					? '✅ Задача добавлена!'
					: '✅ Напоминание создано!'
				: `✅ Добавлено задач: ${totalCount}`;
		sections.push(`${header}\n\n${created.lines.join('\n\n')}`);
		shouldRefresh = true;
	}

	return { text: sections.join('\n\n'), shouldRefresh };
}
