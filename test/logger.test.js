const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { configureLogger, logError, redactText, sanitize } = require('../src/services/logger');
const { runProcess } = require('../src/services/transcriber');

test('logger redacts credentials and the local home directory', () => {
  const input = `${os.homedir()} sk-exampleSecret123456789 Bearer private-token ?token=share-secret`;
  const output = redactText(input);
  assert.doesNotMatch(output, /exampleSecret|private-token|share-secret/);
  assert.doesNotMatch(output, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('logger redacts sensitive object fields recursively', () => {
  const value = sanitize({ apiKey: 'secret', nested: { cookie: 'session', safe: 'ok' } });
  assert.equal(value.apiKey, '<REDACTED>');
  assert.equal(value.nested.cookie, '<REDACTED>');
  assert.equal(value.nested.safe, 'ok');
});

test('logger writes structured JSONL diagnostics', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-logger-'));
  try {
    configureLogger(directory);
    const error = new Error('Whisper failed');
    error.processDetails = { exitCode: 1, stderrTail: 'dyld missing library' };
    const target = logError('task', error, { taskId: 'task-1' });
    const record = JSON.parse(fs.readFileSync(target, 'utf8').trim());
    assert.equal(record.scope, 'task');
    assert.equal(record.context.taskId, 'task-1');
    assert.equal(record.error.process.stderrTail, 'dyld missing library');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('process failure preserves exit status and stderr for diagnostics', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.stderr.write('dyld: Library not loaded'); process.exit(7)"]),
    (error) => {
      assert.equal(error.code, 'PROCESS_EXIT_FAILED');
      assert.equal(error.processDetails.exitCode, 7);
      assert.match(error.message, /dyld: Library not loaded/);
      assert.match(error.processDetails.stderrTail, /Library not loaded/);
      return true;
    }
  );
});
