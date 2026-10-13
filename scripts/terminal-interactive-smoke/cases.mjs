import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { recordOpen } from './evidence.mjs';

export async function poll(read, accept, label, budget = 10000) {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
        const value = await read();
        if (accept(value)) return value;
        await delay(25);
    }
    throw new Error(label + '超时');
}

function stream(chunks, name) {
    return Buffer.concat(chunks.filter(chunk => chunk.stream === name).map(chunk => Buffer.from(chunk.bytes)));
}

export async function toolPid(pidFile) {
    return poll(async () => {
        try { return Number(await readFile(pidFile, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    }, value => Number.isSafeInteger(value) && value > 0, '工具PID就绪');
}

export async function assertPidGone(pid) {
    await poll(async () => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    }, Boolean, '工具PID退出');
}

export async function echo(host, id, pidFile, mcp, report) {
    const client = host.client;
    const first = await poll(() => client.json(`/api/v2/sessions/${id}/output`), page =>
        stream(page.chunks, 'stdout').includes(Buffer.from([82, 69, 65, 68, 89, 0, 255]))
        && stream(page.chunks, 'stderr').includes(Buffer.from([69, 82, 82, 0, 254])), '退出前双路输出');
    assert.equal(first.session.status, 'running');
    const pid = await toolPid(pidFile);
    const send = bytes => mcp ? client.tool('deviceforge.session_input', { id, bytes })
        : client.post(`/api/v2/sessions/${id}/input`, { bytes });
    for (const bytes of [[0, 255, 12], [65, 66]]) {
        assert.deepEqual(await send(bytes), { id, accepted: true });
    }
    await poll(() => client.json(`/api/v2/sessions/${id}/output`), page =>
        stream(page.chunks, 'stdout').includes(Buffer.from([0, 255, 12, 65, 66])), '同一工具多次输入');
    const eof = mcp ? await client.tool('deviceforge.session_eof', { id })
        : await client.post(`/api/v2/sessions/${id}/eof`);
    assert.deepEqual(eof, { id, accepted: true });
    const info = await poll(() => client.json(`/api/v2/sessions/${id}`), info => info.status === 'finished', 'EOF终态');
    assert.equal(info.completion.cleanup, 'complete');
    assert.equal(info.completion.process_exited, true);
    assert.equal(info.completion.failure, null);
    assert.equal(info.completion.outcome.result.exit_code, 0);
    const page = await client.json(`/api/v2/sessions/${id}/output`);
    assert.deepEqual(await client.tool('deviceforge.session_output', { id }), page);
    assert.deepEqual(await client.tool('deviceforge.get_session', { id }), info);
    assert.deepEqual(stream(page.chunks, 'stdout'), Buffer.from([82, 69, 65, 68, 89, 0, 255, 0, 255, 12, 65, 66, 69, 79, 70, 0]));
    assert.deepEqual(stream(page.chunks, 'stderr'), Buffer.from([69, 82, 82, 0, 254]));
    assert.deepEqual(page.chunks.map(chunk => chunk.sequence), page.chunks.map((_, index) => index + 1));
    const one = await client.json(`/api/v2/sessions/${id}/output?after=0&limit=1`);
    assert.equal(one.chunks.length, 1);
    assert.equal(one.next_sequence, 1);
    await assertPidGone(pid);
    report.sessions.push({ id, entry: mcp ? 'mcp' : 'http', pid, pid_absent: true,
        stdout_bytes: stream(page.chunks, 'stdout').length, stderr_bytes: stream(page.chunks, 'stderr').length,
        output_sequence: page.session.output_sequence, finished_sequence: info.completion.sequence,
        cleanup: info.completion.cleanup });
    report.checks.push({ name: mcp ? 'MCP打开及多次原字节输入' : 'HTTP打开及多次原字节输入', passed: true });
}

export async function held(host, profile, pidFile, report) {
    const info = await host.client.post('/api/v2/sessions', { operation: 'plugin.terminal.open', input: { profile } }, { status: 202 });
    recordOpen(host, info, report);
    const pid = await toolPid(pidFile);
    await poll(() => host.client.json(`/api/v2/sessions/${info.id}`), info => info.status === 'running', '持有会话准备');
    return { id: info.id, pid };
}

export async function stopped(host, session, report, label) {
    const info = await poll(() => host.client.json(`/api/v2/sessions/${session.id}`), info => info.status === 'finished', label);
    assert.equal(info.completion.cleanup, 'complete');
    assert.equal(info.completion.process_exited, true);
    await assertPidGone(session.pid);
    report.sessions.push({ ...session, entry: label, pid_absent: true, cleanup: info.completion.cleanup,
        failure_code: info.completion.failure?.code });
    report.checks.push({ name: label, passed: true });
}
