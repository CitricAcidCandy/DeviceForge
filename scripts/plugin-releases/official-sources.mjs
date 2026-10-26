// 这里只记录已留存来源证据的上游原包；不从可变的本地重包库存推导下载身份。
export const windowsCompanions = {
  adb: { adb_win_api: 'AdbWinApi.dll', adb_win_usb_api: 'AdbWinUsbApi.dll' },
  hdc: { libusb: 'libusb_shared.dll' },
  scrcpy: {
    avcodec: 'avcodec-61.dll', avformat: 'avformat-61.dll', avutil: 'avutil-59.dll',
    swresample: 'swresample-5.dll', sdl: 'SDL2.dll', libusb: 'libusb-1.0.dll',
    adb_win_api: 'AdbWinApi.dll', adb_win_usb_api: 'AdbWinUsbApi.dll',
  },
};

const verified = {
  // 三项原包 URL 与下载身份来自 official-tools/download-report-1792668991093.json。
  node: {
    url: 'https://nodejs.org/dist/v24.14.0/node-v24.14.0-win-x64.zip',
    platform: 'win32-x64', version: '24.14.0', format: 'zip',
    sha256: '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66',
    size: 36217529, entries: { node: 'node-v24.14.0-win-x64/node.exe' },
  },
  'codex-sdk': {
    url: 'https://registry.npmjs.org/@openai/codex-sdk/-/codex-sdk-0.162.1.tgz',
    platform: 'win32-x64', version: '0.162.1', format: 'tgz',
    sha256: 'ae10b9096bb72ebdf1fbac598fd87960afc1ddf5b8980fa0d38bdd6770400349',
    size: 21406, entries: { sdk: 'package/dist/index.js' },
  },
  'codex-cli': {
    url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.162.1-win32-x64.tgz',
    platform: 'win32-x64', version: '0.162.1', format: 'tgz',
    sha256: '5d48824f11a512b0ecb351461c2e90a1040c80de1026bc4a80815d5121f3936d',
    size: 165053495,
    entries: { codex: 'package/vendor/x86_64-pc-windows-msvc/bin/codex.exe' },
  },
  // 原始下载 URL、长度和摘要已记录在候选目录的 provenance.json，非许可证补充重包。
  scrcpy: {
    url: 'https://github.com/Genymobile/scrcpy/releases/download/v3.3.4/scrcpy-win64-v3.3.4.zip',
    platform: 'win32-x64', version: '3.3.4', format: 'zip',
    sha256: 'd8a155b7c180b7ca4cdadd40712b8750b63f3aab48cb5b8a2a39ac2d0d4c5d38',
    size: 7287033,
    entries: Object.fromEntries(Object.entries({ scrcpy: 'scrcpy.exe', ...windowsCompanions.scrcpy })
      .map(([key, name]) => [key, `scrcpy-win64-v3.3.4/${name}`])),
  },
};

export function verifiedOfficialSources(id) {
  return verified[id] ? [{ kind: 'official', ...structuredClone(verified[id]) }] : [];
}
