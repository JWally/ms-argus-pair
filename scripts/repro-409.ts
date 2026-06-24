/**
 * Empirical reproduction of the "409 argus_session_already_claimed" bug.
 *
 * Mechanism under test (claim-before-verify ordering in /phone-attest):
 *   POST #1  silent device-trust redeem → claimArgusSessionId(sid) COMMITS
 *            → device-trust verify then fails (e.g. mobile IP rotated) → 401,
 *            but NO attestation is stored (401 returns before the store).
 *   POST #2  client clears the token, re-submits the SAME scan (same
 *            argusSessionId) on the WebAuthn fallback → claimArgusSessionId(sid)
 *            AGAIN → ledger already holds the id → 409.
 *
 * This drives the REAL claimArgusSessionId against the REAL dev DDB ledger.
 * The live Lambda uses the Valkey twin (claimArgusValkey), which is the same
 * atomic claim-if-absent (SET NX) logic — so the result transfers.
 *
 * Run: USE_VALKEY_SESSIONS= TABLE_NAME=<table> AWS_REGION=us-east-1 \
 *      npx tsx scripts/repro-409.ts
 */
import { randomUUID } from 'crypto';
import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { claimArgusSessionId } from '../cdk/lib/pair-api';

async function main() {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error('set TABLE_NAME');
  if (process.env.USE_VALKEY_SESSIONS === 'true') {
    throw new Error('unset USE_VALKEY_SESSIONS so the DDB branch is exercised');
  }

  const argusSessionId = `repro-${randomUUID()}`;
  const pairSession = `pair-${randomUUID()}`;
  const otherPairSession = `pair-${randomUUID()}`;
  console.log(`argusSessionId = ${argusSessionId}`);
  console.log(`pairSession    = ${pairSession}\n`);

  // POST #1 — silent redeem claims the id (device-trust then 401s; no store).
  const first = await claimArgusSessionId(argusSessionId, pairSession, 'phone');
  console.log(`POST #1 claim (silent redeem)              -> ${JSON.stringify(first)}`);

  // POST #2 — same scan re-submitted on the WebAuthn fallback, SAME id.
  const second = await claimArgusSessionId(argusSessionId, pairSession, 'phone');
  console.log(`POST #2 claim (fallback, SAME pairSession) -> ${JSON.stringify(second)}`);

  // For contrast: a genuinely different pair session reusing the id (the
  // recycling attack the ledger is meant to stop).
  const attacker = await claimArgusSessionId(argusSessionId, otherPairSession, 'phone');
  console.log(`         claim (DIFFERENT pairSession)      -> ${JSON.stringify(attacker)}`);

  console.log('\n--- interpretation ---');
  if (!second.ok && second.reason === 'already_claimed') {
    console.log('BUG REPRODUCED: POST #2 (legit same-session retry) is rejected as');
    console.log('already_claimed -> the handler returns 409 argus_session_already_claimed.');
  } else if (second.ok) {
    console.log('FIXED: POST #2 same-session retry is idempotent (ok). No 409.');
    console.log(
      attacker.ok
        ? 'WARNING: different-session reuse ALSO accepted — recycling guard broken!'
        : 'Different-session reuse still rejected — recycling guard intact.'
    );
  }

  // Cleanup the synthetic ledger row.
  const ddb = new DynamoDBClient({});
  await ddb.send(
    new DeleteItemCommand({
      TableName: table,
      Key: { PK: { S: `ARGUSSID#${argusSessionId}` }, SK: { S: 'CLAIM' } },
    })
  );
  console.log('\n(cleaned up synthetic ledger row)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
