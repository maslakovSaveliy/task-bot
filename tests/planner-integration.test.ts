import assert from 'node:assert/strict';
import test from 'node:test';

process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_URL = 'postgresql://localhost/test';
process.env.AI_API_KEY = 'test-key';
process.env.AI_BASE_URL = 'https://example.invalid/v1';
process.env.AI_CHAT_MODEL = 'gpt-6-luna';
process.env.AI_AGENT_MODE = 'false';

let sent: Record<string, unknown> | undefined;
globalThis.fetch = async (_input, init) => {
	sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
	return new Response(
		JSON.stringify({
			id: 'test',
			object: 'chat.completion',
			created: 1,
			model: 'gpt-6-luna',
			choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ intent: 'new_tasks', tasks: [{ task: 'Купить хлеб', project: 'General', deadline: null, reminder: null, recurrence: null }], actions: [], confidence: 1, needsClarification: false, clarificationQuestion: null }) } }],
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
};

const { parseUserMessage } = await import('../src/services/ai.js');

test('planner sends Luna high and parses a task end to end with a mocked API', async () => {
	const result = await parseUserMessage('Купить хлеб', 'UTC', [], []);
	assert.equal(sent?.model, 'gpt-6-luna');
	assert.equal(sent?.reasoning_effort, 'high');
	assert.equal(sent?.temperature, undefined);
	assert.equal(result.intent, 'new_tasks');
	if (result.intent === 'new_tasks') assert.equal(result.tasks[0]?.task, 'Купить хлеб');
});
