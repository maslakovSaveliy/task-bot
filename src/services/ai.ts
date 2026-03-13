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
	ActionLogEntry,
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

const ACTION_LABELS_EN: Record<string, string> = {
	create: 'created',
	delete: 'deleted',
	complete: 'completed',
	restore: 'restored',
	rename: 'renamed',
	move_project: 'moved',
	change_deadline: 'changed deadline',
	set_reminder: 'set reminder for',
};

function formatTimeAgo(date: Date, now: Date): string {
	const diffMs = now.getTime() - date.getTime();
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function buildActionContext(actions: ActionLogEntry[], now: Date): string {
	if (actions.length === 0) return 'No recent actions.';

	const lines = ['Recent user actions (newest first):'];
	for (let i = 0; i < actions.length; i++) {
		const entry = actions[i];
		if (!entry) continue;
		const label = ACTION_LABELS_EN[entry.action] ?? entry.action;
		const ago = formatTimeAgo(entry.createdAt, now);
		let detail = `"${entry.taskTitle}"`;
		if (entry.projectName) detail += ` (project: ${entry.projectName})`;

		const meta = entry.metadata;
		if (meta?.before && meta?.after) {
			const changes: string[] = [];
			const before = meta.before as Record<string, unknown>;
			const after = meta.after as Record<string, unknown>;
			for (const key of Object.keys(after)) {
				if (before[key] !== after[key]) {
					changes.push(`${key}: "${before[key]}" → "${after[key]}"`);
				}
			}
			if (changes.length > 0) detail += ` [${changes.join(', ')}]`;
		}

		lines.push(`${i + 1}. [${ago}] ${label} ${detail}`);
	}
	return lines.join('\n');
}

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
const FEW_SHOT_LIMIT = 3;

const PLANNER_SYSTEM_PROMPT = `You are the planning layer for a Telegram task bot.
You do not execute anything. You only produce a strict JSON plan for the executor.

Current weekday: {weekday}
Current local date: {localDate}

{taskContext}

{actionContext}

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
- "clarify" is allowed internally, but prefer a best-effort executable plan whenever the command is reasonably inferable.
- If the user creates a task and immediately asks to remind about the same new task, keep it as a single new task with deadline/reminder. Do not split that into mixed.
- Never ask the user a clarifying question. Prefer the most likely action from the text.
- Always include confidence from 0 to 1.
- Avoid needsClarification unless absolutely nothing executable can be derived.
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
  "action": "delete|complete|restore_last|rename|move_project|change_deadline|set_reminder",
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
- Never ask a clarification question. If nothing executable can be derived, return empty actions/tasks.

Context resolution rules:
- Use the "Recent user actions" to resolve contextual references.
- If the user says "эту задачу", "ту задачу", "предыдущую", "последнюю" — match against the most recent action from the action log.
- If the user says "верни", "отмени", "восстанови", "как было", "обратно" — produce action "restore_last".
- If the user mentions a task by partial name that exists in the action log (recently deleted/completed) but not in the active task list — resolve using the action log.
- Pronouns like "её", "его", "их" refer to the task(s) from the most recent action.
- "туда же" means the same project as the most recent action.
- IMPORTANT: If the message is a modification command (change time, rename, move, etc.) WITHOUT an explicit task reference (no task number, no task name), it is an ACTION on the task from the most recent action in the log, NOT a new task. Use taskName from the most recent action log entry to target the task.
- Examples of implicit references: "поменяй время на 16:00", "перенеси на завтра", "измени название на ...", "сдвинь дедлайн". These are all actions, not new tasks.
`;

const UNIT_MS: Record<TimeUnit, number> = {
	minute: 60_000,
	hour: 3_600_000,
	day: 86_400_000,
	week: 604_800_000,
};

function extractJsonSlice(raw: string): string {
	const objectStart = raw.indexOf('{');
	if (objectStart === -1) {
		throw new Error(`No JSON found in AI response: ${raw.slice(0, 200)}`);
	}

	let depth = 0;
	for (let i = objectStart; i < raw.length; i++) {
		if (raw[i] === '{') depth++;
		if (raw[i] === '}') depth--;
		if (depth === 0) {
			return raw.slice(objectStart, i + 1);
		}
	}

	throw new Error(`Unclosed JSON in AI response: ${raw.slice(0, 200)}`);
}

function repairJsonString(raw: string): string {
	let repaired = '';
	let inString = false;
	let isEscaped = false;

	for (const char of raw) {
		if (inString) {
			if (isEscaped) {
				repaired += char;
				isEscaped = false;
				continue;
			}

			if (char === '\\') {
				repaired += char;
				isEscaped = true;
				continue;
			}

			if (char === '"') {
				repaired += char;
				inString = false;
				continue;
			}

			if (char === '\n') {
				repaired += '\\n';
				continue;
			}

			if (char === '\r') {
				repaired += '\\r';
				continue;
			}

			if (char === '\t') {
				repaired += '\\t';
				continue;
			}

			repaired += char;
			continue;
		}

		if (char === '"') {
			inString = true;
		}
		repaired += char;
	}

	return repaired;
}

function extractJson<T>(raw: string): T {
	const jsonSlice = extractJsonSlice(raw);
	try {
		return JSON.parse(jsonSlice) as T;
	} catch (error) {
		const repaired = repairJsonString(jsonSlice);
		console.warn('[AI planner JSON repair]', error);
		return JSON.parse(repaired) as T;
	}
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

function clampConfidence(value: number | undefined): number {
	if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
	return Math.max(0, Math.min(1, value));
}

function readLooseString(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value.trim();
	if (value && typeof value === 'object') {
		const text = 'text' in value && typeof value.text === 'string' ? value.text : null;
		if (text) return text.trim();
	}
	return fallback;
}

function coerceReminder(value: unknown): ReminderExpression | null {
	if (!value || typeof value !== 'object') return null;
	const amount =
		'amount' in value && typeof value.amount === 'number' ? Math.max(1, value.amount) : null;
	const unit = 'unit' in value && typeof value.unit === 'string' ? value.unit : null;
	if (!amount || !unit) return null;
	if (unit !== 'minute' && unit !== 'hour' && unit !== 'day' && unit !== 'week') return null;
	return { amount, unit };
}

function parseIsoLikeDeadline(raw: string): DeadlineExpression | null {
	const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[tT\s](\d{2}):(\d{2})(?::\d{2})?)?$/);
	if (!match) return null;

	return {
		type: 'date',
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
		time: match[4] && match[5] ? `${match[4]}:${match[5]}` : null,
	};
}

function coerceDeadline(value: unknown): DeadlineExpression | null {
	if (!value || typeof value !== 'object') return null;
	const type = 'type' in value && typeof value.type === 'string' ? value.type : null;
	if (!type) return null;

	if (type === 'string') {
		const raw = readLooseString(value);
		return raw ? parseIsoLikeDeadline(raw) : null;
	}

	if (type === 'relative') {
		const amount = 'amount' in value && typeof value.amount === 'number' ? value.amount : null;
		const unit = 'unit' in value && typeof value.unit === 'string' ? value.unit : null;
		if (!amount || !unit) return null;
		if (unit !== 'minute' && unit !== 'hour' && unit !== 'day' && unit !== 'week') return null;
		return { type, amount, unit };
	}

	if (type === 'date') {
		const day = 'day' in value && typeof value.day === 'number' ? value.day : null;
		const month = 'month' in value && typeof value.month === 'number' ? value.month : null;
		const year =
			'year' in value && (typeof value.year === 'number' || value.year === null)
				? value.year
				: null;
		const time = 'time' in value && typeof value.time === 'string' ? value.time : null;
		if (!day || !month) return null;
		return { type, day, month, year, time };
	}

	if (type === 'weekday') {
		const weekday = 'weekday' in value && typeof value.weekday === 'number' ? value.weekday : null;
		const time = 'time' in value && typeof value.time === 'string' ? value.time : null;
		if (weekday === null) return null;
		return { type, weekday, time };
	}

	if (type === 'today' || type === 'tomorrow' || type === 'day_after_tomorrow') {
		const time = 'time' in value && typeof value.time === 'string' ? value.time : null;
		return { type, time };
	}

	return null;
}

function coerceRecurrence(value: unknown): ParsedTaskRaw['recurrence'] {
	if (!value || typeof value !== 'object') return null;
	const period = 'period' in value && typeof value.period === 'string' ? value.period : null;
	if (period !== 'weekly' && period !== 'monthly' && period !== 'yearly') return null;
	return {
		period,
		dayOfWeek: 'dayOfWeek' in value && typeof value.dayOfWeek === 'number' ? value.dayOfWeek : null,
		dayOfMonth:
			'dayOfMonth' in value && typeof value.dayOfMonth === 'number' ? value.dayOfMonth : null,
		time: 'time' in value && typeof value.time === 'string' ? value.time : null,
	};
}

function coerceTask(task: unknown): ParsedTaskRaw | null {
	if (!task || typeof task !== 'object') return null;
	const title = readLooseString('task' in task ? task.task : undefined);
	if (!title) return null;
	return {
		task: title,
		project: readLooseString('project' in task ? task.project : undefined, DEFAULT_PROJECT_NAME),
		deadline: coerceDeadline('deadline' in task ? task.deadline : null),
		reminder: coerceReminder('reminder' in task ? task.reminder : null),
		recurrence: coerceRecurrence('recurrence' in task ? task.recurrence : null),
	};
}

function coerceAction(action: unknown): TaskActionRaw | null {
	if (!action || typeof action !== 'object') return null;
	const actionType = 'action' in action && typeof action.action === 'string' ? action.action : null;
	if (
		actionType !== 'delete' &&
		actionType !== 'complete' &&
		actionType !== 'restore_last' &&
		actionType !== 'rename' &&
		actionType !== 'move_project' &&
		actionType !== 'change_deadline' &&
		actionType !== 'set_reminder'
	) {
		return null;
	}

	return {
		action: actionType,
		taskNumber:
			'taskNumber' in action && typeof action.taskNumber === 'number' ? action.taskNumber : null,
		taskName: readLooseString('taskName' in action ? action.taskName : undefined) || null,
		newTitle: readLooseString('newTitle' in action ? action.newTitle : undefined) || undefined,
		newProject:
			readLooseString('newProject' in action ? action.newProject : undefined) || undefined,
		newDeadline: coerceDeadline('newDeadline' in action ? action.newDeadline : null),
		newReminderAt: coerceDeadline('newReminderAt' in action ? action.newReminderAt : null),
		newReminderOffset: coerceReminder(
			'newReminderOffset' in action ? action.newReminderOffset : null,
		),
	};
}

function sanitizePlannerResult(parsed: PlannerResultRaw): PlannerResultRaw {
	const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
		.map((task) => coerceTask(task))
		.filter((task): task is ParsedTaskRaw => task !== null);
	const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
		.map((action) => coerceAction(action))
		.filter((action): action is TaskActionRaw => action !== null);
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
	const parsed = sanitizePlannerResult(extractJson<PlannerResultRaw>(content));
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
	return result.clarificationQuestion ?? 'Не удалось распознать команду.';
}

function finalizePlannerResult(
	result: PlannerResultRaw,
	now: Date,
	timezone: string,
): UserMessageResult {
	const tasks = (result.tasks ?? []).map((raw) => rawToFinal(raw, now, timezone));
	const actions = result.actions ?? [];

	if (result.intent === 'clarify' || result.needsClarification) {
		if (actions.length > 0 && tasks.length > 0) {
			return { intent: 'mixed', tasks, actions };
		}
		if (actions.length > 0) {
			return { intent: 'actions', actions };
		}
		if (tasks.length > 0) {
			return { intent: 'new_tasks', tasks };
		}
		return { intent: 'clarify', message: clarificationMessage(result) };
	}

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
	recentActions: ActionLogEntry[],
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
	const actionContext = buildActionContext(recentActions, now);
	const fewShotExamples = buildFewShotExamples(text);

	const systemPrompt = PLANNER_SYSTEM_PROMPT.replace('{weekday}', weekday)
		.replace('{localDate}', localDateString)
		.replace('{taskContext}', taskContext)
		.replace('{actionContext}', actionContext)
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
