import assert from 'node:assert/strict';
import { events, diagnostic, processExited, ready } from './control.mjs';
import { elapsedMs } from './wait.mjs';

function only(observed, name) {
  const found = observed.filter((event) => event.event === name);
  assert.equal(found.length, 1, `本次夹具必须恰有一项 ${name} 控制事件`);
  return found[0];
}

export async function verifyProcess(item, entry) {
  const observed = await processExited(item, entry);
  only(observed, 'ready');
  only(observed, 'stdin_eof');
  const success = entry.expected_status === 'succeeded';
  if (item.protocolVersion === 3 || success) {
    const response = only(observed, 'response_written');
    const exit = only(observed, 'process_exit');
    assert.equal(exit.code, 0, '夹具自身退出事件必须为零，另行核对真实 PID 消失');
    assert.ok(BigInt(exit.monotonic_ns) >= BigInt(response.monotonic_ns));
  } else {
    assert.equal(
      observed.filter((event) => event.event === 'response_written').length,
      0,
      '协议 2 hold 未 release 时不得返回成功响应',
    );
    entry.noncooperative_exit = {
      confirmed_direct_pid_gone: true,
      fixture_exit_event_present: observed.some((event) => event.event === 'process_exit'),
      cooperative_cleanup_proven: false,
    };
  }
  const cancellations = observed.filter((event) => event.event === 'cancel_received');
  if (item.protocolVersion === 3) {
    const cleaned = only(observed, 'cleaned');
    const exit = only(observed, 'process_exit');
    assert.ok(BigInt(cleaned.monotonic_ns) <= BigInt(exit.monotonic_ns));
    if (success) assert.equal(cancellations.length, 0);
    else {
      assert.equal(cancellations.length, 1);
      const cancel = cancellations[0];
      assert.equal(cancel.request_id, entry.process.request_id);
      assert.equal(cancel.control_request_id, entry.process.request_id);
      assert.equal(cancel.command, 'cancel');
      assert.equal(cancel.id_matches, true);
      assert.equal(cancel.reason, entry.expected_status === 'failed' ? 'timeout' : 'cancelled');
      assert.ok(BigInt(cancel.monotonic_ns) <= BigInt(cleaned.monotonic_ns));
      entry.control_cancel_reason = cancel.reason;
      entry.fixture_cancel_to_exit_ms = elapsedMs(cancel.monotonic_ns, exit.monotonic_ns);
      assert.ok(
        entry.fixture_cancel_to_exit_ms <= 1250,
        '夹具收到取消至零退出自报不得超过既有合作窗口',
      );
    }
    entry.cleanup = {
      controlled_marker: 'cleaned',
      direct_pid_gone: true,
      response_written: true,
      fixture_exit_event_code: 0,
      scope: '本次夹具受控文件资源；匹配线上 cleanup=complete 由宿主解析及取消清理日志另证',
    };
  } else {
    assert.equal(cancellations.length, 0, '协议 2 不具有合作取消控制帧');
    entry.cleanup_scope = '只确认本次直接 PID 退出和正常输入 EOF，不证明合作清理或外部资源';
  }
  const details = await diagnostic(item, entry);
  if (item.protocolVersion === 3 || success) {
    assert.ok(details, '正常退出路径必须保留夹具诊断，但诊断不替代实际 PID 检查');
    assert.equal(details.outcome, success ? 'succeeded' : 'cancelled');
    assert.equal(details.failure_code, null);
    assert.equal(details.cancel_reason, success ? null : entry.control_cancel_reason);
    assert.equal(details.response_started, true);
    assert.equal(details.response_written, true);
    assert.equal(details.stdin_eof, true);
    assert.equal(details.controlled_resource_released, true);
    assert.equal(details.exit_callback_code, 0);
  }
  entry.fixture_diagnostic = details ?? null;
  return entry;
}

// 失败收尾只取已经属于本轮的 ready/事件，不扫描或终止未知 PID。
export async function collectKnownProcesses(items, report) {
  for (const entry of report.jobs) {
    const item = items.find((item) => item.pluginId === entry.plugin_id);
    if (!item) continue;
    if (!entry.process) {
      try {
        await ready(item, entry, 250);
      } catch (error) {
        entry.ready_not_observed = { name: error.name, code: error.code };
        continue;
      }
    }
    try {
      await processExited(item, entry);
    } catch (error) {
      entry.pid_observation_error = { name: error.name, code: error.code };
      try {
        entry.events = await events(item, entry);
      } catch (eventError) {
        entry.event_observation_error = { name: eventError.name, code: eventError.code };
      }
    }
  }
}
