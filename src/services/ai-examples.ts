import type { PlannerIntent } from '../types/index.js';

export interface PlannerExample {
	input: string;
	intent: PlannerIntent;
	output: string;
	tags: string[];
}

export const PLANNER_EXAMPLES: PlannerExample[] = [
	{
		input:
			'создай задачу для бота знакомств выкатить изменения и запустить оригинального бота. Также напомни про неё сегодня в 7 вечера',
		intent: 'new_tasks',
		output:
			'{"intent":"new_tasks","tasks":[{"task":"Выкатить изменения и запустить оригинального бота","project":"Бот знакомств","deadline":{"type":"today","time":"19:00"},"reminder":null,"recurrence":null}],"confidence":0.96,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['combined', 'project', 'today'],
	},
	{
		input: 'напомни сегодня в 18:00 про задачи 2 и 3',
		intent: 'actions',
		output:
			'{"intent":"actions","actions":[{"action":"set_reminder","taskNumber":2,"taskName":null,"newReminderAt":{"type":"today","time":"18:00"},"newReminderOffset":null},{"action":"set_reminder","taskNumber":3,"taskName":null,"newReminderAt":{"type":"today","time":"18:00"},"newReminderOffset":null}],"confidence":0.97,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['existing', 'reminder', 'multi'],
	},
	{
		input: 'закрой задачу 2 и создай задачу отправить отчёт завтра в 11:00',
		intent: 'mixed',
		output:
			'{"intent":"mixed","actions":[{"action":"complete","taskNumber":2,"taskName":null}],"tasks":[{"task":"Отправить отчёт","project":"General","deadline":{"type":"tomorrow","time":"11:00"},"reminder":null,"recurrence":null}],"confidence":0.88,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['mixed', 'complete', 'new_task'],
	},
	{
		input: 'переименуй задачу про оплату в проверить оплату и напомни за час',
		intent: 'clarify',
		output:
			'{"intent":"clarify","actions":[],"tasks":[],"confidence":0.32,"needsClarification":true,"clarificationQuestion":"Уточни, какую именно задачу про оплату нужно изменить и у какой задачи ставить напоминание за час?"}',
		tags: ['ambiguous', 'clarify'],
	},
	{
		input: 'бот знакомств\n- проверить оплату\n- добавить сообщения лайнапа',
		intent: 'new_tasks',
		output:
			'{"intent":"new_tasks","tasks":[{"task":"Проверить оплату","project":"Бот знакомств","deadline":null,"reminder":null,"recurrence":null},{"task":"Добавить сообщения лайнапа","project":"Бот знакомств","deadline":null,"reminder":null,"recurrence":null}],"confidence":0.95,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['bulk', 'project'],
	},
	{
		input: 'удали задачи 1 и 3',
		intent: 'actions',
		output:
			'{"intent":"actions","actions":[{"action":"delete","taskNumber":1,"taskName":null},{"action":"delete","taskNumber":3,"taskName":null}],"confidence":0.99,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['delete', 'multi'],
	},
	{
		input: 'напомни 6 марта 2026 года в 18:00 проверить задачи по боту',
		intent: 'new_tasks',
		output:
			'{"intent":"new_tasks","tasks":[{"task":"Проверить задачи по боту","project":"General","deadline":{"type":"date","day":6,"month":3,"year":2026,"time":"18:00"},"reminder":null,"recurrence":null}],"confidence":0.94,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['date', 'explicit'],
	},
	{
		input: 'задача купить молоко готова',
		intent: 'actions',
		output:
			'{"intent":"actions","actions":[{"action":"complete","taskNumber":null,"taskName":"купить молоко"}],"confidence":0.98,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['complete', 'by_name'],
	},
	{
		input: 'поменяй время на 16 часов',
		intent: 'actions',
		output:
			'{"intent":"actions","actions":[{"action":"change_deadline","taskNumber":null,"taskName":"Отправить отцу 3000","newDeadline":{"type":"tomorrow","time":"16:00"}}],"confidence":0.92,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['implicit_ref', 'change_deadline', 'context'],
	},
	{
		input: 'перенеси на послезавтра',
		intent: 'actions',
		output:
			'{"intent":"actions","actions":[{"action":"change_deadline","taskNumber":null,"taskName":"Купить молоко","newDeadline":{"type":"day_after_tomorrow","time":null}}],"confidence":0.90,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['implicit_ref', 'change_deadline', 'context'],
	},
	{
		input: 'верни обратно',
		intent: 'actions',
		output:
			'{"intent":"actions","actions":[{"action":"restore_last","taskNumber":null,"taskName":null}],"confidence":0.99,"needsClarification":false,"clarificationQuestion":null}',
		tags: ['restore', 'undo', 'context'],
	},
];
