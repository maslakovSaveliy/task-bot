import 'dotenv/config';

function getEnvOrThrow(key: string): string {
	const value = process.env[key];
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value;
}

export const config = {
	botToken: getEnvOrThrow('BOT_TOKEN'),
	databaseUrl: getEnvOrThrow('DATABASE_URL'),
	aiApiKey: process.env.AI_API_KEY || process.env.GEMINI_API_KEY || 'openai',
	aiBaseUrl:
		process.env.AI_BASE_URL || process.env.GEMINI_BASE_URL || 'https://api.onlysq.ru/ai/openai/',
	sttApiKey: process.env.STT_API_KEY || process.env.AI_API_KEY || 'openai',
	sttBaseUrl: process.env.STT_BASE_URL || process.env.AI_BASE_URL || '',
} as const;

export const AI_AGENT_MODE = (process.env.AI_AGENT_MODE || 'true').toLowerCase() !== 'false';
export const PRIMARY_CHAT_MODEL =
	process.env.PRIMARY_CHAT_MODEL || process.env.AI_CHAT_MODEL || 'o3-mini';
export const FALLBACK_CHAT_MODEL = process.env.FALLBACK_CHAT_MODEL || 'gpt-4o';
export const PRIMARY_STT_MODEL =
	process.env.PRIMARY_STT_MODEL || process.env.AI_STT_MODEL || 'whisper-large-v3-turbo';
export const FALLBACK_STT_MODEL = process.env.FALLBACK_STT_MODEL || '';
export const AI_CHAT_MODEL = PRIMARY_CHAT_MODEL;
export const AI_STT_MODEL = PRIMARY_STT_MODEL;
export const REMINDER_CHECK_CRON = '* * * * *';
export const DEFAULT_PROJECT_NAME = 'General';
