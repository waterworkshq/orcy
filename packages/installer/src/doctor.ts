import fs from 'node:fs';
import { getContext } from './context.js';

export async function doctor(): Promise<void> {
  const ctx = getContext();
  let allGood = true;

  console.log('orcy installation doctor\n');

  const homeExists = fs.existsSync(ctx.orcyHome);
  console.log(`${homeExists ? 'OK' : 'FAIL'} ~/.orcy/ exists`);
  if (!homeExists) { allGood = false; }

  const binExists = fs.existsSync(ctx.binDir);
  console.log(`${binExists ? 'OK' : 'FAIL'} ${ctx.binDir} exists`);
  if (!binExists) { allGood = false; }

  const pathDirs = (process.env.PATH || '').split(':');
  const onPath = pathDirs.includes(ctx.binDir);
  console.log(`${onPath ? 'OK' : 'FAIL'} ${ctx.binDir} is on PATH`);

  for (const bin of ['orcy', 'orcy-api', 'orcy-mcp']) {
    const binPath = `${ctx.binDir}/${bin}`;
    const exists = fs.existsSync(binPath);
    console.log(`${exists ? 'OK' : 'FAIL'} ${bin} binary`);
    if (!exists) allGood = false;
  }

  try {
    const res = await fetch(`${ctx.apiUrl}/health`);
    const ok = res.ok;
    console.log(`${ok ? 'OK' : 'FAIL'} API reachable at ${ctx.apiUrl}`);
    if (!ok) allGood = false;
  } catch {
    console.log(`FAIL API unreachable at ${ctx.apiUrl}`);
    allGood = false;
  }

  const envExists = fs.existsSync(`${ctx.orcyHome}/.env`);
  console.log(`${envExists ? 'OK' : 'FAIL'} ~/.orcy/.env exists`);

  const credsExists = fs.existsSync(`${ctx.orcyHome}/credentials.json`);
  console.log(`${credsExists ? 'OK' : 'FAIL'} ~/.orcy/credentials.json exists`);

  const manifestExists = fs.existsSync(`${ctx.orcyHome}/install-manifest.json`);
  console.log(`${manifestExists ? 'OK' : 'FAIL'} install manifest exists`);

  console.log(`\n${allGood ? 'All checks passed' : 'Some checks failed'}`);
}
