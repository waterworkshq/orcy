import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function generateSecret(length = 32): string {
  return randomBytes(length).toString('hex');
}

const rootEnv = resolve('.env');
const apiEnv = resolve('packages/api/.env');

if (existsSync(rootEnv)) {
  console.log('.env already exists. Run \`pnpm dev\` to start.');
  process.exit(0);
}

const examplePath = resolve('.env.example');
if (!existsSync(examplePath)) {
  console.error('.env.example not found');
  process.exit(1);
}

let content = readFileSync(examplePath, 'utf-8');

content = content
  .replace(
    'JWT_SECRET=change-me-to-a-random-secret-in-production',
    `JWT_SECRET=${generateSecret(64)}`,
  )
  .replace(
    'ORCY_REGISTRATION_TOKEN=change-me-to-register-agents',
    `ORCY_REGISTRATION_TOKEN=${generateSecret(32)}`,
  )
  .replace('NODE_ENV=production', 'NODE_ENV=development');

writeFileSync(rootEnv, content, { mode: 0o600 });
console.log('Created .env with auto-generated secrets');

mkdirSync(dirname(apiEnv), { recursive: true });
if (!existsSync(apiEnv)) {
  writeFileSync(apiEnv, content, { mode: 0o600 });
  console.log('Created packages/api/.env for pnpm dev:api');
}

console.log('Run \`pnpm dev\` to start both API and UI.');
console.log('Open http://localhost:5173 for the Web UI.');
