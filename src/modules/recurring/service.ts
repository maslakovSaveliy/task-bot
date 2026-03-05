import { prisma } from '../../db/client.js';
import type { Recurrence } from '../../generated/prisma/client.js';
import type { ParsedTask, RecurrenceType } from '../../types/index.js';

const RECURRENCE_MAP: Record<RecurrenceType, Recurrence> = {
	weekly: 'WEEKLY',
	monthly: 'MONTHLY',
	yearly: 'YEARLY',
};

function parseTime(timeStr: string): { hour: number; minute: number } {
	const [hourStr, minuteStr] = timeStr.split(':');
	return {
		hour: Number.parseInt(hourStr ?? '9', 10),
		minute: Number.parseInt(minuteStr ?? '0', 10),
	};
}

export function computeNextRunAt(
	recurrence: Recurrence,
	hour: number,
	minute: number,
	timezone: string,
	dayOfWeek?: number | null,
	dayOfMonth?: number | null,
	monthOfYear?: number | null,
): Date {
	const now = new Date();
	const localNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

	const targetLocal = computeNextLocalDate(
		recurrence,
		hour,
		minute,
		localNow,
		dayOfWeek,
		dayOfMonth,
		monthOfYear,
	);

	const offsetMs = targetLocal.getTime() - localNow.getTime();
	return new Date(now.getTime() + offsetMs);
}

function computeNextLocalDate(
	recurrence: Recurrence,
	hour: number,
	minute: number,
	localNow: Date,
	dayOfWeek?: number | null,
	dayOfMonth?: number | null,
	monthOfYear?: number | null,
): Date {
	const target = new Date(localNow);
	target.setHours(hour, minute, 0, 0);

	switch (recurrence) {
		case 'WEEKLY': {
			const targetDay = dayOfWeek ?? 1;
			const currentDay = localNow.getDay();
			let daysUntil = targetDay - currentDay;
			if (daysUntil < 0 || (daysUntil === 0 && target <= localNow)) {
				daysUntil += 7;
			}
			target.setDate(localNow.getDate() + daysUntil);
			return target;
		}
		case 'MONTHLY': {
			const targetDate = dayOfMonth ?? 1;
			target.setDate(targetDate);
			if (target <= localNow) {
				target.setMonth(target.getMonth() + 1);
			}
			return target;
		}
		case 'YEARLY': {
			const targetDate = dayOfMonth ?? 1;
			const targetMonth = (monthOfYear ?? 1) - 1;
			target.setMonth(targetMonth, targetDate);
			if (target <= localNow) {
				target.setFullYear(target.getFullYear() + 1);
			}
			return target;
		}
	}
}

export async function createRecurringFromParsed(
	userId: number,
	timezone: string,
	parsed: ParsedTask,
) {
	const recurrenceType = parsed.recurrence;
	if (!recurrenceType) {
		throw new Error('No recurrence type provided');
	}

	const prismaRecurrence = RECURRENCE_MAP[recurrenceType];
	const { hour, minute } = parseTime(parsed.recurrenceTime ?? '09:00');

	const nextRunAt = computeNextRunAt(
		prismaRecurrence,
		hour,
		minute,
		timezone,
		parsed.recurrenceDay,
		parsed.recurrenceDay,
		null,
	);

	return prisma.recurringTask.create({
		data: {
			title: parsed.task,
			userId,
			recurrence: prismaRecurrence,
			nextRunAt,
			hour,
			minute,
			dayOfWeek: recurrenceType === 'weekly' ? parsed.recurrenceDay : null,
			dayOfMonth: recurrenceType !== 'weekly' ? parsed.recurrenceDay : null,
			monthOfYear: null,
		},
	});
}

export async function getActiveRecurringTasks(userId: number) {
	return prisma.recurringTask.findMany({
		where: { userId, isActive: true },
		orderBy: { createdAt: 'asc' },
	});
}

export async function deactivateRecurringTask(taskId: number, userId: number) {
	return prisma.recurringTask.updateMany({
		where: { id: taskId, userId },
		data: { isActive: false },
	});
}

export async function deleteRecurringTask(taskId: number, userId: number) {
	return prisma.recurringTask.deleteMany({
		where: { id: taskId, userId },
	});
}

export async function getPendingRecurringTasks() {
	const now = new Date();
	return prisma.recurringTask.findMany({
		where: {
			isActive: true,
			nextRunAt: { lte: now },
		},
		include: { user: true },
	});
}

export async function advanceRecurringTask(taskId: number, timezone: string) {
	const task = await prisma.recurringTask.findUnique({ where: { id: taskId } });
	if (!task) return;

	const nextRunAt = computeNextRunAt(
		task.recurrence,
		task.hour,
		task.minute,
		timezone,
		task.dayOfWeek,
		task.dayOfMonth,
		task.monthOfYear,
	);

	return prisma.recurringTask.update({
		where: { id: taskId },
		data: { nextRunAt },
	});
}
