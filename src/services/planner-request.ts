import type OpenAI from 'openai';

export function buildPlannerRequest(
	model: string,
	isGemini: boolean,
	systemPrompt: string,
	text: string,
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
	const request: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
		model,
		stream: false,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: text },
		],
	};

	if (model === 'gpt-6-luna' && !isGemini) {
		request.reasoning_effort = 'high';
		request.max_completion_tokens = 16384;
	} else if (!isGemini) {
		request.temperature = 0.1;
		request.max_tokens = 4096;
	}

	return request;
}
