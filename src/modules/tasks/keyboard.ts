import { InlineKeyboard } from 'grammy';
import type { TaskWithProject } from '../../types/index.js';

const CALLBACK_PREFIX_DONE = 'task_done:';
const CALLBACK_PREFIX_DELETE = 'task_del:';
const CALLBACK_REFRESH = 'task_refresh';

export function buildTaskListKeyboard(tasks: TaskWithProject[]): InlineKeyboard {
	const keyboard = new InlineKeyboard();

	for (const task of tasks) {
		keyboard
			.text(`✅ ${task.id}`, `${CALLBACK_PREFIX_DONE}${task.id}`)
			.text(`🗑 ${task.id}`, `${CALLBACK_PREFIX_DELETE}${task.id}`)
			.row();
	}

	keyboard.text('🔄 Обновить', CALLBACK_REFRESH);

	return keyboard;
}

export function parseCallbackData(data: string): { action: string; taskId: number } | null {
	if (data === CALLBACK_REFRESH) {
		return { action: 'refresh', taskId: 0 };
	}

	if (data.startsWith(CALLBACK_PREFIX_DONE)) {
		const taskId = Number.parseInt(data.slice(CALLBACK_PREFIX_DONE.length), 10);
		return Number.isNaN(taskId) ? null : { action: 'done', taskId };
	}

	if (data.startsWith(CALLBACK_PREFIX_DELETE)) {
		const taskId = Number.parseInt(data.slice(CALLBACK_PREFIX_DELETE.length), 10);
		return Number.isNaN(taskId) ? null : { action: 'delete', taskId };
	}

	return null;
}
