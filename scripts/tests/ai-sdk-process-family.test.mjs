import assert from 'node:assert/strict';
import test from 'node:test';
import { consoleHostPath, isConsoleHost } from '../ai-sdk-smoke/processes.mjs';

const systemRoot = 'C:\\Windows';
const plugin = 'C:\\freeze\\deviceforge-ai-sdk-plugin.exe';
const members = new Map([[101, { pid: 101, executable: plugin }]]);
const approved = new Set([plugin.toLowerCase()]);

test('Windows控制台宿主只接受SystemRoot下的精确路径', () => {
  assert.equal(consoleHostPath(systemRoot), 'c:\\windows\\system32\\conhost.exe');
  const accepted = [
    'C:\\Windows\\System32\\conhost.exe',
    '\\\\?\\C:\\Windows\\System32\\conhost.exe',
  ];
  for (const executable of accepted) {
    assert.equal(
      isConsoleHost({ executable, parent_pid: 101 }, members, approved, systemRoot),
      true,
    );
  }
  const rejected = [
    'C:\\Windows\\System32\\conhost.exe.bak',
    'C:\\Windows\\System32\\conhost.exe\\child',
    'C:\\Windows\\SysWOW64\\conhost.exe',
    'C:\\Temp\\conhost.exe',
  ];
  for (const executable of rejected) {
    assert.equal(
      isConsoleHost({ executable, parent_pid: 101 }, members, approved, systemRoot),
      false,
    );
  }
});

test('Windows控制台宿主必须由冻结成员直接派生', () => {
  const executable = 'C:\\Windows\\System32\\conhost.exe';
  assert.equal(
    isConsoleHost({ executable, parent_pid: 999 }, members, approved, systemRoot),
    false,
  );
  const unapprovedMembers = new Map([[101, { pid: 101, executable: 'C:\\Temp\\unknown.exe' }]]);
  assert.equal(
    isConsoleHost({ executable, parent_pid: 101 }, unapprovedMembers, approved, systemRoot),
    false,
  );
});
