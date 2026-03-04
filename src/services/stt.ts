import Groq from 'groq-sdk';
import { config, GROQ_WHISPER_MODEL } from '../config.js';

const groq = new Groq({ apiKey: config.groqApiKey });

export async function transcribeAudio(audioBuffer: ArrayBuffer, filename: string): Promise<string> {
	const file = new File([audioBuffer], filename, { type: 'audio/ogg' });

	const transcription = await groq.audio.transcriptions.create({
		model: GROQ_WHISPER_MODEL,
		file,
		language: 'ru',
	});

	return transcription.text;
}
