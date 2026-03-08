import { resolveDeadline } from '../../services/ai.js';
import type {
	ActionResult,
	ReminderExpression,
	TaskActionRaw,
	TaskWithProject,
	TimeUnit,
} from '../../types/index.js';
import { logAction } from '../action-log/service.js';
import {
	completeTask,
	deleteTask,
	findExistingProject,
	getActiveTasks,
	getLastRestorableTask,
	moveTaskToProject,
	renameTask,
	restoreTask,
	updateTaskDeadline,
	updateTaskReminder,
} from './service.js';

const ACTION_LABELS: Record<string, string> = {
	delete: 'Удалена',
	complete: 'Выполнена',
	restore_last: 'Восстановлена',
	rename: 'Переименована',
	move_project: 'Перемещена',
	change_deadline: 'Дедлайн изменён',
	set_reminder: 'Напоминание установлено',
};

const FUZZY_THRESHOLD = 0.55;
const UNIT_MS: Record<TimeUnit, number> = {
	minute: 60_000,
	hour: 3_600_000,
	day: 86_400_000,
	week: 604_800_000,
};

function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const prev = new Array<number>(n + 1);
	const curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
			curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
		}
		for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
	}
	return prev[n] ?? 0;
}

function wordSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.startsWith(b) || b.startsWith(a)) return 0.85;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	return 1 - editDistance(a, b) / maxLen;
}

function scoreFuzzyMatch(needle: string, title: string): number {
	const needleWords = needle.toLowerCase().split(/\s+/).filter(Boolean);
	const titleWords = title.toLowerCase().split(/\s+/).filter(Boolean);
	if (needleWords.length === 0) return 0;

	let totalScore = 0;
	for (const nw of needleWords) {
		let bestWordScore = 0;
		for (const tw of titleWords) {
			bestWordScore = Math.max(bestWordScore, wordSimilarity(nw, tw));
		}
		totalScore += bestWordScore;
	}
	return totalScore / needleWords.length;
}

function dedupeTasks(tasks: TaskWithProject[]): TaskWithProject[] {
	return Array.from(new Map(tasks.map((task) => [task.id, task])).values());
}

function findByName(
	name: string,
	tasks: TaskWithProject[],
): TaskWithProject | 'ambiguous' | undefined {
	const needle = name.toLowerCase();
	const exactMatches = tasks.filter((task) => task.title.toLowerCase() === needle);
	if (exactMatches.length > 1) return 'ambiguous';
	if (exactMatches[0]) return exactMatches[0];

	const includesMatches = dedupeTasks(
		tasks.filter((task) => {
			const title = task.title.toLowerCase();
			return title.includes(needle) || needle.includes(title);
		}),
	);
	if (includesMatches.length > 1) return 'ambiguous';
	if (includesMatches[0]) return includesMatches[0];

	let bestTask: TaskWithProject | undefined;
	let bestScore = 0;
	let sameScoreCount = 0;
	for (const task of tasks) {
		const score = scoreFuzzyMatch(name, task.title);
		if (score > bestScore) {
			bestScore = score;
			bestTask = task;
			sameScoreCount = 1;
		} else if (score === bestScore && score > 0) {
			sameScoreCount++;
		}
	}

	if (bestTask && bestScore >= FUZZY_THRESHOLD) {
		if (sameScoreCount > 1) return 'ambiguous';
		console.log(`[Fuzzy match] "${name}" → "${bestTask.title}" (score=${bestScore.toFixed(2)})`);
		return bestTask;
	}

	return undefined;
}

function resolveTask(
	action: TaskActionRaw,
	tasks: TaskWithProject[],
): { task?: TaskWithProject; error?: string } {
	if (action.taskName) {
		const byName = findByName(action.taskName, tasks);
		if (byName === 'ambiguous') {
			return {
				error: `Найдено несколько задач по названию "${action.taskName}". Укажи номер задачи.`,
			};
		}
		if (byName) {
			console.log(
				`[Action resolve] by name "${action.taskName}" → "${byName.title}" (id=${byName.id})`,
			);
			return { task: byName };
		}
	}

	if (action.taskNumber !== null && action.taskNumber >= 1 && action.taskNumber <= tasks.length) {
		const byNumber = tasks[action.taskNumber - 1];
		if (byNumber) {
			console.log(
				`[Action resolve] by number #${action.taskNumber} → "${byNumber.title}" (id=${byNumber.id})`,
			);
		}
		return { task: byNumber };
	}

	console.log(`[Action resolve] NOT FOUND: name="${action.taskName}", number=${action.taskNumber}`);
	return {};
}

function formatDateTime(date: Date, timezone: string): string {
	return date.toLocaleString('ru-RU', {
		timeZone: timezone,
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

function resolveReminderOffset(reminder: ReminderExpression, dueDate: Date): Date {
	const ms = reminder.amount * UNIT_MS[reminder.unit];
	return new Date(dueDate.getTime() - ms);
}

export async function resolveAndExecuteActions(
	actions: TaskActionRaw[],
	userId: number,
	timezone: string,
): Promise<ActionResult[]> {
	const tasks = await getActiveTasks(userId);
	const results: ActionResult[] = [];

	for (const action of actions) {
		if (action.action === 'restore_last') {
			const lastTask = await getLastRestorableTask(userId);
			if (!lastTask) {
				results.push({ success: false, message: 'Нет задач для восстановления' });
				continue;
			}

			await restoreTask(lastTask.id, userId);
			await logAction(userId, 'restore', lastTask.id, lastTask.title, lastTask.project.name, null);
			results.push({
				success: true,
				message: `↩️ ${ACTION_LABELS.restore_last}: ${lastTask.title}`,
			});
			continue;
		}

		const { task, error } = resolveTask(action, tasks);
		if (error) {
			results.push({ success: false, message: error });
			continue;
		}
		if (!task) {
			const ref = action.taskNumber ? `#${action.taskNumber}` : `"${action.taskName}"`;
			results.push({ success: false, message: `Задача ${ref} не найдена` });
			continue;
		}

		const label = ACTION_LABELS[action.action] ?? action.action;

		switch (action.action) {
			case 'delete': {
				await deleteTask(task.id, userId);
				await logAction(userId, 'delete', task.id, task.title, task.project.name, null);
				results.push({ success: true, message: `🗑 ${label}: ${task.title}` });
				break;
			}
			case 'complete': {
				await completeTask(task.id, userId);
				await logAction(userId, 'complete', task.id, task.title, task.project.name, null);
				results.push({ success: true, message: `✅ ${label}: ${task.title}` });
				break;
			}
			case 'rename': {
				const newTitle = action.newTitle ?? task.title;
				await renameTask(task.id, userId, newTitle);
				await logAction(userId, 'rename', task.id, task.title, task.project.name, {
					before: { title: task.title },
					after: { title: newTitle },
				});
				results.push({
					success: true,
					message: `✏️ ${label}: "${task.title}" → "${newTitle}"`,
				});
				break;
			}
			case 'move_project': {
				const requestedProject = action.newProject ?? task.project.name;
				await moveTaskToProject(task.id, userId, requestedProject);
				const resolved = await findExistingProject(userId, requestedProject);
				const actualName = resolved?.name ?? requestedProject;
				await logAction(userId, 'move_project', task.id, task.title, actualName, {
					before: { project: task.project.name },
					after: { project: actualName },
				});
				results.push({
					success: true,
					message: `📂 ${label}: "${task.title}" → ${actualName}`,
				});
				break;
			}
			case 'change_deadline': {
				if (!action.newDeadline) {
					await updateTaskDeadline(task.id, userId, null);
					await logAction(userId, 'change_deadline', task.id, task.title, task.project.name, {
						before: { dueDate: task.dueDate?.toISOString() ?? null },
						after: { dueDate: null },
					});
					results.push({
						success: true,
						message: `📅 Дедлайн убран: ${task.title}`,
					});
				} else {
					const now = new Date();
					const isoStr = resolveDeadline(action.newDeadline, now, timezone);
					await updateTaskDeadline(task.id, userId, new Date(isoStr));
					await logAction(userId, 'change_deadline', task.id, task.title, task.project.name, {
						before: { dueDate: task.dueDate?.toISOString() ?? null },
						after: { dueDate: isoStr },
					});
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
			case 'set_reminder': {
				let remindAt: Date | null = null;

				if (action.newReminderOffset) {
					if (!task.dueDate) {
						results.push({
							success: false,
							message: `Нельзя поставить напоминание "за ..." для задачи без дедлайна: ${task.title}`,
						});
						break;
					}
					remindAt = resolveReminderOffset(action.newReminderOffset, task.dueDate);
				} else if (action.newReminderAt) {
					const now = new Date();
					remindAt = new Date(resolveDeadline(action.newReminderAt, now, timezone));
				}

				if (!remindAt) {
					results.push({
						success: false,
						message: `Не удалось определить время напоминания для задачи: ${task.title}`,
					});
					break;
				}

				if (remindAt.getTime() <= Date.now()) {
					results.push({
						success: false,
						message: `Время напоминания уже прошло: ${task.title}`,
					});
					break;
				}

				await updateTaskReminder(task.id, userId, remindAt);
				await logAction(userId, 'set_reminder', task.id, task.title, task.project.name, {
					before: { remindAt: task.remindAt?.toISOString() ?? null },
					after: { remindAt: remindAt.toISOString() },
				});
				results.push({
					success: true,
					message: `🔔 ${label}: "${task.title}" → ${formatDateTime(remindAt, timezone)}`,
				});
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
