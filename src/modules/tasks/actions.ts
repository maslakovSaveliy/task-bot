import { resolveDeadline } from '../../services/ai.js';
import type { ActionResult, TaskActionRaw, TaskWithProject } from '../../types/index.js';
import {
	completeTask,
	deleteTask,
	getActiveTasks,
	moveTaskToProject,
	renameTask,
	updateTaskDeadline,
} from './service.js';

const ACTION_LABELS: Record<string, string> = {
	delete: 'Удалена',
	complete: 'Выполнена',
	rename: 'Переименована',
	move_project: 'Перемещена',
	change_deadline: 'Дедлайн изменён',
};

function resolveTask(action: TaskActionRaw, tasks: TaskWithProject[]): TaskWithProject | undefined {
	if (action.taskNumber !== null && action.taskNumber >= 1 && action.taskNumber <= tasks.length) {
		return tasks[action.taskNumber - 1];
	}

	if (action.taskName) {
		const needle = action.taskName.toLowerCase();
		return tasks.find((t) => t.title.toLowerCase().includes(needle));
	}

	return undefined;
}

export async function resolveAndExecuteActions(
	actions: TaskActionRaw[],
	userId: number,
	timezone: string,
): Promise<ActionResult[]> {
	const tasks = await getActiveTasks(userId);
	const results: ActionResult[] = [];

	for (const action of actions) {
		const task = resolveTask(action, tasks);
		if (!task) {
			const ref = action.taskNumber ? `#${action.taskNumber}` : `"${action.taskName}"`;
			results.push({ success: false, message: `Задача ${ref} не найдена` });
			continue;
		}

		const label = ACTION_LABELS[action.action] ?? action.action;

		switch (action.action) {
			case 'delete': {
				await deleteTask(task.id, userId);
				results.push({ success: true, message: `🗑 ${label}: ${task.title}` });
				break;
			}
			case 'complete': {
				await completeTask(task.id, userId);
				results.push({ success: true, message: `✅ ${label}: ${task.title}` });
				break;
			}
			case 'rename': {
				const newTitle = action.newTitle ?? task.title;
				await renameTask(task.id, userId, newTitle);
				results.push({
					success: true,
					message: `✏️ ${label}: "${task.title}" → "${newTitle}"`,
				});
				break;
			}
			case 'move_project': {
				const newProject = action.newProject ?? task.project.name;
				await moveTaskToProject(task.id, userId, newProject);
				results.push({
					success: true,
					message: `📂 ${label}: "${task.title}" → ${newProject}`,
				});
				break;
			}
			case 'change_deadline': {
				if (!action.newDeadline) {
					await updateTaskDeadline(task.id, userId, null);
					results.push({
						success: true,
						message: `📅 Дедлайн убран: ${task.title}`,
					});
				} else {
					const now = new Date();
					const isoStr = resolveDeadline(action.newDeadline, now, timezone);
					await updateTaskDeadline(task.id, userId, new Date(isoStr));
					const dateStr = new Date(isoStr).toLocaleString('ru-RU', {
						timeZone: timezone,
						day: '2-digit',
						month: '2-digit',
						year: 'numeric',
						hour: '2-digit',
						minute: '2-digit',
					});
					results.push({
						success: true,
						message: `📅 ${label}: "${task.title}" → ${dateStr}`,
					});
				}
				break;
			}
			default: {
				const _exhaustive: never = action.action;
				results.push({
					success: false,
					message: `Неизвестное действие: ${_exhaustive}`,
				});
			}
		}
	}

	return results;
}
