import OpenAI from 'openai';
import {
	AI_AGENT_MODE,
	config,
	DEFAULT_PROJECT_NAME,
	FALLBACK_CHAT_MODEL,
	IS_GEMINI_COMPAT,
	IS_SECONDARY_GEMINI_COMPAT,
	PRIMARY_CHAT_MODEL,
	SECONDARY_CHAT_MODEL,
} from '../config.js';
import type {
	DeadlineExpression,
	ParsedTask,
	ParsedTaskRaw,
	PlannerResultRaw,
	ReminderExpression,
	TaskActionRaw,
	TaskWithProject,
	TimeUnit,
} from '../types/index.js';
import { PLANNER_EXAMPLES } from './ai-examples.js';

type PlannerProvider = {
	client: OpenAI;
	isGemini: boolean;
	label: string;
};

const primaryPlannerProvider: PlannerProvider = {
	client: new OpenAI({ apiKey: config.aiApiKey, baseURL: config.aiBaseUrl }),
	isGemini: IS_GEMINI_COMPAT,
	label: 'primary',
};

const secondaryPlannerProvider: PlannerProvider | null =
	config.secondaryAiApiKey && config.secondaryAiBaseUrl
		? {
				client: new OpenAI({
					apiKey: config.secondaryAiApiKey,
					baseURL: config.secondaryAiBaseUrl,
				}),
				isGemini: IS_SECONDARY_GEMINI_COMPAT,
				label: 'secondary',
			}
		: null;

const LOW_CONFIDENCE_THRESHOLD = 0.72;
const CLARIFY_CONFIDENCE_THRESHOLD = 0.45;
const FEW_SHOT_LIMIT = 3;

const PLANNER_SYSTEM_PROMPT = `You are the planning layer for a Telegram task bot.
You do not execute anything. You only produce a strict JSON plan for the executor.

Current weekday: {weekday}
Current local date: {localDate}

{taskContext}

Similar successful patterns:
{fewShotExamples}

Return exactly one JSON object with this shape:
{
  "intent": "new_tasks|actions|mixed|clarify",
  "tasks": [...],
  "actions": [...],
  "confidence": 0.0,
  "needsClarification": false,
  "clarificationQuestion": null
}

Rules:
- "new_tasks" means only create tasks/reminders/recurring tasks.
- "actions" means only actions on existing tasks.
- "mixed" means the message contains both new tasks and actions on existing tasks.
- "clarify" means the instruction is ambiguous or unsafe to execute.
- If the user creates a task and immediately asks to remind about the same new task, keep it as a single new task with deadline/reminder. Do not split that into mixed.
- If a destructive action is ambiguous, use intent "clarify".
- Always include confidence from 0 to 1.
- Always set needsClarification true when intent is "clarify".
- Return ONLY JSON.

Task object schema:
{
  "task": "clean task title",
  "project": "project name or ${DEFAULT_PROJECT_NAME}",
  "deadline": <DeadlineExpression or null>,
  "reminder": <ReminderExpression or null>,
  "recurrence": <RecurrenceExpression or null>
}

Action object schema:
{
  "action": "delete|complete|rename|move_project|change_deadline|set_reminder",
  "taskNumber": <number or null>,
  "taskName": "partial task name or null",
  "newTitle": "new title or omitted",
  "newProject": "project name or omitted",
  "newDeadline": <DeadlineExpression or null>,
  "newReminderAt": <DeadlineExpression or null>,
  "newReminderOffset": <ReminderExpression or null>
}

DeadlineExpression:
- Relative: {"type":"relative","amount":N,"unit":"minute|hour|day|week"}
- Date: {"type":"date","day":1-31,"month":1-12,"year":YYYY or null,"time":"HH:MM" or null}
- Weekday: {"type":"weekday","weekday":0-6,"time":"HH:MM" or null}
- Today: {"type":"today","time":"HH:MM" or null}
- Tomorrow: {"type":"tomorrow","time":"HH:MM" or null}
- Day after: {"type":"day_after_tomorrow","time":"HH:MM" or null}

ReminderExpression:
- {"amount":N,"unit":"minute|hour|day|week"}

Critical interpretation rules:
- "напомни через X <что-то>" is usually a new task with relative deadline, not an action on existing tasks.
- "напомни ... про задачу N" or "про задачи N и M" is an action "set_reminder".
- Explicit dates like "6 марта 2026", "06.03.2026", "6 марта в 18:00" must preserve exact day/month/year from the text.
- "сегодня" must map to {"type":"today"}.
- If the request is ambiguous, ask a short clarification question in Russian.
`;

const UNIT_MS: Record<TimeUnit, number> = {
	minute: 60_000,
	hour: 3_600_000,
	day: 86_400_000,
	week: 604_800_000,
};

function extractJson<T>(raw: string): T {
	const objectStart = raw.indexOf('{');
	if (objectStart === -1) {
		throw new Error(`No JSON found in AI response: ${raw.slice(0, 200)}`);
	}

	let depth = 0;
	for (let i = objectStart; i < raw.length; i++) {
		if (raw[i] === '{') depth++;
		if (raw[i] === '}') depth--;
		if (depth === 0) {
			return JSON.parse(raw.slice(objectStart, i + 1)) as T;
		}
	}

	throw new Error(`Unclosed JSON in AI response: ${raw.slice(0, 200)}`);
}

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

function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[“”«»"']/g, ' ')
		.replace(/[.,!?;:()[\]{}]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function tokenize(text: string): string[] {
	return normalizeText(text)
		.split(' ')
		.filter((word) => word.length > 1);
}

function similarityScore(left: string, right: string): number {
	const leftWords = new Set(tokenize(left));
	const rightWords = new Set(tokenize(right));
	if (leftWords.size === 0 || rightWords.size === 0) return 0;

	let overlap = 0;
	for (const word of leftWords) {
		if (rightWords.has(word)) overlap++;
	}
	return overlap / Math.max(leftWords.size, rightWords.size);
}

function buildFewShotExamples(text: string): string {
	const selected = [...PLANNER_EXAMPLES]
		.map((example) => ({ example, score: similarityScore(text, example.input) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, FEW_SHOT_LIMIT)
		.map(({ example }, index) => {
			return `Example ${index + 1}
Input: ${example.input}
Output: ${example.output}`;
		});

	if (selected.length === 0) return 'No few-shot examples selected.';
	return selected.join('\n\n');
}

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

function clampConfidence(value: number | undefined): number {
	if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}

function sanitizePlannerResult(parsed: PlannerResultRaw): PlannerResultRaw {
	const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
	const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
	let intent = parsed.intent;

	if (!intent) {
		if (tasks.length > 0 && actions.length > 0) intent = 'mixed';
		else if (actions.length > 0) intent = 'actions';
		else if (tasks.length > 0) intent = 'new_tasks';
		else intent = 'clarify';
	}

	if (intent === 'new_tasks' && actions.length > 0 && tasks.length > 0) intent = 'mixed';
	if (intent === 'actions' && tasks.length > 0 && actions.length > 0) intent = 'mixed';
	if (intent === 'mixed' && tasks.length === 0 && actions.length > 0) intent = 'actions';
	if (intent === 'mixed' && actions.length === 0 && tasks.length > 0) intent = 'new_tasks';

	return {
		intent,
		tasks,
		actions,
		confidence: clampConfidence(parsed.confidence),
		needsClarification: Boolean(parsed.needsClarification || intent === 'clarify'),
		clarificationQuestion: parsed.clarificationQuestion ?? null,
	};
}

function normalizeParsedResult(text: string, parsed: PlannerResultRaw): PlannerResultRaw {
	const normalized = sanitizePlannerResult(parsed);
	const reminderActions = buildReminderActionsFromText(text);
	if (reminderActions) {
		return sanitizePlannerResult({
			...normalized,
			intent: 'actions',
			actions: reminderActions,
			tasks: [],
			confidence: Math.max(normalized.confidence ?? 0.5, 0.9),
			needsClarification: false,
			clarificationQuestion: null,
		});
	}

	const explicitDeadline = extractExplicitDeadline(text);
	if (!explicitDeadline) return normalized;

	const tasks = (normalized.tasks ?? []).map((task) =>
		task.recurrence ? task : { ...task, deadline: explicitDeadline },
	);
	const actions = (normalized.actions ?? []).map((action) => {
		if (action.action === 'change_deadline') {
			return { ...action, newDeadline: explicitDeadline };
		}
		if (action.action === 'set_reminder' && !action.newReminderOffset) {
			return { ...action, newReminderAt: explicitDeadline };
		}
		return action;
	});

	return sanitizePlannerResult({ ...normalized, tasks, actions });
}

function hasConflictingActions(actions: TaskActionRaw[]): boolean {
	const seen = new Map<string, Set<string>>();
	for (const action of actions) {
		const key =
			action.taskNumber !== null ? `#${action.taskNumber}` : `name:${action.taskName ?? ''}`;
		const types = seen.get(key) ?? new Set<string>();
		types.add(action.action);
		seen.set(key, types);
	}

	for (const types of seen.values()) {
		if (types.has('delete') && types.size > 1) return true;
		if (types.has('complete') && (types.has('rename') || types.has('move_project'))) return true;
	}
	return false;
}

function isActionAmbiguous(action: TaskActionRaw, tasks: TaskWithProject[]): boolean {
	if (!action.taskName) return false;

	const needle = normalizeText(action.taskName);
	if (!needle) return false;

	const matches = tasks.filter((task) => {
		const title = normalizeText(task.title);
		return title === needle || title.includes(needle) || needle.includes(title);
	});
	return matches.length > 1;
}

function findFallbackReason(
	result: PlannerResultRaw,
	currentTasks: TaskWithProject[],
): string | null {
	if ((result.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD) return 'low_confidence';
	if (result.intent === 'mixed') return 'mixed_intent';
	if (result.needsClarification) return 'clarification_requested';
	if (hasConflictingActions(result.actions ?? [])) return 'conflicting_actions';
	if ((result.actions ?? []).some((action) => isActionAmbiguous(action, currentTasks))) {
		return 'ambiguous_action_target';
	}
	return null;
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

export type UserMessageResult =
	| { intent: 'new_tasks'; tasks: ParsedTask[] }
	| { intent: 'actions'; actions: TaskActionRaw[] }
	| { intent: 'mixed'; tasks: ParsedTask[]; actions: TaskActionRaw[] }
	| { intent: 'clarify'; message: string };

async function callPlanner(
	provider: PlannerProvider,
	model: string,
	systemPrompt: string,
	text: string,
): Promise<{ raw: string; parsed: PlannerResultRaw }> {
	const request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
		model,
		stream: false,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: text },
		],
	};

	// Gemini's OpenAI-compatible endpoint is stricter than OpenAI itself.
	// A minimal payload avoids spurious 400s on otherwise valid requests.
	if (!provider.isGemini) {
		request.temperature = 0.1;
		request.max_tokens = 4096;
	}

	const completion = await provider.client.chat.completions.create(request);

	const content = completion.choices[0]?.message?.content;
	if (!content) {
		throw new Error(`Empty response from AI model ${model}`);
	}

	console.log(`[AI planner raw][${provider.label}:${model}]`, content);
	const parsed = normalizeParsedResult(text, extractJson<PlannerResultRaw>(content));
	console.log(`[AI planner parsed][${provider.label}:${model}]`, JSON.stringify(parsed));
	return { raw: content, parsed };
}

function getErrorStatus(error: unknown): number | null {
	if (!error || typeof error !== 'object') {
		return null;
	}

	if ('status' in error && typeof error.status === 'number') {
		return error.status;
	}

	return null;
}

function clarificationMessage(result: PlannerResultRaw): string {
	return (
		result.clarificationQuestion ??
		'Уточни, что именно нужно сделать: изменить существующую задачу, создать новую или выполнить оба действия.'
	);
}

function finalizePlannerResult(
	result: PlannerResultRaw,
	now: Date,
	timezone: string,
): UserMessageResult {
	if (
		result.intent === 'clarify' ||
		result.needsClarification ||
		(result.confidence ?? 0) < CLARIFY_CONFIDENCE_THRESHOLD
	) {
		return { intent: 'clarify', message: clarificationMessage(result) };
	}

	const tasks = (result.tasks ?? []).map((raw) => rawToFinal(raw, now, timezone));
	const actions = result.actions ?? [];

	if (result.intent === 'actions') {
		return { intent: 'actions', actions };
	}

	if (result.intent === 'mixed') {
		return { intent: 'mixed', tasks, actions };
	}

	return { intent: 'new_tasks', tasks };
}

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
	const fewShotExamples = buildFewShotExamples(text);

	const systemPrompt = PLANNER_SYSTEM_PROMPT.replace('{weekday}', weekday)
		.replace('{localDate}', localDateString)
		.replace('{taskContext}', taskContext)
		.replace('{fewShotExamples}', fewShotExamples);

	let chosen: { raw: string; parsed: PlannerResultRaw };
	let finalModel = PRIMARY_CHAT_MODEL;
	let finalProvider = primaryPlannerProvider.label;
	let fallbackReason: string | null = null;

	try {
		chosen = await callPlanner(primaryPlannerProvider, PRIMARY_CHAT_MODEL, systemPrompt, text);
		fallbackReason = AI_AGENT_MODE ? findFallbackReason(chosen.parsed, currentTasks) : null;
	} catch (error) {
		if (secondaryPlannerProvider && SECONDARY_CHAT_MODEL) {
			console.error('[AI planner primary provider failed]', error);
			chosen = await callPlanner(
				secondaryPlannerProvider,
				SECONDARY_CHAT_MODEL,
				systemPrompt,
				text,
			);
			finalModel = SECONDARY_CHAT_MODEL;
			finalProvider = secondaryPlannerProvider.label;
			fallbackReason = null;
		} else {
			const status = getErrorStatus(error);
			const shouldRetryOnFallback =
				AI_AGENT_MODE &&
				!!FALLBACK_CHAT_MODEL &&
				FALLBACK_CHAT_MODEL !== PRIMARY_CHAT_MODEL &&
				(status === null || status >= 500);

			if (!shouldRetryOnFallback) {
				throw error;
			}
			fallbackReason = 'primary_planner_failed';
			console.error('[AI planner primary failed]', error);
			chosen = await callPlanner(primaryPlannerProvider, FALLBACK_CHAT_MODEL, systemPrompt, text);
			finalModel = FALLBACK_CHAT_MODEL;
		}
	}

	if (
		AI_AGENT_MODE &&
		fallbackReason &&
		FALLBACK_CHAT_MODEL &&
		FALLBACK_CHAT_MODEL !== PRIMARY_CHAT_MODEL
	) {
		console.log(
			`[AI planner fallback] primary=${PRIMARY_CHAT_MODEL} fallback=${FALLBACK_CHAT_MODEL} reason=${fallbackReason}`,
		);
		try {
			chosen = await callPlanner(primaryPlannerProvider, FALLBACK_CHAT_MODEL, systemPrompt, text);
			finalModel = FALLBACK_CHAT_MODEL;
			fallbackReason = null;
		} catch (error) {
			console.error('[AI planner fallback failed]', error);
		}
	}

	console.log(
		'[AI planner final]',
		JSON.stringify({
			provider: finalProvider,
			model: finalModel,
			intent: chosen.parsed.intent,
			confidence: chosen.parsed.confidence,
			needsClarification: chosen.parsed.needsClarification,
			actions: chosen.parsed.actions?.length ?? 0,
			tasks: chosen.parsed.tasks?.length ?? 0,
		}),
	);

	return finalizePlannerResult(chosen.parsed, now, timezone);
}
