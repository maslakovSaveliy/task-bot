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
	sttApiKey: process.env.STT_API_KEY || process.env.AI_API_KEY || 'openai',
	sttBaseUrl: process.env.STT_BASE_URL || '',
} as const;

export const AI_CHAT_MODEL = process.env.AI_CHAT_MODEL || 'llama3.1-8b';
export const AI_STT_MODEL = process.env.AI_STT_MODEL || 'whisper-large-v3-turbo';
export const REMINDER_CHECK_CRON = '* * * * *';
export const DEFAULT_PROJECT_NAME = 'General';
