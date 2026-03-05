import type { ConversationFlavor } from '@grammyjs/conversations';
import type { Context, SessionFlavor } from 'grammy';

export interface SessionData {
	awaitingInput: boolean;
}

export type BotContext = Context & SessionFlavor<SessionData> & ConversationFlavor<Context>;

export type RecurrenceType = 'weekly' | 'monthly' | 'yearly';

export type TimeUnit = 'minute' | 'hour' | 'day' | 'week';

export type DeadlineExpression =
	| { type: 'relative'; amount: number; unit: TimeUnit }
	| { type: 'date'; day: number; month: number; year: number | null; time: string | null }
	| { type: 'weekday'; weekday: number; time: string | null }
	| { type: 'tomorrow'; time: string | null }
	| { type: 'day_after_tomorrow'; time: string | null };

export interface ReminderExpression {
	amount: number;
	unit: TimeUnit;
}

export interface RecurrenceExpression {
	period: RecurrenceType;
	dayOfWeek: number | null;
	dayOfMonth: number | null;
	time: string | null;
}

export interface ParsedTaskRaw {
	task: string;
	project: string;
	deadline: DeadlineExpression | null;
	reminder: ReminderExpression | null;
	recurrence: RecurrenceExpression | null;
}

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

export type TaskActionType = 'delete' | 'complete' | 'rename' | 'move_project' | 'change_deadline';

export interface TaskActionRaw {
	action: TaskActionType;
	taskNumber: number | null;
	taskName: string | null;
	newTitle?: string;
	newProject?: string;
	newDeadline?: DeadlineExpression | null;
}

export type AIParseResult =
	| { intent: 'new_tasks'; tasks: ParsedTaskRaw[] }
	| { intent: 'actions'; actions: TaskActionRaw[] };

export interface ActionResult {
	success: boolean;
	message: string;
}
