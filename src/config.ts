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
	aiApiKey: process.env.AI_API_KEY || 'openai',
	aiBaseUrl: process.env.AI_BASE_URL || 'https://api.onlysq.ru/ai/openai/',
} as const;

export const AI_CHAT_MODEL = process.env.AI_CHAT_MODEL || 'gpt-4o-mini';
export const AI_STT_MODEL = process.env.AI_STT_MODEL || 'whisper-1';
export const REMINDER_CHECK_CRON = '* * * * *';
export const DEFAULT_PROJECT_NAME = 'General';
