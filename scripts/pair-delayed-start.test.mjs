#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const demoPage = fs.readFileSync(path.join(root, 'src/pages/Demo.tsx'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`pair-delayed-start: ${message}`);
    process.exitCode = 1;
  }
}

assert(
  demoPage.includes("import { Dialpad } from '../components/Dialpad'") &&
    demoPage.includes('function StartPanel') &&
    demoPage.includes('<Dialpad') &&
    demoPage.includes('actionLabel="START"') &&
    demoPage.includes('onSend={onStart}'),
  'demo should render the multiplication dialpad as the explicit start surface before pairing'
);

assert(
  demoPage.includes("const showStart = phase === 'idle'") &&
    demoPage.includes("phase === 'scanning' || phase === 'waiting'"),
  'QR/session UI should be separate from the idle start surface'
);

assert(
  !demoPage.includes('startedRef') && !demoPage.includes('void startDemo();\n  }, []);'),
  'demo should not auto-start the session or Argus scan on mount'
);

assert(
  demoPage.includes("if (phase === 'scanning' || phase === 'waiting') return;") &&
    demoPage.includes('const session = await startDesktopSession'),
  'startDemo should be the guarded user-initiated entrypoint for session creation'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('pair-delayed-start: ok');
