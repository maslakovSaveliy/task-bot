import { resolveDeadline } from '../../services/ai.js';
import type { ActionResult, TaskActionRaw, TaskWithProject } from '../../types/index.js';
import {
	completeTask,
	deleteTask,
	findExistingProject,
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

const FUZZY_THRESHOLD = 0.55;

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

function findByName(name: string, tasks: TaskWithProject[]): TaskWithProject | undefined {
	const needle = name.toLowerCase();
	const exact = tasks.find((t) => t.title.toLowerCase() === needle);
	if (exact) return exact;

	const byIncludes = tasks.find((t) => t.title.toLowerCase().includes(needle));
	if (byIncludes) return byIncludes;

	let bestTask: TaskWithProject | undefined;
	let bestScore = 0;
	for (const task of tasks) {
		const score = scoreFuzzyMatch(name, task.title);
		if (score > bestScore) {
			bestScore = score;
			bestTask = task;
		}
	}

	if (bestTask && bestScore >= FUZZY_THRESHOLD) {
		console.log(`[Fuzzy match] "${name}" → "${bestTask.title}" (score=${bestScore.toFixed(2)})`);
		return bestTask;
	}

	return undefined;
}

function resolveTask(action: TaskActionRaw, tasks: TaskWithProject[]): TaskWithProject | undefined {
	if (action.taskName) {
		const byName = findByName(action.taskName, tasks);
		if (byName) {
			console.log(
				`[Action resolve] by name "${action.taskName}" → "${byName.title}" (id=${byName.id})`,
			);
			return byName;
		}
	}

	if (action.taskNumber !== null && action.taskNumber >= 1 && action.taskNumber <= tasks.length) {
		const byNumber = tasks[action.taskNumber - 1];
		if (byNumber) {
			console.log(
				`[Action resolve] by number #${action.taskNumber} → "${byNumber.title}" (id=${byNumber.id})`,
			);
		}
		return byNumber;
	}

	console.log(`[Action resolve] NOT FOUND: name="${action.taskName}", number=${action.taskNumber}`);
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
				const requestedProject = action.newProject ?? task.project.name;
				await moveTaskToProject(task.id, userId, requestedProject);
				const resolved = await findExistingProject(userId, requestedProject);
				const actualName = resolved?.name ?? requestedProject;
				results.push({
					success: true,
					message: `📂 ${label}: "${task.title}" → ${actualName}`,
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
