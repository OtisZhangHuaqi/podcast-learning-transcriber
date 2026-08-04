const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBinaryLocator, runtimeKey } = require('../src/platform/binaries');
const { nullDevice, spawnOptions } = require('../src/platform/runtime');

test('runtime keys select both supported Mac architectures', () => {
  assert.equal(runtimeKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(runtimeKey('darwin', 'x64'), 'darwin-x64');
  assert.equal(runtimeKey('win32', 'x64'), 'win32-x64');
});

test('platform process settings avoid Windows-only values on macOS', () => {
  assert.equal(nullDevice('darwin'), '/dev/null');
  assert.equal(nullDevice('win32'), 'NUL');
  assert.equal(spawnOptions('darwin').windowsHide, undefined);
  assert.equal(spawnOptions('win32').windowsHide, true);
});

test('binary locator chooses architecture-specific Mac tools', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-platform-'));
  for (const arch of ['arm64', 'x64']) {
    for (const [directory, name] of [['whisper', 'whisper-cli'], ['ffmpeg', 'ffmpeg'], ['yt-dlp', 'yt-dlp']]) {
      const folder = path.join(root, `darwin-${arch}`, directory);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, name);
      fs.writeFileSync(file, arch);
      fs.chmodSync(file, 0o755);
    }
  }
  const locator = createBinaryLocator({
    packaged: true, resourcesPath: root, appPath: root,
    platform: 'darwin', arch: 'arm64'
  });
  assert.match(locator.whisper(), /darwin-arm64[\\/]whisper[\\/]whisper-cli$/);
  assert.match(locator.ffmpeg(), /darwin-arm64[\\/]ffmpeg[\\/]ffmpeg$/);
  assert.match(locator.ytDlp(), /darwin-arm64[\\/]yt-dlp[\\/]yt-dlp$/);
  fs.rmSync(root, { recursive: true, force: true });
});
