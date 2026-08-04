const test = require('node:test');
const assert = require('node:assert/strict');
const { PauseController } = require('../src/services/pause-controller');

test('checkpoint waits while paused and continues once resumed', async () => {
  const controller = new PauseController();
  const events = [];
  controller.request();
  const work = controller.checkpoint(
    () => events.push('paused'),
    () => events.push('resumed')
  ).then(() => events.push('work'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['paused']);
  controller.resume();
  await work;
  assert.deepEqual(events, ['paused', 'resumed', 'work']);
});

test('resume releases all parallel workers without duplicating work', async () => {
  const controller = new PauseController();
  controller.request();
  const completed = [];
  const workers = [1, 2].map(async (id) => {
    await controller.checkpoint();
    completed.push(id);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, []);
  controller.resume();
  await Promise.all(workers);
  assert.deepEqual(completed.sort(), [1, 2]);
});

test('checkpoint is a no-op when pause was not requested', async () => {
  const controller = new PauseController();
  assert.equal(await controller.checkpoint(), false);
});
