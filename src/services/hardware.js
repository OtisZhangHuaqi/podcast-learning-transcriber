const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function hasFileRecursive(root, pattern) {
  if (!root || !fs.existsSync(root)) return false;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && hasFileRecursive(target, pattern)) return true;
    if (entry.isFile() && pattern.test(entry.name)) return true;
  }
  return false;
}

function windowsGpuInfo() {
  if (process.platform !== 'win32') return [];
  try {
    const script = 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress';
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((gpu) => ({
      name: String(gpu.Name || '未知显卡'),
      adapterRam: Number(gpu.AdapterRAM || 0),
      driverVersion: String(gpu.DriverVersion || '')
    }));
  } catch { return []; }
}

function macGpuInfo() {
  if (process.platform !== 'darwin') return [];
  try {
    const output = execFileSync('system_profiler', ['SPDisplaysDataType', '-json'], {
      encoding: 'utf8', timeout: 8000
    });
    const displays = JSON.parse(output)?.SPDisplaysDataType || [];
    return displays.map((gpu) => ({
      name: String(gpu.sppci_model || gpu._name || 'Apple GPU'),
      adapterRam: 0,
      driverVersion: String(gpu.spdisplays_metal || '')
    }));
  } catch { return []; }
}

function detectHardware(whisperRoot) {
  const logicalCpus = os.cpus()?.length || 4;
  const totalMemoryGb = Math.round((os.totalmem() / 1073741824) * 10) / 10;
  const freeMemoryGb = Math.round((os.freemem() / 1073741824) * 10) / 10;
  const isAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  const gpus = process.platform === 'darwin' ? macGpuInfo() : windowsGpuInfo();
  const vulkanBackend = hasFileRecursive(whisperRoot, /(?:ggml[-_]vulkan|vulkan).*\.dll$/i);
  const cudaBackend = hasFileRecursive(whisperRoot, /(?:ggml[-_]cuda|cublas).*\.dll$/i);
  const maxThreads = Math.max(2, Math.min(logicalCpus - 1, 12));
  const recommendedWorkers = logicalCpus >= 8 && totalMemoryGb >= 12 && freeMemoryGb >= 4 ? 2 : 1;
  const recommendedThreads = recommendedWorkers > 1
    ? Math.max(2, Math.min(4, Math.floor(maxThreads / recommendedWorkers)))
    : Math.max(2, Math.min(8, maxThreads));
  return {
    cpu: { name: os.cpus()?.[0]?.model || '未知 CPU', logicalCpus },
    memory: { totalGb: totalMemoryGb, freeGb: freeMemoryGb },
    gpus,
    platform: { os: process.platform, arch: process.arch, appleSilicon: isAppleSilicon },
    backends: { cpu: true, metal: isAppleSilicon, vulkan: vulkanBackend, cuda: cudaBackend },
    limits: {
      maxThreads,
      maxWorkers: logicalCpus >= 8 && totalMemoryGb >= 12 ? 2 : 1,
      chunkMinutes: [8, 10, 12, 15, 20]
    },
    recommended: {
      model: totalMemoryGb >= 24 ? 'medium' : 'small', backend: isAppleSilicon ? 'metal' : 'cpu', segmentation: true,
      chunkMinutes: 12, overlapSeconds: 20,
      workers: recommendedWorkers, threadsPerWorker: recommendedThreads,
      longAudioThresholdMinutes: 30
    }
  };
}

function normalizeTranscriptionSettings(input = {}, profile) {
  const recommended = profile.recommended;
  const segmentation = input.segmentation !== false;
  const workers = Math.max(1, Math.min(Number(input.workers) || recommended.workers, profile.limits.maxWorkers));
  const maxPerWorker = Math.max(2, Math.floor(profile.limits.maxThreads / workers));
  const threadsPerWorker = Math.max(2, Math.min(Number(input.threadsPerWorker) || recommended.threadsPerWorker, maxPerWorker));
  const requestedChunk = Number(input.chunkMinutes) || recommended.chunkMinutes;
  const chunkMinutes = profile.limits.chunkMinutes.reduce((best, value) => (
    Math.abs(value - requestedChunk) < Math.abs(best - requestedChunk) ? value : best
  ));
  const backend = input.backend === 'metal' && profile.backends.metal
    ? 'metal'
    : input.backend === 'vulkan' && profile.backends.vulkan
    ? 'vulkan'
    : input.backend === 'cuda' && profile.backends.cuda ? 'cuda' : 'cpu';
  return {
    backend, segmentation, workers, threadsPerWorker, chunkMinutes,
    overlapSeconds: 20, longAudioThresholdMinutes: 30
  };
}

module.exports = { detectHardware, normalizeTranscriptionSettings };
