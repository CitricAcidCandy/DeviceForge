export const remoteServer = '/data/local/tmp/deviceforge-frida-server';
export const scriptSummary = [];
export const permissionSummary = [{ type: 'installed', class: 'android.hardware.Camera' }, { type: 'summary', installed: 1, missing: 0 }];
export const statusResult = { installed: true, running: true, pids: [991, 992], version_output: '16.7.0', ownership: 'observed_only' };
export const processesResult = { source: 'frida-ps --json', processes: [{ pid: 123, name: '中文应用' }, { pid: 456, name: 'system_server' }] };
export const deploymentResult = { deployed: true, version_output: '16.7.0\n16.7.0', root_required: true };
export const runningResult = { pid: 801, process_start_ticks: 12345, duration_ms: 100, cleanup: 'confirmed', ownership: 'invocation' };

export function scriptResult(permissions = false) {
  return { package: 'com.example.app', mode: permissions ? 'attach' : 'spawn', duration_requested_ms: permissions ? 100 : 1001,
    cli_timeout_seconds: permissions ? 1 : 2, loaded: true, resume: permissions ? 'already_running' : 'cli_default',
    notice_count: permissions ? 0 : 1, hook_summary: permissions ? permissionSummary : scriptSummary,
    cleanup: 'direct_cli_confirmed', target_process_cleanup: 'not_claimed' };
}

export function permissionScript(template) {
  const hooks = [
    { action: '调用摄像头', args: [], class: 'android.hardware.Camera', messages: '调用摄像头', method: 'open', module: 'camera' },
    { action: '调用摄像头', args: [], class: 'android.hardware.camera2.CameraManager', messages: '调用摄像头', method: 'openCamera', module: 'camera' },
    { action: '拍照', args: [], class: 'androidx.camera.core.ImageCapture', messages: '拍照', method: 'takePicture', module: 'camera' },
  ];
  return Buffer.from(template.replace('__DEVICEFORGE_CONFIGURATION__', JSON.stringify({ hooks, package: 'com.example.app', show_log: false })), 'utf8');
}

export const rootFrame = script => "su -c '" + script.replaceAll("'", "'\\''") + "'\n";
export const statusScript = "set -e\nid -u | grep -qx 0\nif [ -f '" + remoteServer + "' ] && [ ! -L '" + remoteServer + "' ]; then echo installed; '" + remoteServer + "' --version; else echo absent; fi\nfor d in /proc/[0-9]*; do e=$(readlink \"$d/exe\" 2>/dev/null || true); case \"$e\" in '" + remoteServer + "'|/data/local/tmp/deviceforge-frida-run-*/server) echo \"PID ${d##*/}\";; esac; done\ntrue\n";
