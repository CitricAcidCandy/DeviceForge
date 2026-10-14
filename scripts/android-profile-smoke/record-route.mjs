import { deviceId, defaultProfile, shellQuote, probeContract, rootArgv } from './probe-route.mjs';
import { packageName, targetPid, targetUid, reportBytes, rawPerfBytes } from './protocol.mjs';

export const token = '@TOKEN@';
const directory = '/data/local/tmp/deviceforge-profile-' + token;
const plain = tail => ['-s', deviceId, 'shell', '-T', ...tail];
const rootCommand = (script, access) => ['-s', deviceId, 'shell', '-T', ...(access === 'su' ? ['su', '-c'] : ['/system/bin/sh', '-c']), shellQuote(script)];
const output = (stdout = '', exit = 0) => ({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: Buffer.alloc(0), exit });
const command = (category, tail, values, access) => ({ category, argv: access === 'none' ? plain(tail) : rootArgv(tail, access), outputs: values.map(value => output(value)) });
const scriptCommand = (category, script, value, access) => ({ category, argv: rootCommand(script, access), outputs: [output(access === 'su' ? value.replace(/\n/g, '\r\n') : value)] });
const binaryCommand = (category, name, bytes) => ({ category, argv: ['-s', deviceId, 'exec-out', 'cat', directory + '/' + name], outputs: [output(bytes)] });
const prepareDownload = (name, access) => scriptCommand('remote-' + name.replace('.', '-') + '-prepare', 'test -d ' + directory + ' && test ! -L ' + directory + ' && test ! -L ' + directory + '/owner || exit 126; test "$(cat ' + directory + '/owner)" = ' + token + ' || exit 126; test -f ' + directory + '/' + name + ' && test ! -L ' + directory + '/' + name + ' || exit 126; chmod 0644 ' + directory + '/' + name + ' && chmod 0711 ' + directory, '', access);
function stat(pid, start, ticks = 100) { const fields = Array(20).fill('0'); fields[0] = 'R'; fields[11] = String(ticks); fields[19] = String(start); return pid + ' (owned profile) ' + fields.join(' ') + '\n'; }
const status = uid => 'Name:\tprofile game\nPid:\t2468\nUid:\t' + [uid, uid, uid, uid].join('\t') + '\n';
// 与后端阶段交接的固定脚本逐字一致；仅 SHA256 token 使用受检占位。
export const identityFunctions = 'identity() { line=$(cat "$1") || return 2; pid="$line"; pid=${pid%% *}; tail=${line##*) }; set -- $tail; saved=${20}; case $pid:$saved in *[!0-9:]*|:*|*:) return 2;; esac; test "$pid" -gt 0 || return 2; }; gone() { identity "$1" || return 2; if test ! -e /proc/$pid; then return 0; fi; current=$(cat /proc/$pid/stat) || return 2; current=${current##*) }; set -- $current; test "${20}" != "$saved" || test "$1" = Z; }; stop_owned() { identity "$1" || return 2; if gone "$1"; then return 0; fi; kill -KILL $pid || return 2; }';
export const createScript = "umask 077; mkdir " + directory + " && printf '%s\\n' " + token + " > " + directory + "/owner && printf 'ready\\n'";
export function launchScript(phase) {
  const raw = directory + '/perf.bin', report = directory + '/report.pb';
  const args = phase === 'record' ? ['/system/bin/simpleperf','record','-p',String(targetPid),'-e','cpu-clock','-f','99','--call-graph','dwarf','--clockid','boottime','--keep-failed-unwinding-result','--duration','1.000','-o',raw] : ['/system/bin/simpleperf','report-sample','--protobuf','--show-callchain','--remove-gaps','0','-i',raw,'-o',report,'--show-execution-type'];
  const child = "ulimit -f 65536 || exit 125; cat /proc/$$/stat > " + directory + '/' + phase + ".child.tmp && mv " + directory + '/' + phase + ".child.tmp " + directory + '/' + phase + ".child && exec " + args.map(shellQuote).join(' ');
  const supervisor = "umask 077; cat /proc/$$/stat > " + directory + '/' + phase + ".supervisor.tmp && mv " + directory + '/' + phase + ".supervisor.tmp " + directory + '/' + phase + ".supervisor || exit 125; /system/bin/sh -c " + shellQuote(child) + " > " + directory + '/' + phase + ".out 2> " + directory + '/' + phase + ".err & child=$!; wait $child; result=$?; printf '%s\\n' $result > " + directory + '/' + phase + ".exit.tmp && mv " + directory + '/' + phase + ".exit.tmp " + directory + '/' + phase + '.exit';
  return "test \"$(cat " + directory + "/owner)\" = " + token + " || exit 126; test ! -e " + directory + '/' + phase + ".starting || exit 126; printf 'starting\\n' > " + directory + '/' + phase + ".starting || exit 126; /system/bin/sh -c " + shellQuote(supervisor) + " </dev/null >/dev/null 2>/dev/null & printf '%s\\n' $! > " + directory + '/' + phase + '.launchpid';
}
export const identityScript = phase => "if test -s " + directory + '/' + phase + ".supervisor && test -s " + directory + '/' + phase + ".child; then cat " + directory + '/' + phase + ".launchpid; cat " + directory + '/' + phase + ".supervisor; cat " + directory + '/' + phase + ".child; else printf 'pending\\n'; fi";
export const receiptScript = phase => "if test -f " + directory + '/' + phase + ".exit; then cat " + directory + '/' + phase + ".exit; else printf 'pending\\n'; fi";
export const goneScript = phase => identityFunctions + "; if gone " + directory + '/' + phase + ".child && gone " + directory + '/' + phase + ".supervisor; then printf 'exited\\n'; else printf 'pending\\n'; fi";
export const cleanupScript = "test -d " + directory + " || { test ! -e " + directory + " && printf 'clean\\n'; exit; }; test \"$(cat " + directory + "/owner)\" = " + token + " || exit 126; " + identityFunctions + "; for phase in record report; do if test -f " + directory + "/$phase.starting && test ! -f " + directory + "/$phase.supervisor; then exit 126; fi; for kind in supervisor child; do path=" + directory + "/$phase.$kind; if test -f $path; then stop_owned $path || exit 126; fi; done; done; for attempt in 1 2 3 4 5 6 7 8 9 10; do pending=0; for phase in record report; do if test -f " + directory + "/$phase.supervisor && test ! -f " + directory + "/$phase.child; then exit 126; fi; for kind in supervisor child; do path=" + directory + "/$phase.$kind; if test -f $path; then gone $path || pending=1; fi; done; done; test $pending = 0 && break; sleep 0.02; done; test $pending = 0 || exit 126; rm -rf " + directory + " && test ! -e " + directory + " && printf 'clean\\n'";

function metrics(access) {
  return [command('pid', ['pidof', '-s', packageName], ['2468\n'], access),
    command('process', ['cat', '/proc/2468/stat'], Array.from({ length: 64 }, (_, index) => stat(targetPid, 900, 100 + index * 10)), access),
    command('status', ['cat', '/proc/2468/status'], [status(targetUid)], access),
    command('memory', ['dumpsys', 'meminfo', '-s', '2468'], [access === 'su' ? '** MEMINFO in pid 2468 [' + packageName + '] **\r\n App Summary\r\n Pss(KB)\r\n ------\r\n Java Heap: 256\r\n Native Heap: 512\r\n Code: 256\r\n Stack: 64\r\n Graphics: 0\r\n Private Other: 896\r\n System: 64\r\n TOTAL: 2048 TOTAL SWAP PSS: 90\r\n Objects\r\n TOTAL: 9999\r\n' : '** MEMINFO in pid 2468 [' + packageName + '] **\nTOTAL PSS: 2048 TOTAL RSS: 4096\n'], access),
    { category: 'sdk', argv: rootArgv(['getprop', 'ro.build.version.sdk'], access), outputs: [output('30\n')] },
    { category: 'surface-proto', argv: ['-s', deviceId, 'exec-out', 'dumpsys', 'SurfaceFlinger', '--proto'], outputs: [output(Buffer.alloc(0))] },
    command('system', ['cat', '/proc/stat'], Array.from({ length: 64 }, (_, index) => 'cpu ' + (10000 + index * 100) + ' 0 0 1000\ncpu0 1 0 0 1\ncpu1 1 0 0 1\n'), access),
    command('uevent', ['cat', '/sys/class/power_supply/battery/uevent'], [''], access),
    command('battery', ['dumpsys', 'battery'], ['Current Battery Service state:\n  (UPDATES STOPPED -- use reset to restart)\n'], access),
    command('thermal', ['dumpsys', 'thermalservice'], ['HAL Ready: false\n'], access),
    command('uptime', ['cat', '/proc/uptime'], ['10.00 0.00\n', '10.10 0.00\n'], access)];
}
function remote(access) {
  return [scriptCommand('remote-create', createScript, 'ready\n', access),
    ...['record', 'report'].flatMap((phase, index) => [
      scriptCommand('remote-' + phase + '-launch', launchScript(phase), '', access),
      scriptCommand('remote-' + phase + '-identity', identityScript(phase), String(800 + index * 2) + '\n' + stat(800 + index * 2, 3000 + index * 2) + stat(801 + index * 2, 3001 + index * 2), access),
      scriptCommand('remote-' + phase + '-receipt', receiptScript(phase), '0\n', access),
      scriptCommand('remote-' + phase + '-gone', goneScript(phase), 'exited\n', access)]),
    prepareDownload('perf.bin', access),
    binaryCommand('remote-perf-download', 'perf.bin', rawPerfBytes),
    prepareDownload('report.pb', access),
    binaryCommand('remote-report-download', 'report.pb', reportBytes()),
    scriptCommand('remote-cleanup', cleanupScript, 'clean\n', access)];
}
function scenario(id, probeId, access, options = {}) {
  const probe = probeContract.cases.find(value => value.id === probeId);
  return { id, kind: options.kind ?? 'record', expected: { root_access: access, stack_status: options.stacks === false ? 'unavailable' : 'captured',
    stack_reason: options.stacks === false ? probe.expected.reason : null, sample_count: 1, frame_count: 0, frame_status: 'disabled', frame_reason: null },
    ...(access === 'su' ? { expected_metrics: { pss_kib: 2048, rss_kib: null, logical_cpus: 2 } } : {}),
    hold_category: options.hold, commands: [...probe.commands, ...metrics(access), ...(options.stacks === false ? [] : remote(access))] };
}
export const recordContract = { frozen: true, source: ['后端2026-10-13冻结remote/record/capture固定脚本', 'https://android.googlesource.com/platform/system/extras/+/refs/heads/main/simpleperf/cmd_report_sample.proto'],
  route: 'Root资格、原目标身份、远端监督记录/退出/清理及无画面指标产物', config: defaultProfile, shared: probeContract.shared,
  cases: [scenario('record-adbd-root', 'probe-adbd-root', 'adbd_root'), scenario('record-su-root', 'probe-su-root', 'su'),
    scenario('record-no-root', 'probe-no-root', 'none', { stacks: false }),
    scenario('record-su-denied', 'probe-su-denied', 'none', { stacks: false }),
    scenario('record-no-simpleperf', 'probe-no-simpleperf', 'adbd_root', { stacks: false }),
    scenario('record-cancel', 'probe-adbd-root', 'adbd_root', { kind: 'cancel', hold: 'remote-record-receipt' }),
    scenario('record-unload', 'probe-su-root', 'su', { kind: 'unload', hold: 'remote-record-receipt' }),
    scenario('record-reloaded', 'probe-adbd-root', 'adbd_root', { kind: 'reloaded' })] };
