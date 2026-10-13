import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';

function values(record, key) {
    const found = new Set();
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        for (const [name, item] of Object.entries(value)) {
            if (name === key && typeof item === 'string') found.add(item);
            else if (item && typeof item === 'object') visit(item);
        }
    };
    visit(record.fields); visit(record.span); visit(record.spans);
    return found;
}

export async function verifyLogs(directory, host, report) {
    const root = join(directory, 'data/logs'), found = new Set(), starts = new Map(), ends = new Map(), files = [];
    let records = 0, stops = 0, bytes = 0;
    for (const name of (await readdir(root)).filter(name => name.endsWith('.jsonl'))) {
        const path = join(root, name), identity = await fileIdentity(path);
        bytes += identity.bytes;
        assert.ok(identity.bytes <= 16 * 1024 * 1024 && bytes <= 64 * 1024 * 1024);
        files.push(identity);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
        for (const [index, line] of text.split('\n').entries()) {
            if (!line.trim()) continue;
            const record = JSON.parse(line), ids = values(record, 'log_id'); records++;
            for (const id of ids) if (host.client.logIds.has(id)) found.add(id);
            const message = record.fields?.message;
            if (message === '宿主运行已结束') stops++;
            if (!values(record, 'plugin_id').has('dex-analysis')) continue;
            const job = report.jobs.find(entry => values(record, 'job_id').has(entry.id));
            if (!job) continue;
            const collection = message === '插件调用开始' ? starts : message === '插件调用结束' ? ends : undefined;
            if (!collection) continue;
            assert.ok(!collection.has(job.id));
            assert.ok(ids.has(job.submit_log_id));
            collection.set(job.id, { path, line: index + 1, log_id: job.submit_log_id });
        }
    }
    assert.deepEqual([...found].sort(), [...host.client.logIds].sort());
    assert.equal(starts.size, report.jobs.length); assert.equal(ends.size, report.jobs.length); assert.ok(stops > 0);
    report.logging = { records, response_ids: [...found].sort(), files, normal_stop_records: stops,
        jobs: report.jobs.map(job => ({ id: job.id, start: starts.get(job.id), end: ends.get(job.id) })) };
}
