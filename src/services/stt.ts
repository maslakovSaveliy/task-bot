import OpenAI from 'openai';
import { AI_STT_MODEL, config } from '../config.js';

const ai = new OpenAI({ apiKey: config.aiApiKey, baseURL: config.aiBaseUrl });

export async function transcribeAudio(audioBuffer: ArrayBuffer, filename: string): Promise<string> {
	const file = new File([audioBuffer], filename, { type: 'audio/ogg' });

	const transcription = await ai.audio.transcriptions.create({
		model: AI_STT_MODEL,
		file,
		language: 'ru',
	});

	return transcription.text;
}
