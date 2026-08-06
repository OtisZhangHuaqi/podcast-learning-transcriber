const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionCredentialCache } = require('../src/services/credential-cache');

test('macOS decrypts the same encrypted API key only once per app session', () => {
  const cache = createSessionCredentialCache('darwin');
  let decryptions = 0;
  const decrypt = () => { decryptions += 1; return 'deepseek-key'; };

  assert.equal(cache.decrypt('ciphertext', decrypt), 'deepseek-key');
  assert.equal(cache.decrypt('ciphertext', decrypt), 'deepseek-key');
  assert.equal(decryptions, 1);
});

test('macOS decrypts again when encrypted settings change', () => {
  const cache = createSessionCredentialCache('darwin');
  let decryptions = 0;
  const decrypt = (value) => { decryptions += 1; return `plain-${value}`; };

  cache.decrypt('first', decrypt);
  assert.equal(cache.decrypt('second', decrypt), 'plain-second');
  assert.equal(decryptions, 2);
});

test('failed or denied macOS decryption is not cached', () => {
  const cache = createSessionCredentialCache('darwin');
  let decryptions = 0;
  const decrypt = () => { decryptions += 1; return ''; };

  cache.decrypt('ciphertext', decrypt);
  cache.decrypt('ciphertext', decrypt);
  assert.equal(decryptions, 2);
});

test('Windows behavior remains unchanged', () => {
  const cache = createSessionCredentialCache('win32');
  let decryptions = 0;
  const decrypt = () => { decryptions += 1; return 'deepseek-key'; };

  cache.decrypt('ciphertext', decrypt);
  cache.decrypt('ciphertext', decrypt);
  assert.equal(decryptions, 2);
});
