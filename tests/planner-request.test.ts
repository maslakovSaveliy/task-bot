import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlannerRequest } from '../src/services/planner-request.js';

test('Luna uses high reasoning without incompatible sampling parameters', () => {
	const request = buildPlannerRequest('gpt-6-luna', false, 'system', 'user');
	assert.equal(request.model, 'gpt-6-luna');
	assert.equal(request.reasoning_effort, 'high');
	assert.equal(request.temperature, undefined);
	assert.equal(request.max_tokens, undefined);
	assert.equal(request.max_completion_tokens, 16384);
	assert.deepEqual(request.messages, [
		{ role: 'system', content: 'system' },
		{ role: 'user', content: 'user' },
	]);
});

test('legacy OpenAI-compatible models keep their existing parameters', () => {
	const request = buildPlannerRequest('gpt-4o', false, 'system', 'user');
	assert.equal(request.temperature, 0.1);
	assert.equal(request.max_tokens, 4096);
	assert.equal(request.reasoning_effort, undefined);
});

test('Gemini remains a minimal request', () => {
	const request = buildPlannerRequest('gemini-2.5-flash', true, 'system', 'user');
	assert.equal(request.temperature, undefined);
	assert.equal(request.max_tokens, undefined);
	assert.equal(request.reasoning_effort, undefined);
});
