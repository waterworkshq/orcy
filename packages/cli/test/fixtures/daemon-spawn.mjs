import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (process.env.ORCY_TEST_SPAWN === 'error') return original('/nonexistent/orcy-test-node', args, options);
  if (process.env.ORCY_TEST_SPAWN === 'exit') return original(command, ['-e', 'process.exit(23)'], options);
  if (process.env.ORCY_TEST_SPAWN === 'hang') return original(command, ['-e', 'setInterval(() => {}, 1000)'], options);
  return original(command, args, options);
};
syncBuiltinESMExports();
