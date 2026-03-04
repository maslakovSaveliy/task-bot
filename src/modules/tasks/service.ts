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
		where: { id: taskId, userId },
		data: { isCompleted: true },
	});
}

export async function deleteTask(taskId: number, userId: number) {
	return prisma.task.deleteMany({
		where: { id: taskId, userId },
	});
}

export async function getActiveTasks(userId: number): Promise<TaskWithProject[]> {
	return prisma.task.findMany({
		where: { userId, isCompleted: false },
		include: { project: true },
		orderBy: [{ project: { name: 'asc' } }, { dueDate: 'asc' }, { createdAt: 'asc' }],
	});
}

export async function getPendingReminders() {
	const now = new Date();
	return prisma.task.findMany({
		where: {
			isCompleted: false,
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
