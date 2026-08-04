function cloneSerializable(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function retryDescriptor(task) {
  if (!task) throw new Error('找不到要重试的任务');
  if (task.status !== 'failed') throw new Error('只有失败的任务可以重试');
  if (!task.payload) throw new Error('原任务参数已丢失，无法重试');
  return {
    type: task.type,
    payload: cloneSerializable(task.payload),
    title: task.title,
    retryOf: task.id,
    attempt: Math.max(1, Number(task.attempt) || 1) + 1
  };
}

module.exports = { retryDescriptor };
