import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
if (process.env.ORCY_TEST_DELAY_RESERVED && process.send) {
  const send = process.send.bind(process);
  process.send = (message, ...args) => {
    if (message === 'orcy-daemon-reserved') {
      setTimeout(() => send(message, ...args), 16000);
      return true;
    }
    return send(message, ...args);
  };
}
const original = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (process.env.ORCY_TEST_SPAWN === 'error') return original('/nonexistent/orcy-test-node', args, options);
  if (process.env.ORCY_TEST_SPAWN === 'exit') return original(command, ['-e', 'process.exit(23)'], options);
  if (process.env.ORCY_TEST_SPAWN === 'hang') return original(command, ['-e', "require('fs').writeFileSync(process.env.HOME + '/synthetic-child.pid', String(process.pid)); setInterval(() => {}, 1000)"], options);
  const child = original(command, args, options);
  if (process.env.ORCY_TEST_RECORD_CHILD && child.pid) writeFileSync(process.env.ORCY_TEST_RECORD_CHILD, String(child.pid));
  return child;
};
syncBuiltinESMExports();
