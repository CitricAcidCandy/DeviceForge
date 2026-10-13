import { packageName } from './protocol.mjs';

export const deviceId = 'profile-0001';
export const defaultProfile = Object.freeze({ root_access: 'auto', simpleperf: '/system/bin/simpleperf', su: 'su' });
const quote = value => String(value).replace(/'/g, '\'\\\'\'');
const shellQuote = value => '\'' + quote(value) + '\'';
// 与后端冻结合同独立构造：每项单引号后拼脚本，再整体单引号传给固定解释器。
export function rootArgv(tail, access = 'adbd_root') {
  const script = tail.map(shellQuote).join(' ');
  return ['-s', deviceId, 'shell', '-T', ...(access === 'su' ? ['su', '-c'] : ['/system/bin/sh', '-c']), shellQuote(script)];
}
const command = (category, tail, value, access = 'adbd_root', exit = 0) => ({ category, argv: rootArgv(tail, access), outputs: [{ stdout: Buffer.from(value), stderr: Buffer.alloc(0), exit }] });
const qualify = access => [command('simpleperf-version', ['/system/bin/simpleperf', '--version'], 'simpleperf fixture-v1\n', access),
  command('simpleperf-record-help', ['/system/bin/simpleperf', 'record', '--help'], '--clockid --keep-failed-unwinding-result\n', access),
  command('simpleperf-report-help', ['/system/bin/simpleperf', 'report-sample', '--help'], '--protobuf --show-callchain --show-execution-type\n', access)];
const noRootReason = '设备未取得Root权限，已保留指标与采样画面能力';
const noToolReason = '设备Simpleperf入口或所需报告参数不可用，已保留指标与采样画面能力';
export const probeContract = { frozen: true, route: '冻结Root资格探测固定解释器与受检argv', source: '后端2026-10-13阶段交接',
  shared: [{ category: 'discover', argv: ['devices', '-l'], outputs: [{ stdout: Buffer.from(deviceId + ' device product:fixture model:root_profile transport_id:1\n'), stderr: Buffer.alloc(0), exit: 0 }] }],
  package: packageName, config: defaultProfile, cases: [
    { id: 'probe-adbd-root', expected: { root_access: 'adbd_root', supported: true, simpleperf_available: true, reason: null },
      commands: [command('root-id', ['id', '-u'], '0\n'), ...qualify('adbd_root')] },
    { id: 'probe-su-root', expected: { root_access: 'su', supported: true, simpleperf_available: true, reason: null },
      commands: [command('root-id', ['id', '-u'], '2000\n'), command('su-id', ['id', '-u'], '0\n', 'su'), ...qualify('su')] },
    { id: 'probe-su-denied', expected: { root_access: 'none', supported: false, simpleperf_available: false, reason: noRootReason },
      commands: [command('root-id', ['id', '-u'], '2000\n'), command('su-id', ['id', '-u'], '', 'su', 1)] },
    { id: 'probe-no-root', expected: { root_access: 'none', supported: false, simpleperf_available: false, reason: noRootReason },
      commands: [command('root-id', ['id', '-u'], '2000\n'), command('su-id', ['id', '-u'], '2000\n', 'su')] },
    { id: 'probe-no-simpleperf', expected: { root_access: 'adbd_root', supported: false, simpleperf_available: false, reason: noToolReason },
      commands: [command('root-id', ['id', '-u'], '0\n'), command('simpleperf-version', ['/system/bin/simpleperf', '--version'], '', 'adbd_root', 1)] },
    { id: 'probe-missing-required-help', expected: { root_access: 'adbd_root', supported: false, simpleperf_available: false, reason: noToolReason },
      commands: [command('root-id', ['id', '-u'], '0\n'), command('simpleperf-version', ['/system/bin/simpleperf', '--version'], 'simpleperf fixture-v1\n'),
        command('simpleperf-record-help', ['/system/bin/simpleperf', 'record', '--help'], '--clockid\n'),
        command('simpleperf-report-help', ['/system/bin/simpleperf', 'report-sample', '--help'], '--protobuf --show-callchain\n')] },
  ] };
