import type { TaskWithProject } from '../../types/index.js';

function formatDate(date: Date, timezone: string): string {
	return date.toLocaleDateString('ru-RU', {
		day: '2-digit',
		month: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		timeZone: timezone,
	});
}

function formatTaskLine(task: TaskWithProject, index: number, timezone: string): string {
	const dateStr = task.dueDate ? ` | ${formatDate(task.dueDate, timezone)}` : '';
	return `  ${index}. ${task.title}${dateStr}`;
}

export function renderTaskList(tasks: TaskWithProject[], timezone: string): string {
	if (tasks.length === 0) {
		return '📋 *Список задач пуст*\n\nОтправьте текст или голосовое сообщение, чтобы добавить задачу.';
	}

	const grouped = new Map<string, TaskWithProject[]>();
	for (const task of tasks) {
		const projectName = task.project.name;
		const existing = grouped.get(projectName);
		if (existing) {
			existing.push(task);
		} else {
			grouped.set(projectName, [task]);
		}
	}

	const lines: string[] = ['📋 *Мои задачи*\n'];
	let globalIndex = 1;

	for (const [projectName, projectTasks] of grouped) {
		lines.push(`📁 *${escapeMarkdown(projectName)}*`);
		for (const task of projectTasks) {
			lines.push(formatTaskLine(task, globalIndex, timezone));
			globalIndex++;
		}
		lines.push('');
	}

	lines.push(`_Всего задач: ${tasks.length}_`);
	return lines.join('\n');
}

function escapeMarkdown(text: string): string {
	return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
