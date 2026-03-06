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
Current local date: {localDate}

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
- Today: {"type":"today","time":"HH:MM" or null}
- Tomorrow: {"type":"tomorrow","time":"HH:MM" or null}
- Day after: {"type":"day_after_tomorrow","time":"HH:MM" or null}
- null if no deadline

REMINDER (ONLY if user says "напомни за ...", "напомни заранее"):
- {"amount":<N>,"unit":"minute|hour|day"} or null

RECURRENCE ("каждый", "раз в", "еженедельно", "напомни мне каждый месяц N числа"):
- {"period":"weekly|monthly|yearly","dayOfWeek":<0-6 or null>,"dayOfMonth":<1-31 or null>,"time":"HH:MM" or null}
- "каждый месяц 5 числа напоминай мне X" → recurrence monthly, dayOfMonth:5, task:X
- "раз в месяц 1 числа X" → recurrence monthly, dayOfMonth:1, task:X
- "каждую пятницу в 10:00 X" → recurrence weekly, dayOfWeek:5, time:"10:00", task:X
- If recurring, deadline and reminder must be null.

=== IF intent = "actions" ===

Return: {"intent":"actions","actions":[...]}

Each action object:
{
  "action": "delete|complete|rename|move_project|change_deadline|set_reminder",
  "taskNumber": <number from list or null>,
  "taskName": "partial task name or null",
  "newTitle": "new title (for rename only)",
  "newProject": "project name (for move_project only)",
  "newDeadline": <DeadlineExpression or null (for change_deadline only)>,
  "newReminderAt": <DeadlineExpression or null (for set_reminder absolute time only)>,
  "newReminderOffset": <ReminderExpression or null (for set_reminder relative "за час/за день")>
}

Action examples:
- "удали задачу 3" → {"action":"delete","taskNumber":3,"taskName":null}
- "удали купить молоко" → {"action":"delete","taskNumber":null,"taskName":"купить молоко"}
- "задача 1 готова" → {"action":"complete","taskNumber":1,"taskName":null}
- "переименуй задачу 2 в Позвонить маме" → {"action":"rename","taskNumber":2,"taskName":null,"newTitle":"Позвонить маме"}
- "перенеси задачу 1 в проект Работа" → {"action":"move_project","taskNumber":1,"taskName":null,"newProject":"Работа"}
- "перенеси дедлайн задачи 2 на завтра" → {"action":"change_deadline","taskNumber":2,"taskName":null,"newDeadline":{"type":"tomorrow","time":null}}
- "напомни сегодня в 18:00 про задачу 2" → {"action":"set_reminder","taskNumber":2,"taskName":null,"newReminderAt":{"type":"today","time":"18:00"},"newReminderOffset":null}
- "напомни за час про задачи 2 и 3" → two set_reminder actions with newReminderOffset {"amount":1,"unit":"hour"}
- "удали все задачи из General" → multiple delete actions for each task in General

CRITICAL RULES:
- "напомни через X <что-то>" = new_tasks with deadline relative, NOT an action.
- "напомни ... про задачу N" or "напомни ... про задачи N и M" = actions with action "set_reminder".
- "удали", "убери", "выполни", "готово", "переименуй", "перенеси в проект", "измени дедлайн" = actions.
- "сегодня" must be returned as {"type":"today"} and interpreted relative to Current local date above.
- Explicit dates like "6 марта 2026", "06.03.2026", "6 марта в 18:00" must preserve the exact day/month/year from the user text. Do not guess or swap day/month.
- Multiple tasks/actions in one message → return ALL of them. Do NOT skip any.
- When user sends a list with categories/headings followed by bullet points (•, -, *), EACH bullet point is a SEPARATE task. The heading is the project name. Parse ALL tasks from ALL categories.
- For move_project: use EXACT project name from the "Current user tasks" list above (e.g. if list shows [ВПН], use "ВПН", NOT "VPN"). Match the existing project name precisely.
- For new tasks with project names: if user mentions a project that looks like an existing one (same meaning, different script), use the EXISTING project name from the list.
- Single item → still wrap in array.
- Return ONLY JSON. No markdown, no backticks, no explanation.

EXAMPLES:

Input: "купить молоко"
Output: {"intent":"new_tasks","tasks":[{"task":"Купить молоко","project":"${DEFAULT_PROJECT_NAME}","deadline":null,"reminder":null,"recurrence":null}]}

Input: "напомни через 2 минуты снять сковородку"
Output: {"intent":"new_tasks","tasks":[{"task":"Снять сковородку","project":"${DEFAULT_PROJECT_NAME}","deadline":{"type":"relative","amount":2,"unit":"minute"},"reminder":null,"recurrence":null}]}

Input: "напомни сегодня в 18:00 проверить задачи по боту"
Output: {"intent":"new_tasks","tasks":[{"task":"Проверить задачи по боту","project":"${DEFAULT_PROJECT_NAME}","deadline":{"type":"today","time":"18:00"},"reminder":null,"recurrence":null}]}

Input: "напомни 6 марта 2026 года в 18:00 проверить задачи по боту"
Output: {"intent":"new_tasks","tasks":[{"task":"Проверить задачи по боту","project":"${DEFAULT_PROJECT_NAME}","deadline":{"type":"date","day":6,"month":3,"year":2026,"time":"18:00"},"reminder":null,"recurrence":null}]}

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

Input: "напомни сегодня в 18:00 про задачи 2 и 3"
Output: {"intent":"actions","actions":[{"action":"set_reminder","taskNumber":2,"taskName":null,"newReminderAt":{"type":"today","time":"18:00"},"newReminderOffset":null},{"action":"set_reminder","taskNumber":3,"taskName":null,"newReminderAt":{"type":"today","time":"18:00"},"newReminderOffset":null}]}

Input: "Work\\n- тесты\\n- баг"
Output: {"intent":"new_tasks","tasks":[{"task":"Тесты","project":"Work","deadline":null,"reminder":null,"recurrence":null},{"task":"Баг","project":"Work","deadline":null,"reminder":null,"recurrence":null}]}

Input: "Круги\\n• задача 1\\n\\nРабота\\n• задача 2\\n- задача 3\\n• задача 4\\n\\nЛичное\\n• задача 5"
Output: {"intent":"new_tasks","tasks":[{"task":"Задача 1","project":"Круги","deadline":null,"reminder":null,"recurrence":null},{"task":"Задача 2","project":"Работа","deadline":null,"reminder":null,"recurrence":null},{"task":"Задача 3","project":"Работа","deadline":null,"reminder":null,"recurrence":null},{"task":"Задача 4","project":"Работа","deadline":null,"reminder":null,"recurrence":null},{"task":"Задача 5","project":"Личное","deadline":null,"reminder":null,"recurrence":null}]}

Input: "каждый месяц 5 числа напоминай мне скинуть бате 14 тысяч рублей"
Output: {"intent":"new_tasks","tasks":[{"task":"Скинуть бате 14 тысяч рублей","project":"${DEFAULT_PROJECT_NAME}","deadline":null,"reminder":null,"recurrence":{"period":"monthly","dayOfWeek":null,"dayOfMonth":5,"time":null}}]}

Input: "раз в месяц 1 числа оплата квартиры"
Output: {"intent":"new_tasks","tasks":[{"task":"Оплата квартиры","project":"${DEFAULT_PROJECT_NAME}","deadline":null,"reminder":null,"recurrence":{"period":"monthly","dayOfWeek":null,"dayOfMonth":1,"time":null}}]}

Input: "каждую пятницу в 10:00 созвон"
Output: {"intent":"new_tasks","tasks":[{"task":"Созвон","project":"${DEFAULT_PROJECT_NAME}","deadline":null,"reminder":null,"recurrence":{"period":"weekly","dayOfWeek":5,"dayOfMonth":null,"time":"10:00"}}]}`;

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

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

function toTime(
	hours: string | number | undefined,
	minutes: string | number | undefined,
): string | null {
	if (hours === undefined || minutes === undefined) return null;
	return `${pad2(Number(hours))}:${pad2(Number(minutes))}`;
}

function resolveRussianMonth(rawMonth: string): number | null {
	const month = rawMonth.toLowerCase();
	if (month.startsWith('январ')) return 1;
	if (month.startsWith('феврал')) return 2;
	if (month.startsWith('март')) return 3;
	if (month.startsWith('апрел')) return 4;
	if (month.startsWith('ма')) return 5;
	if (month.startsWith('июн')) return 6;
	if (month.startsWith('июл')) return 7;
	if (month.startsWith('август')) return 8;
	if (month.startsWith('сентябр')) return 9;
	if (month.startsWith('октябр')) return 10;
	if (month.startsWith('ноябр')) return 11;
	if (month.startsWith('декабр')) return 12;
	return null;
}

function extractExplicitDeadline(text: string): DeadlineExpression | null {
	const todayMatch = text.match(/\bсегодня\b(?:\s*(?:в|на)?\s*(\d{1,2})[:.](\d{2}))?/i);
	if (todayMatch) {
		return {
			type: 'today',
			time: toTime(todayMatch[1], todayMatch[2]),
		};
	}

	const numericDateMatch = text.match(
		/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?(?:\s*(?:года|г\.))?(?:\s*(?:в|на)?\s*(\d{1,2})[:.](\d{2}))?/i,
	);
	if (numericDateMatch) {
		const day = Number(numericDateMatch[1]);
		const month = Number(numericDateMatch[2]);
		if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
			return {
				type: 'date',
				day,
				month,
				year: numericDateMatch[3] ? Number(numericDateMatch[3]) : null,
				time: toTime(numericDateMatch[4], numericDateMatch[5]),
			};
		}
	}

	const monthNameMatch = text.match(
		/\b(\d{1,2})\s+(январ(?:я|ь)|феврал(?:я|ь)|март(?:а)?|апрел(?:я|ь)|ма(?:я|й)|июн(?:я|ь)|июл(?:я|ь)|август(?:а)?|сентябр(?:я|ь)|октябр(?:я|ь)|ноябр(?:я|ь)|декабр(?:я|ь))(?:\s+(\d{4}))?(?:\s*(?:года|г\.))?(?:\s*(?:в|на)?\s*(\d{1,2})[:.](\d{2}))?/i,
	);
	if (monthNameMatch) {
		const month = resolveRussianMonth(monthNameMatch[2] ?? '');
		if (month) {
			return {
				type: 'date',
				day: Number(monthNameMatch[1]),
				month,
				year: monthNameMatch[3] ? Number(monthNameMatch[3]) : null,
				time: toTime(monthNameMatch[4], monthNameMatch[5]),
			};
		}
	}

	return null;
}

function extractRelativeReminder(text: string): ReminderExpression | null {
	const match = text.match(
		/\bза\s+(?:(\d+)\s+)?(минут[ауы]?|минуту|час(?:а|ов)?|д(?:е)?нь|дня|дней|недел(?:ю|и|ь))\b/i,
	);
	if (!match) return null;

	const unitRaw = match[2]?.toLowerCase() ?? '';
	const amount = match[1] ? Number(match[1]) : 1;
	let unit: TimeUnit | null = null;
	if (unitRaw.startsWith('минут')) unit = 'minute';
	if (unitRaw.startsWith('час')) unit = 'hour';
	if (unitRaw === 'день' || unitRaw.startsWith('дн')) unit = 'day';
	if (unitRaw.startsWith('недел')) unit = 'week';
	return unit ? { amount, unit } : null;
}

function buildReminderActionsFromText(text: string): TaskActionRaw[] | null {
	if (!/\bнапомн/i.test(text) || !/\bпро\b/i.test(text)) return null;

	const referencePart = text.match(/\bпро\s+задач(?:у|и)?\s+(.+)$/i)?.[1];
	if (!referencePart) return null;

	const taskNumbers = Array.from(referencePart.matchAll(/\d+/g), (match) =>
		Number(match[0]),
	).filter((value) => Number.isFinite(value));
	if (taskNumbers.length === 0) return null;

	const newReminderOffset = extractRelativeReminder(text);
	const newReminderAt = newReminderOffset ? null : extractExplicitDeadline(text);
	if (!newReminderOffset && !newReminderAt) return null;

	return taskNumbers.map((taskNumber) => ({
		action: 'set_reminder',
		taskNumber,
		taskName: null,
		newReminderAt,
		newReminderOffset,
	}));
}

function normalizeParsedResult(text: string, parsed: AIParseResult): AIParseResult {
	const reminderActions = buildReminderActionsFromText(text);
	if (reminderActions) {
		return { intent: 'actions', actions: reminderActions };
	}

	const explicitDeadline = extractExplicitDeadline(text);
	if (!explicitDeadline) return parsed;

	if (parsed.intent === 'actions') {
		return {
			intent: 'actions',
			actions: parsed.actions.map((action) => {
				if (action.action === 'change_deadline') {
					return { ...action, newDeadline: explicitDeadline };
				}
				if (action.action === 'set_reminder' && !action.newReminderOffset) {
					return { ...action, newReminderAt: explicitDeadline };
				}
				return action;
			}),
		};
	}

	return {
		intent: 'new_tasks',
		tasks: parsed.tasks.map((task) =>
			task.recurrence ? task : { ...task, deadline: explicitDeadline },
		),
	};
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
		case 'today': {
			const [h, m] = parseHM(deadline.time, 23, 59);
			return toIsoWithOffset(
				buildDateInTimezone(timezone, localYear, localMonth, localDay, h, m),
				timezone,
			);
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
	const localDateString = `${lp(localParts, 'year')}-${lp(localParts, 'month')}-${lp(localParts, 'day')}`;
	const taskContext = buildTaskContext(currentTasks);

	const systemPrompt = SYSTEM_PROMPT.replace('{weekday}', weekday)
		.replace('{localDate}', localDateString)
		.replace('{taskContext}', taskContext);

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

	const parsed = normalizeParsedResult(text, extractJson(content));
	console.log('[AI parsed]', JSON.stringify(parsed));

	if (parsed.intent === 'actions') {
		return { intent: 'actions', actions: parsed.actions };
	}

	const tasks = parsed.tasks.map((raw) => rawToFinal(raw, now, timezone));
	return { intent: 'new_tasks', tasks };
}
