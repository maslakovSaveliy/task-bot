import Groq from 'groq-sdk';
import { config, DEFAULT_PROJECT_NAME, GROQ_MODEL } from '../config.js';
import type { ParsedTask } from '../types/index.js';

const groq = new Groq({ apiKey: config.groqApiKey });

const SYSTEM_PROMPT = `You are a task parser for a Telegram task manager bot.
The user sends you a message describing one or MULTIPLE tasks.
You must extract structured data from the message.

Current date and time: {currentDateTime}
User timezone: {timezone}

Return a JSON ARRAY of task objects. Each object has these fields:
- "task": string — the task title/description, cleaned up and concise
- "project": string — the project name if mentioned, otherwise "${DEFAULT_PROJECT_NAME}"
- "dueDate": string | null — ISO 8601 datetime for the deadline. ALWAYS parse dates from text. The bot will automatically remind at this time. null ONLY if no date/time at all.
  Date patterns to detect:
  - "через 5 минут" / "через 30 минут" → current time + N minutes
  - "через час" / "через 2 часа" → current time + N hours
  - "через 2 дня" → current date + 2 days
  - "завтра в 10" → tomorrow at 10:00
  - "послезавтра" → day after tomorrow
  - "до пятницы" / "в пятницу" → this/next Friday
  - "на 8 марта" / "к 8 марта" / "до 8 марта" / "8 марта" → March 8
  - "напомни через X" / "напомни мне через X" → dueDate = now + X (this is a reminder, NOT an advance reminder)
  If no time specified for a date, default to 12:00.
- "remindAt": string | null — ISO 8601 datetime for ADVANCE reminder, ONLY if user explicitly asks to be reminded ahead of time (e.g. "напомни за день", "напомни за 2 часа", "напомни заранее"). Calculate relative to dueDate. If user does NOT ask for advance reminder, set to null. Do NOT set automatically.
- "recurrence": "weekly" | "monthly" | "yearly" | null — for recurring tasks ("каждую пятницу", "раз в месяц", "ежегодно"). If recurring, dueDate and remindAt must be null.
- "recurrenceDay": number | null — for weekly: day of week (0=Sun..6=Sat). For monthly/yearly: day of month (1-31). null if not recurring.
- "recurrenceTime": string | null — "HH:MM" format (24h). Default "09:00" if recurring but time not specified. null if not recurring.

CRITICAL RULES:
- If the message contains MULTIPLE tasks (bullet points, numbered list, or tasks grouped by project/category), return ALL of them as separate objects in the array.
- Headings or category names before tasks are PROJECT names.
- Even for a single task, return it as an array with one element.

EXAMPLES:

Input: "купить молоко"
Output: [{"task":"Купить молоко","project":"${DEFAULT_PROJECT_NAME}","dueDate":null,"remindAt":null,"recurrence":null,"recurrenceDay":null,"recurrenceTime":null}]

Input: "напомни мне через 2 минуты напомнить"
Output: [{"task":"Напомнить","project":"${DEFAULT_PROJECT_NAME}","dueDate":"2026-03-04T14:42:00+03:00","remindAt":null,"recurrence":null,"recurrenceDay":null,"recurrenceTime":null}]

Input: "через 30 минут позвонить маме"
Output: [{"task":"Позвонить маме","project":"${DEFAULT_PROJECT_NAME}","dueDate":"2026-03-04T15:10:00+03:00","remindAt":null,"recurrence":null,"recurrenceDay":null,"recurrenceTime":null}]

Input: "на 8 марта маму поздравить"
Output: [{"task":"Поздравить маму","project":"${DEFAULT_PROJECT_NAME}","dueDate":"2026-03-08T12:00:00+03:00","remindAt":null,"recurrence":null,"recurrenceDay":null,"recurrenceTime":null}]

Input: "сдать отчёт до пятницы"
Output: [{"task":"Сдать отчёт","project":"${DEFAULT_PROJECT_NAME}","dueDate":"2026-03-06T23:59:00+03:00","remindAt":null,"recurrence":null,"recurrenceDay":null,"recurrenceTime":null}]

Input: "сдать отчёт до пятницы, напомни за день"
Output: [{"task":"Сдать отчёт","project":"${DEFAULT_PROJECT_NAME}","dueDate":"2026-03-06T23:59:00+03:00","remindAt":"2026-03-05T23:59:00+03:00","recurrence":null,"recurrenceDay":null,"recurrenceTime":null}]

Input: "каждую пятницу в 10:00 созвон с командой"
Output: [{"task":"Созвон с командой","project":"${DEFAULT_PROJECT_NAME}","dueDate":null,"remindAt":null,"recurrence":"weekly","recurrenceDay":5,"recurrenceTime":"10:00"}]

Input: "Work\\n- написать тесты\\n- починить баг\\nЛичное\\n- купить молоко"
Output: [{"task":"Написать тесты","project":"Work","dueDate":null,"remindAt":null,"recurrence":null,"recurrenceDay":null,"recurrenceTime":null},{"task":"Починить баг","project":"Work","dueDate":null,"remindAt":null,"recurrence":null,"recurrenceDay":null,"recurrenceTime":null},{"task":"Купить молоко","project":"Личное","dueDate":null,"remindAt":null,"recurrence":null,"recurrenceDay":null,"recurrenceTime":null}]

IMPORTANT: Return ONLY the JSON array, no markdown, no explanation, no extra text.`;

function extractJsonArray(raw: string): ParsedTask[] {
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
			const parsed = JSON.parse(raw.slice(start, i + 1)) as ParsedTask | ParsedTask[];
			return Array.isArray(parsed) ? parsed : [parsed];
		}
	}

	throw new Error(`Unclosed JSON in AI response: ${raw.slice(0, 200)}`);
}

function normalizeTask(raw: ParsedTask): ParsedTask {
	return {
		task: raw.task,
		project: raw.project || DEFAULT_PROJECT_NAME,
		dueDate: raw.dueDate ?? null,
		remindAt: raw.remindAt ?? null,
		recurrence: raw.recurrence ?? null,
		recurrenceDay: raw.recurrenceDay ?? null,
		recurrenceTime: raw.recurrenceTime ?? null,
	};
}

export async function parseTaskMessage(text: string, timezone: string): Promise<ParsedTask[]> {
	const now = new Date();
	const currentDateTime = now.toLocaleString('ru-RU', { timeZone: timezone });

	const systemPrompt = SYSTEM_PROMPT.replace('{currentDateTime}', currentDateTime).replace(
		'{timezone}',
		timezone,
	);

	const completion = await groq.chat.completions.create({
		model: GROQ_MODEL,
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

	const tasks = extractJsonArray(content);
	return tasks.map(normalizeTask);
}
