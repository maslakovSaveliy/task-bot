import { DEFAULT_PROJECT_NAME } from '../../config.js';
import { prisma } from '../../db/client.js';
import type { TaskWithProject } from '../../types/index.js';

export async function ensureUser(telegramId: bigint, chatId: bigint) {
	return prisma.user.upsert({
		where: { telegramId },
		update: { chatId },
		create: { telegramId, chatId },
	});
}

export async function ensureProject(name: string, userId: number) {
	return prisma.project.upsert({
		where: { name_userId: { name, userId } },
		update: {},
		create: { name, userId },
	});
}

export async function createTask(
	title: string,
	projectId: number,
	userId: number,
	dueDate: Date | null,
	remindAt: Date | null,
) {
	return prisma.task.create({
		data: {
			title,
			projectId,
			userId,
			dueDate,
			remindAt,
		},
		include: { project: true },
	});
}

export async function completeTask(taskId: number, userId: number) {
	return prisma.task.updateMany({
		where: { id: taskId, userId, isDeleted: false },
		data: { isCompleted: true, completedAt: new Date() },
	});
}

export async function deleteTask(taskId: number, userId: number) {
	return prisma.task.updateMany({
		where: { id: taskId, userId, isDeleted: false },
		data: { isDeleted: true, deletedAt: new Date() },
	});
}

export async function getTaskById(taskId: number, userId: number) {
	return prisma.task.findFirst({
		where: { id: taskId, userId },
		include: { project: true },
	});
}

export async function getActiveTasks(userId: number): Promise<TaskWithProject[]> {
	return prisma.task.findMany({
		where: { userId, isCompleted: false, isDeleted: false },
		include: { project: true },
		orderBy: [{ project: { name: 'asc' } }, { dueDate: 'asc' }, { createdAt: 'asc' }],
	});
}

export async function getPendingReminders() {
	const now = new Date();
	return prisma.task.findMany({
		where: {
			isCompleted: false,
			isDeleted: false,
			isReminded: false,
			remindAt: { lte: now },
		},
		include: { user: true, project: true },
	});
}

export async function markAsReminded(taskId: number) {
	return prisma.task.update({
		where: { id: taskId },
		data: { isReminded: true },
	});
}

export async function getPendingDueReminders() {
	const now = new Date();
	return prisma.task.findMany({
		where: {
			isCompleted: false,
			isDeleted: false,
			isDueReminded: { equals: false },
			dueDate: { lte: now },
		},
		include: { user: true, project: true },
	});
}

export async function markAsDueReminded(taskId: number) {
	return prisma.task.update({
		where: { id: taskId },
		data: { isDueReminded: { set: true } },
	});
}

export async function updatePinnedMessageId(userId: number, messageId: number) {
	return prisma.user.update({
		where: { id: userId },
		data: { pinnedMessageId: messageId },
	});
}

export async function getUserByTelegramId(telegramId: bigint) {
	return prisma.user.findUnique({ where: { telegramId } });
}

export async function updateUserTimezone(userId: number, timezone: string) {
	return prisma.user.update({
		where: { id: userId },
		data: { timezone, isOnboarded: true },
	});
}

export async function renameTask(taskId: number, userId: number, newTitle: string) {
	return prisma.task.updateMany({
		where: { id: taskId, userId },
		data: { title: newTitle },
	});
}

export async function findExistingProject(userId: number, name: string) {
	const exact = await prisma.project.findUnique({
		where: { name_userId: { name, userId } },
	});
	if (exact) return exact;

	const userProjects = await prisma.project.findMany({ where: { userId } });
	const needle = name.toLowerCase();
	return userProjects.find((p) => p.name.toLowerCase() === needle) ?? null;
}

export async function moveTaskToProject(taskId: number, userId: number, newProjectName: string) {
	const existing = await findExistingProject(userId, newProjectName);
	const project = existing ?? (await ensureProject(newProjectName, userId));
	return prisma.task.updateMany({
		where: { id: taskId, userId },
		data: { projectId: project.id },
	});
}

export async function updateTaskDeadline(taskId: number, userId: number, newDueDate: Date | null) {
	return prisma.task.updateMany({
		where: { id: taskId, userId },
		data: { dueDate: newDueDate, isDueReminded: false },
	});
}

export async function updateTaskReminder(taskId: number, userId: number, newRemindAt: Date | null) {
	return prisma.task.updateMany({
		where: { id: taskId, userId },
		data: { remindAt: newRemindAt, isReminded: false },
	});
}

export async function restoreTask(taskId: number, userId: number) {
	return prisma.task.updateMany({
		where: { id: taskId, userId },
		data: {
			isCompleted: false,
			completedAt: null,
			isDeleted: false,
			deletedAt: null,
		},
	});
}

export async function getLastRestorableTask(userId: number) {
	const [lastDeleted, lastCompleted] = await Promise.all([
		prisma.task.findFirst({
			where: { userId, isDeleted: true },
			include: { project: true },
			orderBy: { deletedAt: 'desc' },
		}),
		prisma.task.findFirst({
			where: { userId, isCompleted: true, isDeleted: false },
			include: { project: true },
			orderBy: { completedAt: 'desc' },
		}),
	]);

	const deletedAt = lastDeleted?.deletedAt?.getTime() ?? -1;
	const completedAt = lastCompleted?.completedAt?.getTime() ?? -1;
	return deletedAt >= completedAt ? lastDeleted : lastCompleted;
}

export async function addTaskFromParsed(
	telegramId: bigint,
	chatId: bigint,
	taskTitle: string,
	projectName: string,
	dueDate: string | null,
	remindAt: string | null,
) {
	const user = await ensureUser(telegramId, chatId);
	const resolvedProjectName = projectName || DEFAULT_PROJECT_NAME;
	const project = await ensureProject(resolvedProjectName, user.id);

	const dueDateParsed = dueDate ? new Date(dueDate) : null;
	const remindAtParsed = remindAt ? new Date(remindAt) : null;

	return createTask(taskTitle, project.id, user.id, dueDateParsed, remindAtParsed);
}
