const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanSubtitleConstrained, deepSeekJsonRequest, parseJsonResponse } = require('../src/services/deepseek');

test('parses valid fenced JSON', () => {
  assert.deepEqual(parseJsonResponse('```json\n[{"id":1,"text":"ok"}]\n```'), [{ id: 1, text: 'ok' }]);
});

test('repairs a missing comma between array elements', () => {
  assert.deepEqual(parseJsonResponse('[{"id":1,"text":"a"} {"id":2,"text":"b"}]'), [
    { id: 1, text: 'a' }, { id: 2, text: 'b' }
  ]);
});

test('repairs trailing commas and smart quotes', () => {
  assert.deepEqual(parseJsonResponse('[{“id”:1,“text”:“ok”,},]'), [{ id: 1, text: 'ok' }]);
});

test('returns a Chinese retry instruction for unrecoverable output', () => {
  assert.throws(() => parseJsonResponse('[{"id":1,"text":"unterminated}]'), /请重试当前任务/);
});

test('automatically retries only the malformed structured substep', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const content = calls === 1 ? '[{"id":1,"text":"truncated}' : '{"items":[{"id":1,"text":"ok"}]}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  try {
    const result = await deepSeekJsonRequest('test-key', [{ role: 'user', content: 'test' }], {}, '测试阶段');
    assert.deepEqual(result, { items: [{ id: 1, text: 'ok' }] });
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('requests DeepSeek JSON mode for structured calls', async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"items":[]}' } }]
    }), { status: 200 });
  };
  try {
    await deepSeekJsonRequest('test-key', [{ role: 'user', content: '输出 JSON' }]);
    assert.deepEqual(requestBody.response_format, { type: 'json_object' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('persistent malformed subtitle JSON preserves original text and completes safely', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-subtitle-json-'));
  const input = path.join(directory, 'raw.srt');
  const outputs = {
    srt: path.join(directory, 'clean.srt'),
    txt: path.join(directory, 'clean.txt'),
    audit: path.join(directory, 'audit.json')
  };
  fs.writeFileSync(input, '1\n00:00:00,000 --> 00:00:01,000\n原文一\n\n2\n00:00:01,000 --> 00:00:02,000\n原文二\n', 'utf8');
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '{"items":[' } }],
      usage: { completion_tokens: 4000 }
    }), { status: 200 });
  };
  try {
    const result = await cleanSubtitleConstrained('test-key', input, outputs, '', [], null, null, null);
    assert.equal(calls, 3);
    assert.equal(result.warnings.length, 1);
    assert.match(fs.readFileSync(outputs.srt, 'utf8'), /原文一/);
    assert.match(fs.readFileSync(outputs.srt, 'utf8'), /原文二/);
    assert.equal(fs.existsSync(`${outputs.audit}.checkpoint.json`), false);
    assert.equal(fs.readdirSync(`${outputs.audit.replace(/\.json$/, '')}-DeepSeek诊断`).length, 3);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
