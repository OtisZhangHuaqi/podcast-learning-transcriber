const test = require('node:test');
const assert = require('node:assert/strict');
const { retryDescriptor } = require('../src/services/task-retry');

test('failed task retry preserves original input without sharing mutable payload', () => {
  const task = {
    id: 'task-1', status: 'failed', type: 'transcription', title: '一期节目', attempt: 2,
    payload: { url: 'https://example.com/episode', resolved: { episode: { title: '一期节目' } } }
  };
  const retry = retryDescriptor(task);
  assert.equal(retry.payload.url, task.payload.url);
  assert.equal(retry.retryOf, 'task-1');
  assert.equal(retry.attempt, 3);
  assert.notEqual(retry.payload, task.payload);
  retry.payload.resolved.episode.title = 'changed';
  assert.equal(task.payload.resolved.episode.title, '一期节目');
});

test('only failed tasks can be retried', () => {
  assert.throws(() => retryDescriptor({ status: 'completed', payload: {} }), /只有失败/);
});
