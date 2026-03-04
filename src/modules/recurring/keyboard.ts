import { InlineKeyboard } from 'grammy';
import type { RecurringTask } from '../../../generated/prisma/index.js';

const CALLBACK_PAUSE_PREFIX = 'rec_pause:';
const CALLBACK_DELETE_PREFIX = 'rec_del:';

export function buildRecurringListKeyboard(tasks: RecurringTask[]): InlineKeyboard {
	const keyboard = new InlineKeyboard();

	for (const task of tasks) {
		keyboard
			.text(`⏸ ${task.id}`, `${CALLBACK_PAUSE_PREFIX}${task.id}`)
			.text(`🗑 ${task.id}`, `${CALLBACK_DELETE_PREFIX}${task.id}`)
			.row();
	}

	return keyboard;
}

export function parseRecurringCallback(
	data: string,
): { action: 'pause' | 'delete'; taskId: number } | null {
	if (data.startsWith(CALLBACK_PAUSE_PREFIX)) {
		const taskId = Number.parseInt(data.slice(CALLBACK_PAUSE_PREFIX.length), 10);
		return Number.isNaN(taskId) ? null : { action: 'pause', taskId };
	}

	if (data.startsWith(CALLBACK_DELETE_PREFIX)) {
		const taskId = Number.parseInt(data.slice(CALLBACK_DELETE_PREFIX.length), 10);
		return Number.isNaN(taskId) ? null : { action: 'delete', taskId };
	}

	return null;
}
