const fs = require('node:fs');
const mode = process.env.AI_FIXTURE_MODE;
const pidFile = process.env.AI_FIXTURE_PID;
const secret = process.env.AI_SECRET;
const thread = '12345678-1234-1234-1234-123456789abc';
let prompt = '';
fs.writeFileSync(pidFile, String(process.pid));
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => { prompt += text; });
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
process.stdin.on('end', () => {
  fs.writeFileSync(pidFile + '.prompt', prompt);
  process.stderr.write('hidden-stderr-' + secret);
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  emit({ type: 'item.started', item: { id: 'tool_1', type: 'command_execution', command: 'hidden-command-' + secret, status: 'in_progress' } });
  const complete = () => {
    emit({ type: 'item.completed', item: { id: 'tool_1', type: 'command_execution', status: 'completed', aggregated_output: 'hidden-output-' + secret } });
    emit({ type: 'item.completed', item: { id: 'answer_1', type: 'agent_message', text: '中文回答 ' + secret } });
    if (mode === 'partial') return;
    emit({ type: 'turn.completed', usage: { input_tokens: 1 } });
    if (mode === 'late') emit({ type: 'error', message: 'hidden-error-' + secret });
    if (mode === 'nonzero') process.exitCode = 7;
  };
  if (['normal', 'partial', 'nonzero', 'late'].includes(mode)) {
    complete();
  } else {
    const timer = setInterval(() => {
      if (mode === 'gated' && fs.existsSync(pidFile + '.continue')) {
        clearInterval(timer);
        complete();
      }
    }, 10);
  }
});
