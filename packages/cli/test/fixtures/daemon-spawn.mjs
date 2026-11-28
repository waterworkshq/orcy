import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs';
if (process.env.ORCY_TEST_DELAY_LOCK && process.env.ORCY_DAEMON_DETACHED_START === '1') {
  const link = fs.linkSync;
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = (...args) => {
    const result = mkdir(...args);
    if (String(args[0]).endsWith('/daemon.start.lock')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
    return result;
  };
  fs.linkSync = (...args) => {
    const result = link(...args);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
    return result;
  };
}
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
