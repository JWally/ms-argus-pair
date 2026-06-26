#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const wsHandler = fs.readFileSync(path.join(root, 'cdk/lib/ws-handler.ts'), 'utf8');
const pairStack = fs.readFileSync(path.join(root, 'cdk/lib/pair-stack.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`ws-single-connection: ${message}`);
    process.exitCode = 1;
  }
}

assert(
  wsHandler.includes('TransactWriteCommand') &&
    wsHandler.includes('attribute_not_exists(PK)') &&
    wsHandler.includes('`WS#${claims.sessionId}`') &&
    wsHandler.includes('`WSC#${connectionId}`'),
  'whoami should conditionally claim one live websocket slot per session role'
);

assert(
  wsHandler.includes('role_already_connected') &&
    wsHandler.includes('releaseRoleConnection') &&
    wsHandler.includes("route === '$disconnect'"),
  'duplicate role connections should fail and disconnects should release their claim'
);

assert(
  pairStack.includes('TABLE_NAME: table.tableName') &&
    pairStack.includes('table.grantReadWriteData(wsHandlerFn)'),
  'websocket handler should receive and be granted access to the session table'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('ws-single-connection: ok');
