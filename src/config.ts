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
	groqApiKey: getEnvOrThrow('GROQ_API_KEY'),
} as const;

export const GROQ_MODEL = 'llama-3.1-8b-instant';
export const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';
export const REMINDER_CHECK_CRON = '* * * * *';
export const DEFAULT_PROJECT_NAME = 'General';
