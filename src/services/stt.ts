import OpenAI from 'openai';
import { config, FALLBACK_STT_MODEL, PRIMARY_STT_MODEL } from '../config.js';

const sttClient = config.sttBaseUrl
	? new OpenAI({ apiKey: config.sttApiKey, baseURL: config.sttBaseUrl })
	: null;

export interface TranscriptionResult {
	text: string;
	rawText: string;
	normalizedText: string;
	model: string;
	fallbackReason: string | null;
}

export function isSTTConfigured(): boolean {
	return sttClient !== null;
}

export function normalizeTranscriptText(text: string): string {
	return text
		.replace(/[“”«»]/g, '"')
		.replace(/\s+/g, ' ')
		.replace(/\s+([,.;!?])/g, '$1')
		.trim();
}

function hasRepeatedTail(text: string): boolean {
	const normalized = normalizeTranscriptText(text).toLowerCase();
	const words = normalized.split(' ').filter(Boolean);
	if (words.length < 10) return false;

	const half = Math.floor(words.length / 2);
	const first = words.slice(0, half).join(' ');
	const second = words.slice(half).join(' ');
	return (
		first.length > 12 &&
		second.includes(first.slice(0, Math.max(12, Math.floor(first.length * 0.7))))
	);
}

function looksSuspicious(text: string): string | null {
	const normalized = normalizeTranscriptText(text);
	if (normalized.length < 6) return 'too_short';
	if (hasRepeatedTail(normalized)) return 'repeated_segment';
	if (/(\b\w+\b)(?:\s+\1){3,}/iu.test(normalized)) return 'word_loop';
	return null;
}

async function transcribeWithModel(
	audioBuffer: ArrayBuffer,
	filename: string,
	model: string,
): Promise<string> {
	if (!sttClient) {
		throw new Error('STT not configured: set STT_BASE_URL and STT_API_KEY');
	}

	const file = new File([audioBuffer], filename, { type: 'audio/ogg' });
	const transcription = await sttClient.audio.transcriptions.create({
		model,
		file,
		language: 'ru',
	});

	return transcription.text;
}

export async function transcribeAudio(
	audioBuffer: ArrayBuffer,
	filename: string,
): Promise<TranscriptionResult> {
	const primaryRawText = await transcribeWithModel(audioBuffer, filename, PRIMARY_STT_MODEL);
	const primaryNormalizedText = normalizeTranscriptText(primaryRawText);
	const suspicion = looksSuspicious(primaryNormalizedText);

	if (suspicion && FALLBACK_STT_MODEL && FALLBACK_STT_MODEL !== PRIMARY_STT_MODEL) {
		console.log(
			`[STT fallback] primary=${PRIMARY_STT_MODEL} fallback=${FALLBACK_STT_MODEL} reason=${suspicion}`,
		);
		try {
			const fallbackRawText = await transcribeWithModel(audioBuffer, filename, FALLBACK_STT_MODEL);
			const fallbackNormalizedText = normalizeTranscriptText(fallbackRawText);
			return {
				text: fallbackNormalizedText,
				rawText: fallbackRawText,
				normalizedText: fallbackNormalizedText,
				model: FALLBACK_STT_MODEL,
				fallbackReason: suspicion,
			};
		} catch (error) {
			console.error('[STT fallback failed]', error);
		}
	}

	return {
		text: primaryNormalizedText,
		rawText: primaryRawText,
		normalizedText: primaryNormalizedText,
		model: PRIMARY_STT_MODEL,
		fallbackReason: null,
	};
}
