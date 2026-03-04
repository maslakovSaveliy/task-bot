import Groq from 'groq-sdk';
import { config, DEFAULT_PROJECT_NAME, GROQ_MODEL } from '../config.js';
import type { ParsedTask } from '../types/index.js';

const groq = new Groq({ apiKey: config.groqApiKey });

const SYSTEM_PROMPT = `You are a task parser for a Telegram task manager bot.
The user sends you a message in Russian (or any language) describing a task they want to add.
You must extract structured data from the message.

Current date and time: {currentDateTime}
User timezone: {timezone}

Return ONLY a valid JSON object with these fields:
- "task": string — the task title/description, cleaned up and concise
- "project": string — the project name. If the user mentions a project, use it. If not, use "${DEFAULT_PROJECT_NAME}"
- "dueDate": string | null — ISO 8601 datetime string for the deadline. Parse relative expressions:
  - "через час" = current time + 1 hour
  - "через два дня" = current date + 2 days
  - "в среду" = next Wednesday (or this Wednesday if today is before Wednesday)
  - "завтра в 10" = tomorrow at 10:00
  - "послезавтра" = day after tomorrow
  - "15 марта" = March 15 of current year (or next year if date has passed)
  - "в пятницу в 18:00" = this Friday at 18:00
  If no date/time is mentioned, set to null
- "remindAt": string | null — ISO 8601 datetime for reminder. If user says "напомни за час" or similar, calculate it relative to dueDate. If no reminder mentioned, set to null. If dueDate exists but no reminder specified, set remindAt to 1 hour before dueDate.
- "recurrence": "weekly" | "monthly" | "yearly" | null — set if user wants a RECURRING reminder.
  Detect patterns like: "каждую пятницу", "раз в неделю", "еженедельно", "каждый месяц", "раз в месяц", "ежемесячно", "раз в год", "ежегодно", "каждый год".
  If the task is recurring, dueDate and remindAt should be null.
- "recurrenceDay": number | null — for weekly: day of week (0=Sunday, 1=Monday..6=Saturday). For monthly: day of month (1-31). For yearly: day of month (1-31). null if not recurring.
- "recurrenceTime": string | null — time for the recurring reminder in "HH:MM" format (24h). If user doesn't specify time, default to "09:00". null if not recurring.

RECURRING EXAMPLES:
Input: "каждую пятницу в 10:00 созвон с командой"
Output: {"task":"Созвон с командой","project":"${DEFAULT_PROJECT_NAME}","dueDate":null,"remindAt":null,"recurrence":"weekly","recurrenceDay":5,"recurrenceTime":"10:00"}

Input: "раз в месяц 1 числа оплата квартиры"
Output: {"task":"Оплата квартиры","project":"${DEFAULT_PROJECT_NAME}","dueDate":null,"remindAt":null,"recurrence":"monthly","recurrenceDay":1,"recurrenceTime":"09:00"}

Input: "ежегодно 15 марта день рождения мамы"
Output: {"task":"День рождения мамы","project":"${DEFAULT_PROJECT_NAME}","dueDate":null,"remindAt":null,"recurrence":"yearly","recurrenceDay":15,"recurrenceTime":"09:00"}

REGULAR TASK EXAMPLES:
Input: "Написать тесты для API проект TaskBot до пятницы"
Output: {"task":"Написать тесты для API","project":"TaskBot","dueDate":"2026-03-06T23:59:00+03:00","remindAt":"2026-03-06T22:59:00+03:00","recurrence":null,"recurrenceDay":null,"recurrenceTime":null}

Input: "купить молоко"
Output: {"task":"Купить молоко","project":"${DEFAULT_PROJECT_NAME}","dueDate":null,"remindAt":null,"recurrence":null,"recurrenceDay":null,"recurrenceTime":null}

IMPORTANT: Return ONLY the JSON object, no markdown, no explanation, no extra text.`;

export async function parseTaskMessage(text: string, timezone: string): Promise<ParsedTask> {
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
		max_tokens: 400,
	});

	const content = completion.choices[0]?.message?.content;
	if (!content) {
		throw new Error('Empty response from AI');
	}

	const cleaned = content
		.replace(/```json\n?/g, '')
		.replace(/```\n?/g, '')
		.trim();

	const parsed: ParsedTask = JSON.parse(cleaned);

	return {
		task: parsed.task,
		project: parsed.project || DEFAULT_PROJECT_NAME,
		dueDate: parsed.dueDate ?? null,
		remindAt: parsed.remindAt ?? null,
		recurrence: parsed.recurrence ?? null,
		recurrenceDay: parsed.recurrenceDay ?? null,
		recurrenceTime: parsed.recurrenceTime ?? null,
	};
}
