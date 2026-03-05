import OpenAI from 'openai';
import { AI_STT_MODEL, config } from '../config.js';

const sttClient = config.sttBaseUrl
	? new OpenAI({ apiKey: config.sttApiKey, baseURL: config.sttBaseUrl })
	: null;

export function isSTTConfigured(): boolean {
	return sttClient !== null;
}

export async function transcribeAudio(audioBuffer: ArrayBuffer, filename: string): Promise<string> {
	if (!sttClient) {
		throw new Error('STT not configured: set STT_BASE_URL and STT_API_KEY');
	}

	const file = new File([audioBuffer], filename, { type: 'audio/ogg' });

	const transcription = await sttClient.audio.transcriptions.create({
		model: AI_STT_MODEL,
		file,
		language: 'ru',
	});

	return transcription.text;
}
