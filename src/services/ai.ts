import OpenAI from 'openai';
import { AI_CHAT_MODEL, config, DEFAULT_PROJECT_NAME } from '../config.js';
import type {
	DeadlineExpression,
	ParsedTask,
	ParsedTaskRaw,
	ReminderExpression,
	TimeUnit,
} from '../types/index.js';

const ai = new OpenAI({ apiKey: config.aiApiKey, baseURL: config.aiBaseUrl });

const SYSTEM_PROMPT = `You are a task parser. Extract structured data from user messages.
Current weekday: {weekday}

Return a JSON ARRAY. Each element:
{
  "task": "clean task title",
  "project": "project name or ${DEFAULT_PROJECT_NAME}",
  "deadline": <DeadlineExpression or null>,
  "reminder": <ReminderExpression or null>,
  "recurrence": <RecurrenceExpression or null>
}

DEADLINE types (do NOT calculate dates, just classify):
- Relative time: {"type":"relative","amount":<N>,"unit":"minute|hour|day|week"}
  "через 2 минуты" → {"type":"relative","amount":2,"unit":"minute"}
  "через час" → {"type":"relative","amount":1,"unit":"hour"}
  "через полчаса" → {"type":"relative","amount":30,"unit":"minute"}
  "через 3 дня" → {"type":"relative","amount":3,"unit":"day"}
  "напомни через 5 минут" → deadline:{"type":"relative","amount":5,"unit":"minute"}
- Specific date: {"type":"date","day":<1-31>,"month":<1-12>,"year":<YYYY or null>,"time":"HH:MM" or null}
  "8 марта" → {"type":"date","day":8,"month":3,"year":null,"time":null}
  "15 января в 10:00" → {"type":"date","day":15,"month":1,"year":null,"time":"10:00"}
- Weekday: {"type":"weekday","weekday":<0-6 Sun-Sat>,"time":"HH:MM" or null}
  "в пятницу" → {"type":"weekday","weekday":5,"time":null}
  "до среды в 18:00" → {"type":"weekday","weekday":3,"time":"18:00"}
- Tomorrow: {"type":"tomorrow","time":"HH:MM" or null}
  "завтра в 10" → {"type":"tomorrow","time":"10:00"}
- Day after: {"type":"day_after_tomorrow","time":"HH:MM" or null}
- No deadline: null

REMINDER (advance, ONLY if user says "напомни за ...", "напомни заранее"):
- {"amount":<N>,"unit":"minute|hour|day"} — "напомни за день" → {"amount":1,"unit":"day"}
- null if not requested

RECURRENCE (for "каждый", "раз в", "еженедельно", "ежемесячно"):
- {"period":"weekly|monthly|yearly","dayOfWeek":<0-6 or null>,"dayOfMonth":<1-31 or null>,"time":"HH:MM" or null}
  "каждую пятницу в 10:00" → {"period":"weekly","dayOfWeek":5,"dayOfMonth":null,"time":"10:00"}
  "раз в месяц 1 числа" → {"period":"monthly","dayOfWeek":null,"dayOfMonth":1,"time":null}
- If recurring, deadline and reminder must be null.
- If time not specified, set time to null.

RULES:
- Multiple tasks (bullets, list, categories) → return ALL as separate objects.
- Category/heading names before tasks = project names.
- Single task → still return array with one element.
- Return ONLY JSON, no markdown, no text.

EXAMPLES:
Input: "купить молоко"
Output: [{"task":"Купить молоко","project":"${DEFAULT_PROJECT_NAME}","deadline":null,"reminder":null,"recurrence":null}]

Input: "через 2 минуты снять с плиты"
Output: [{"task":"Снять с плиты","project":"${DEFAULT_PROJECT_NAME}","deadline":{"type":"relative","amount":2,"unit":"minute"},"reminder":null,"recurrence":null}]

Input: "на 8 марта поздравить маму"
Output: [{"task":"Поздравить маму","project":"${DEFAULT_PROJECT_NAME}","deadline":{"type":"date","day":8,"month":3,"year":null,"time":null},"reminder":null,"recurrence":null}]

Input: "сдать отчёт до пятницы, напомни за день"
Output: [{"task":"Сдать отчёт","project":"${DEFAULT_PROJECT_NAME}","deadline":{"type":"weekday","weekday":5,"time":null},"reminder":{"amount":1,"unit":"day"},"recurrence":null}]

Input: "каждую пятницу в 10:00 созвон"
Output: [{"task":"Созвон","project":"${DEFAULT_PROJECT_NAME}","deadline":null,"reminder":null,"recurrence":{"period":"weekly","dayOfWeek":5,"dayOfMonth":null,"time":"10:00"}}]

Input: "Work\\n- тесты\\n- баг\\nЛичное\\n- молоко"
Output: [{"task":"Тесты","project":"Work","deadline":null,"reminder":null,"recurrence":null},{"task":"Баг","project":"Work","deadline":null,"reminder":null,"recurrence":null},{"task":"Молоко","project":"Личное","deadline":null,"reminder":null,"recurrence":null}]`;

// --- JSON extraction ---

function extractJsonArray(raw: string): ParsedTaskRaw[] {
	const arrayStart = raw.indexOf('[');
	const objectStart = raw.indexOf('{');

	if (arrayStart === -1 && objectStart === -1) {
		throw new Error(`No JSON found in AI response: ${raw.slice(0, 200)}`);
	}

	const isArray = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart);
	const openChar = isArray ? '[' : '{';
	const closeChar = isArray ? ']' : '}';
	const start = isArray ? arrayStart : objectStart;

	let depth = 0;
	for (let i = start; i < raw.length; i++) {
		if (raw[i] === openChar) depth++;
		if (raw[i] === closeChar) depth--;
		if (depth === 0) {
			const parsed = JSON.parse(raw.slice(start, i + 1)) as ParsedTaskRaw | ParsedTaskRaw[];
			return Array.isArray(parsed) ? parsed : [parsed];
		}
	}

	throw new Error(`Unclosed JSON in AI response: ${raw.slice(0, 200)}`);
}

// --- Time resolution (code does all the math) ---

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
	return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

function p(parts: Record<string, string>, key: string): string {
	return parts[key] ?? '0';
}

function parseHM(time: string | null, defaultH: number, defaultM: number): [number, number] {
	if (!time) return [defaultH, defaultM];
	const segments = time.split(':');
	return [Number(segments[0] ?? defaultH), Number(segments[1] ?? defaultM)];
}

function toIsoWithOffset(date: Date, timezone: string): string {
	const parts = getLocalParts(date, timezone);

	const offsetFmt = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		timeZoneName: 'shortOffset',
	});
	const tzPart = offsetFmt.formatToParts(date).find((pt) => pt.type === 'timeZoneName');
	const rawOffset = tzPart?.value?.replace('GMT', '') || '+00:00';
	const offset =
		rawOffset === '' ? '+00:00' : rawOffset.includes(':') ? rawOffset : `${rawOffset}:00`;

	return `${p(parts, 'year')}-${p(parts, 'month')}-${p(parts, 'day')}T${p(parts, 'hour')}:${p(parts, 'minute')}:${p(parts, 'second')}${offset}`;
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
	const localHour = Number.parseInt(p(parts, 'hour'), 10);
	const diffMs = (localHour - hour) * 3_600_000;
	return new Date(guess.getTime() - diffMs);
}

function resolveDeadline(deadline: DeadlineExpression, now: Date, timezone: string): string {
	const parts = getLocalParts(now, timezone);
	const localYear = Number.parseInt(p(parts, 'year'), 10);
	const localMonth = Number.parseInt(p(parts, 'month'), 10);
	const localDay = Number.parseInt(p(parts, 'day'), 10);

	switch (deadline.type) {
		case 'relative': {
			const ms = deadline.amount * UNIT_MS[deadline.unit];
			return toIsoWithOffset(new Date(now.getTime() + ms), timezone);
		}

		case 'tomorrow': {
			const [h, m] = parseHM(deadline.time, 12, 0);
			const tmrw = buildDateInTimezone(timezone, localYear, localMonth, localDay + 1, h, m);
			return toIsoWithOffset(tmrw, timezone);
		}

		case 'day_after_tomorrow': {
			const [h, m] = parseHM(deadline.time, 12, 0);
			const dat = buildDateInTimezone(timezone, localYear, localMonth, localDay + 2, h, m);
			return toIsoWithOffset(dat, timezone);
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
			const target = buildDateInTimezone(
				timezone,
				localYear,
				localMonth,
				localDay + daysAhead,
				h,
				m,
			);
			return toIsoWithOffset(target, timezone);
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

// --- Main parse function ---

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

export async function parseTaskMessage(text: string, timezone: string): Promise<ParsedTask[]> {
	const now = new Date();

	const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const localParts = getLocalParts(now, timezone);
	const localDate = buildDateInTimezone(
		timezone,
		Number.parseInt(p(localParts, 'year'), 10),
		Number.parseInt(p(localParts, 'month'), 10),
		Number.parseInt(p(localParts, 'day'), 10),
		12,
		0,
	);
	const weekday = weekdays[localDate.getDay()] ?? 'Monday';

	const systemPrompt = SYSTEM_PROMPT.replace('{weekday}', weekday);

	const completion = await ai.chat.completions.create({
		model: AI_CHAT_MODEL,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: text },
		],
		temperature: 0.1,
		max_tokens: 2048,
	});

	const content = completion.choices[0]?.message?.content;
	if (!content) {
		throw new Error('Empty response from AI');
	}

	const rawTasks = extractJsonArray(content);
	return rawTasks.map((raw) => rawToFinal(raw, now, timezone));
}
