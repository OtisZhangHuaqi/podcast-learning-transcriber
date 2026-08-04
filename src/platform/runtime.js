const os = require('os');

function nullDevice(platform = process.platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

function spawnOptions(platform = process.platform) {
  return {
    ...(platform === 'win32' ? { windowsHide: true } : {}),
    stdio: ['ignore', 'pipe', 'pipe']
  };
}

function defaultOutputDirectory(app) {
  return require('path').join(app.getPath('documents'), '播客转录');
}

function platformLabel(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return `macOS ${arch === 'arm64' ? 'Apple Silicon' : 'Intel'}`;
  if (platform === 'win32') return `Windows ${arch}`;
  return `${platform} ${arch}`;
}

function logicalCpus() {
  return os.cpus()?.length || 4;
}

module.exports = { defaultOutputDirectory, logicalCpus, nullDevice, platformLabel, spawnOptions };
