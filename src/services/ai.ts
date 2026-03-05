import OpenAI from 'openai';
import { AI_CHAT_MODEL, config, DEFAULT_PROJECT_NAME } from '../config.js';
import type {
	AIParseResult,
	DeadlineExpression,
	ParsedTask,
	ParsedTaskRaw,
	ReminderExpression,
	TaskActionRaw,
	TaskWithProject,
	TimeUnit,
} from '../types/index.js';

const ai = new OpenAI({ apiKey: config.aiApiKey, baseURL: config.aiBaseUrl });

// --- Prompt ---

const SYSTEM_PROMPT = `You are a Telegram task bot assistant. Classify the user message and return JSON.
Current weekday: {weekday}

{taskContext}

STEP 1: Determine intent.
- If the message describes NEW tasks to create → intent = "new_tasks"
- If the message describes ACTIONS on existing tasks (delete, complete, rename, move, change deadline) → intent = "actions"

STEP 2: Return the appropriate JSON.

=== IF intent = "new_tasks" ===

Return: {"intent":"new_tasks","tasks":[...]}

Each task object:
{
  "task": "clean task title",
  "project": "project name or ${DEFAULT_PROJECT_NAME}",
  "deadline": <DeadlineExpression or null>,
  "reminder": <ReminderExpression or null>,
  "recurrence": <RecurrenceExpression or null>
}

DEADLINE types (do NOT calculate dates, just classify):
- Relative: {"type":"relative","amount":<N>,"unit":"minute|hour|day|week"}
- Date: {"type":"date","day":<1-31>,"month":<1-12>,"year":<YYYY or null>,"time":"HH:MM" or null}
- Weekday: {"type":"weekday","weekday":<0-6 Sun-Sat>,"time":"HH:MM" or null}
- Tomorrow: {"type":"tomorrow","time":"HH:MM" or null}
- Day after: {"type":"day_after_tomorrow","time":"HH:MM" or null}
- null if no deadline

REMINDER (ONLY if user says "напомни за ...", "напомни заранее"):
- {"amount":<N>,"unit":"minute|hour|day"} or null

RECURRENCE ("каждый", "раз в", "еженедельно"):
- {"period":"weekly|monthly|yearly","dayOfWeek":<0-6 or null>,"dayOfMonth":<1-31 or null>,"time":"HH:MM" or null}
- If recurring, deadline and reminder must be null.

=== IF intent = "actions" ===

Return: {"intent":"actions","actions":[...]}

Each action object:
{
  "action": "delete|complete|rename|move_project|change_deadline",
  "taskNumber": <number from list or null>,
  "taskName": "partial task name or null",
  "newTitle": "new title (for rename only)",
  "newProject": "project name (for move_project only)",
  "newDeadline": <DeadlineExpression or null (for change_deadline only)>
}

Action examples:
- "удали задачу 3" → {"action":"delete","taskNumber":3,"taskName":null}
- "удали купить молоко" → {"action":"delete","taskNumber":null,"taskName":"купить молоко"}
- "задача 1 готова" → {"action":"complete","taskNumber":1,"taskName":null}
- "переименуй задачу 2 в Позвонить маме" → {"action":"rename","taskNumber":2,"taskName":null,"newTitle":"Позвонить маме"}
- "перенеси задачу 1 в проект Работа" → {"action":"move_project","taskNumber":1,"taskName":null,"newProject":"Работа"}
- "перенеси дедлайн задачи 2 на завтра" → {"action":"change_deadline","taskNumber":2,"taskName":null,"newDeadline":{"type":"tomorrow","time":null}}
- "удали все задачи из General" → multiple delete actions for each task in General

CRITICAL RULES:
- "напомни через X <что-то>" = new_tasks with deadline relative, NOT an action.
- "удали", "убери", "выполни", "готово", "переименуй", "перенеси в проект", "измени дедлайн" = actions.
- Multiple tasks/actions in one message → return ALL of them. Do NOT skip any.
- When user sends a list with categories/headings followed by bullet points (•, -, *), EACH bullet point is a SEPARATE task. The heading is the project name. Parse ALL tasks from ALL categories.
- Single item → still wrap in array.
- Return ONLY JSON. No markdown, no backticks, no explanation.

EXAMPLES:

Input: "купить молоко"
Output: {"intent":"new_tasks","tasks":[{"task":"Купить молоко","project":"${DEFAULT_PROJECT_NAME}","deadline":null,"reminder":null,"recurrence":null}]}

Input: "напомни через 2 минуты снять сковородку"
Output: {"intent":"new_tasks","tasks":[{"task":"Снять сковородку","project":"${DEFAULT_PROJECT_NAME}","deadline":{"type":"relative","amount":2,"unit":"minute"},"reminder":null,"recurrence":null}]}

Input: "удали задачу 3"
Output: {"intent":"actions","actions":[{"action":"delete","taskNumber":3,"taskName":null}]}

Input: "задача купить молоко готова"
Output: {"intent":"actions","actions":[{"action":"complete","taskNumber":null,"taskName":"купить молоко"}]}

Input: "переименуй задачу 1 в Купить кефир"
Output: {"intent":"actions","actions":[{"action":"rename","taskNumber":1,"taskName":null,"newTitle":"Купить кефир"}]}

Input: "перенеси задачу 2 в проект Личное"
Output: {"intent":"actions","actions":[{"action":"move_project","taskNumber":2,"taskName":null,"newProject":"Личное"}]}

Input: "перенеси дедлайн задачи 1 на пятницу"
Output: {"intent":"actions","actions":[{"action":"change_deadline","taskNumber":1,"taskName":null,"newDeadline":{"type":"weekday","weekday":5,"time":null}}]}

Input: "удали задачи 1 и 3"
Output: {"intent":"actions","actions":[{"action":"delete","taskNumber":1,"taskName":null},{"action":"delete","taskNumber":3,"taskName":null}]}

Input: "Work\\n- тесты\\n- баг"
Output: {"intent":"new_tasks","tasks":[{"task":"Тесты","project":"Work","deadline":null,"reminder":null,"recurrence":null},{"task":"Баг","project":"Work","deadline":null,"reminder":null,"recurrence":null}]}

Input: "Круги\\n• задача 1\\n\\nРабота\\n• задача 2\\n- задача 3\\n• задача 4\\n\\nЛичное\\n• задача 5"
Output: {"intent":"new_tasks","tasks":[{"task":"Задача 1","project":"Круги","deadline":null,"reminder":null,"recurrence":null},{"task":"Задача 2","project":"Работа","deadline":null,"reminder":null,"recurrence":null},{"task":"Задача 3","project":"Работа","deadline":null,"reminder":null,"recurrence":null},{"task":"Задача 4","project":"Работа","deadline":null,"reminder":null,"recurrence":null},{"task":"Задача 5","project":"Личное","deadline":null,"reminder":null,"recurrence":null}]}`;

// --- JSON extraction ---

function extractJson(raw: string): AIParseResult {
	const objectStart = raw.indexOf('{');
	if (objectStart === -1) {
		throw new Error(`No JSON found in AI response: ${raw.slice(0, 200)}`);
	}

	let depth = 0;
	for (let i = objectStart; i < raw.length; i++) {
		if (raw[i] === '{') depth++;
		if (raw[i] === '}') depth--;
		if (depth === 0) {
			return JSON.parse(raw.slice(objectStart, i + 1)) as AIParseResult;
		}
	}

	throw new Error(`Unclosed JSON in AI response: ${raw.slice(0, 200)}`);
}

// --- Time resolution ---

const UNIT_MS: Record<TimeUnit, number> = {
	minute: 60_000,
	hour: 3_600_000,
	day: 86_400_000,
	week: 604_800_000,
};

function getLocalParts(date: Date, timezone: string): Record<string, string> {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
	return Object.fromEntries(fmt.formatToParts(date).map((pt) => [pt.type, pt.value]));
}

function lp(parts: Record<string, string>, key: string): string {
	return parts[key] ?? '0';
}

function parseHM(time: string | null, defaultH: number, defaultM: number): [number, number] {
	if (!time) return [defaultH, defaultM];
	const segments = time.split(':');
	return [Number(segments[0] ?? defaultH), Number(segments[1] ?? defaultM)];
}

function normalizeUtcOffset(raw: string): string {
	if (!raw || raw === '') return '+00:00';
	const sign = raw[0] === '-' ? '-' : '+';
	const digits = raw.replace(/[^0-9:]/g, '');
	const parts = digits.split(':');
	const hours = (parts[0] ?? '0').padStart(2, '0');
	const minutes = (parts[1] ?? '00').padStart(2, '0');
	return `${sign}${hours}:${minutes}`;
}

function toIsoWithOffset(date: Date, timezone: string): string {
	const parts = getLocalParts(date, timezone);
	const offsetFmt = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		timeZoneName: 'shortOffset',
	});
	const tzPart = offsetFmt.formatToParts(date).find((pt) => pt.type === 'timeZoneName');
	const rawOffset = tzPart?.value?.replace('GMT', '') || '';
	const offset = normalizeUtcOffset(rawOffset);
	return `${lp(parts, 'year')}-${lp(parts, 'month')}-${lp(parts, 'day')}T${lp(parts, 'hour')}:${lp(parts, 'minute')}:${lp(parts, 'second')}${offset}`;
}

function buildDateInTimezone(
	timezone: string,
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
): Date {
	const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
	const parts = getLocalParts(guess, timezone);
	const localHour = Number.parseInt(lp(parts, 'hour'), 10);
	const diffMs = (localHour - hour) * 3_600_000;
	return new Date(guess.getTime() - diffMs);
}

export function resolveDeadline(deadline: DeadlineExpression, now: Date, timezone: string): string {
	const parts = getLocalParts(now, timezone);
	const localYear = Number.parseInt(lp(parts, 'year'), 10);
	const localMonth = Number.parseInt(lp(parts, 'month'), 10);
	const localDay = Number.parseInt(lp(parts, 'day'), 10);

	switch (deadline.type) {
		case 'relative': {
			const ms = deadline.amount * UNIT_MS[deadline.unit];
			return toIsoWithOffset(new Date(now.getTime() + ms), timezone);
		}
		case 'tomorrow': {
			const [h, m] = parseHM(deadline.time, 12, 0);
			return toIsoWithOffset(
				buildDateInTimezone(timezone, localYear, localMonth, localDay + 1, h, m),
				timezone,
			);
		}
		case 'day_after_tomorrow': {
			const [h, m] = parseHM(deadline.time, 12, 0);
			return toIsoWithOffset(
				buildDateInTimezone(timezone, localYear, localMonth, localDay + 2, h, m),
				timezone,
			);
		}
		case 'weekday': {
			const localDow = buildDateInTimezone(
				timezone,
				localYear,
				localMonth,
				localDay,
				12,
				0,
			).getDay();
			let daysAhead = (deadline.weekday - localDow + 7) % 7;
			if (daysAhead === 0) daysAhead = 7;
			const [h, m] = parseHM(deadline.time, 23, 59);
			return toIsoWithOffset(
				buildDateInTimezone(timezone, localYear, localMonth, localDay + daysAhead, h, m),
				timezone,
			);
		}
		case 'date': {
			const year = deadline.year ?? localYear;
			const [h, m] = parseHM(deadline.time, 12, 0);
			let target = buildDateInTimezone(timezone, year, deadline.month, deadline.day, h, m);
			if (!deadline.year && target.getTime() < now.getTime()) {
				target = buildDateInTimezone(timezone, year + 1, deadline.month, deadline.day, h, m);
			}
			return toIsoWithOffset(target, timezone);
		}
		default: {
			const _exhaustive: never = deadline;
			return _exhaustive;
		}
	}
}

function resolveReminder(reminder: ReminderExpression, dueDateIso: string): string {
	const dueDate = new Date(dueDateIso);
	const ms = reminder.amount * UNIT_MS[reminder.unit];
	return new Date(dueDate.getTime() - ms).toISOString();
}

// --- Task context for AI ---

function buildTaskContext(tasks: TaskWithProject[]): string {
	if (tasks.length === 0) return 'User has no tasks.';

	const grouped = new Map<string, TaskWithProject[]>();
	for (const task of tasks) {
		const name = task.project.name;
		const arr = grouped.get(name);
		if (arr) arr.push(task);
		else grouped.set(name, [task]);
	}

	const lines: string[] = ['Current user tasks:'];
	let index = 1;
	for (const [projectName, projectTasks] of grouped) {
		for (const task of projectTasks) {
			const deadline = task.dueDate
				? ` | deadline: ${task.dueDate.toISOString().slice(0, 16)}`
				: '';
			lines.push(`${index}. ${task.title} [${projectName}]${deadline}`);
			index++;
		}
	}
	return lines.join('\n');
}

// --- Convert raw to final ---

function rawToFinal(raw: ParsedTaskRaw, now: Date, timezone: string): ParsedTask {
	const dueDate = raw.deadline ? resolveDeadline(raw.deadline, now, timezone) : null;
	const remindAt = raw.reminder && dueDate ? resolveReminder(raw.reminder, dueDate) : null;

	if (raw.recurrence) {
		return {
			task: raw.task,
			project: raw.project || DEFAULT_PROJECT_NAME,
			dueDate: null,
			remindAt: null,
			recurrence: raw.recurrence.period,
			recurrenceDay: raw.recurrence.dayOfWeek ?? raw.recurrence.dayOfMonth ?? null,
			recurrenceTime: raw.recurrence.time ?? '09:00',
		};
	}

	return {
		task: raw.task,
		project: raw.project || DEFAULT_PROJECT_NAME,
		dueDate,
		remindAt,
		recurrence: null,
		recurrenceDay: null,
		recurrenceTime: null,
	};
}

// --- Main parse function ---

export type UserMessageResult =
	| { intent: 'new_tasks'; tasks: ParsedTask[] }
	| { intent: 'actions'; actions: TaskActionRaw[] };

export async function parseUserMessage(
	text: string,
	timezone: string,
	currentTasks: TaskWithProject[],
): Promise<UserMessageResult> {
	const now = new Date();

	const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const localParts = getLocalParts(now, timezone);
	const localDate = buildDateInTimezone(
		timezone,
		Number.parseInt(lp(localParts, 'year'), 10),
		Number.parseInt(lp(localParts, 'month'), 10),
		Number.parseInt(lp(localParts, 'day'), 10),
		12,
		0,
	);
	const weekday = weekdays[localDate.getDay()] ?? 'Monday';
	const taskContext = buildTaskContext(currentTasks);

	const systemPrompt = SYSTEM_PROMPT.replace('{weekday}', weekday).replace(
		'{taskContext}',
		taskContext,
	);

	const completion = await ai.chat.completions.create({
		model: AI_CHAT_MODEL,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: text },
		],
		temperature: 0.1,
		max_tokens: 4096,
	});

	const content = completion.choices[0]?.message?.content;
	if (!content) {
		throw new Error('Empty response from AI');
	}

	console.log('[AI raw response]', content);

	const parsed = extractJson(content);
	console.log('[AI parsed]', JSON.stringify(parsed));

	if (parsed.intent === 'actions') {
		return { intent: 'actions', actions: parsed.actions };
	}

	const tasks = parsed.tasks.map((raw) => rawToFinal(raw, now, timezone));
	return { intent: 'new_tasks', tasks };
}
