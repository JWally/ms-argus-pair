/*
 * TDD spec for the isomorphic ECIES seal used to deliver the pair-token QR.
 * Locks the crypto contract the Lambda (seal side) and the worker (open side)
 * must agree on byte-for-byte. Runs under Node's WebCrypto — the same subtle
 * API the browser worker uses. Byte-level: the active payload is server-
 * rendered QR PNG bytes, and `openBytes` never TextDecodes it into a JS string.
 */
import { describe, expect, it } from 'vitest';
import {
  genKeyPair,
  exportPubRaw,
  importPubRaw,
  deriveAesKey,
  sealBytes,
  openBytes,
} from '../src/lib/ecdh-seal.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

/** Full round-trip: server seals for the worker; worker opens. */
async function roundTrip(plaintext: string): Promise<string> {
  const worker = await genKeyPair(); // ephemeral, in the worker realm
  const server = await genKeyPair(); // ephemeral, per-mint on the server

  const workerPub = await importPubRaw(await exportPubRaw(worker.publicKey));
  const serverPub = await importPubRaw(await exportPubRaw(server.publicKey));

  const serverKey = await deriveAesKey(server.privateKey, workerPub);
  const blob = await sealBytes(serverKey, bytes(plaintext));

  const workerKey = await deriveAesKey(worker.privateKey, serverPub);
  return str(await openBytes(workerKey, blob));
}

describe('ecdh-seal', () => {
  it('round-trips a pair token through ephemeral-ephemeral ECDH', async () => {
    const token = '0DJ06tuZ5eEzdLcJJRWWwg';
    expect(await roundTrip(token)).toBe(token);
  });

  it('round-trips arbitrary bytes', async () => {
    expect(await roundTrip('scrambled\x00\xff\x01bytes')).toBe('scrambled\x00\xff\x01bytes');
  });

  it('raw public key export is the 65-byte uncompressed point (~88 b64url chars)', async () => {
    const { publicKey } = await genKeyPair();
    const raw = await exportPubRaw(publicKey);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw.length).toBeGreaterThanOrEqual(86);
  });

  it('a wrong worker key cannot open the blob (mismatched ECDH pair)', async () => {
    const server = await genKeyPair();
    const worker = await genKeyPair();
    const attacker = await genKeyPair();
    const serverPub = await importPubRaw(await exportPubRaw(server.publicKey));

    const serverKey = await deriveAesKey(
      server.privateKey,
      await importPubRaw(await exportPubRaw(worker.publicKey))
    );
    const blob = await sealBytes(serverKey, bytes('secret-token'));

    const attackerKey = await deriveAesKey(attacker.privateKey, serverPub);
    await expect(openBytes(attackerKey, blob)).rejects.toBeDefined();
  });

  it('a tampered blob fails the GCM tag', async () => {
    const server = await genKeyPair();
    const worker = await genKeyPair();
    const serverKey = await deriveAesKey(
      server.privateKey,
      await importPubRaw(await exportPubRaw(worker.publicKey))
    );
    const workerKey = await deriveAesKey(
      worker.privateKey,
      await importPubRaw(await exportPubRaw(server.publicKey))
    );
    const blob = await sealBytes(serverKey, bytes('secret-token'));
    const flipped = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A');
    await expect(openBytes(workerKey, flipped)).rejects.toBeDefined();
  });
});
