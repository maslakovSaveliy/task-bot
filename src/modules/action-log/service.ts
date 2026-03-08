import { prisma } from '../../db/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { ActionLogEntry, ActionLogMetadata, LoggedActionType } from '../../types/index.js';

const DEFAULT_CONTEXT_WINDOW = 5;
const EXTENDED_CONTEXT_WINDOW = 15;

const CONTEXTUAL_MARKERS =
	/\b(эту|эта|эти|это|ту|та|те|того|той|тех|предыдущ\w+|последн\w+|прошл\w+|верни|отмени|восстанови|как\s+было|обратно|её|его|их|туда\s+же)\b/i;

export function detectContextualReferences(text: string): boolean {
	return CONTEXTUAL_MARKERS.test(text);
}

export function getContextWindow(text: string): number {
	return detectContextualReferences(text) ? EXTENDED_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW;
}

export async function logAction(
	userId: number,
	action: LoggedActionType,
	taskId: number | null,
	taskTitle: string,
	projectName: string | null,
	metadata: ActionLogMetadata | null,
): Promise<void> {
	try {
		await prisma.actionLog.create({
			data: {
				userId,
				action,
				taskId,
				taskTitle,
				projectName,
				metadata: metadata ? (metadata as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
			},
		});
	} catch (error) {
		console.error('[ActionLog] Failed to log action:', error);
	}
}

export async function getRecentActions(userId: number, limit: number): Promise<ActionLogEntry[]> {
	const rows = await prisma.actionLog.findMany({
		where: { userId },
		orderBy: { createdAt: 'desc' },
		take: limit,
	});

	return rows.map((row) => ({
		id: row.id,
		userId: row.userId,
		action: row.action as LoggedActionType,
		taskId: row.taskId,
		taskTitle: row.taskTitle,
		projectName: row.projectName,
		metadata: row.metadata as ActionLogMetadata | null,
		createdAt: row.createdAt,
	}));
}
