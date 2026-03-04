import type { ConversationFlavor } from '@grammyjs/conversations';
import type { Context, SessionFlavor } from 'grammy';

export interface SessionData {
	awaitingInput: boolean;
}

export type BotContext = Context & SessionFlavor<SessionData> & ConversationFlavor<Context>;

export type RecurrenceType = 'weekly' | 'monthly' | 'yearly';

export interface ParsedTask {
	task: string;
	project: string;
	dueDate: string | null;
	remindAt: string | null;
	recurrence: RecurrenceType | null;
	recurrenceDay: number | null;
	recurrenceTime: string | null;
}

export interface TaskWithProject {
	id: number;
	title: string;
	dueDate: Date | null;
	remindAt: Date | null;
	isCompleted: boolean;
	project: {
		name: string;
	};
}
