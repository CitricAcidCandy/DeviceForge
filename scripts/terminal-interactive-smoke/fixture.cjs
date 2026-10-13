const fs = require('node:fs');

const [mode, pidFile] = process.argv.slice(2);
fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
const watchdog = setTimeout(() => process.exit(124), 60000);
watchdog.unref();
process.stdout.write(Buffer.from([82, 69, 65, 68, 89, 0, 255]));
process.stderr.write(Buffer.from([69, 82, 82, 0, 254]));

if (mode === 'nonzero') {
    process.exitCode = 7;
} else if (mode === 'hang') {
    setInterval(() => {}, 1000);
    process.stdin.on('end', () => process.stdout.write(Buffer.from([69, 79, 70, 0])));
    process.stdin.resume();
} else {
    process.stdin.on('data', bytes => process.stdout.write(bytes));
    process.stdin.on('end', () => process.stdout.write(Buffer.from([69, 79, 70, 0])));
}
