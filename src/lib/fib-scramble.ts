/*
 * Fibonacci-modulated XOR scramble — self-inverse (XOR against a data-independent
 * keystream). The server applies this to the pair token BEFORE AES-sealing, so
 * that a JS hook on WebCrypto's `subtle.decrypt` yields scrambled bytes, not the
 * URL. The wasm enclave (wasm/qr-enclave) un-scrambles inside linear memory.
 *
 * MUST match the Rust mirror `fib_unscramble` in wasm/qr-enclave/src/lib.rs.
 * Cross-language lockstep is pinned by the shared keystream vector
 * [1,2,3,5,8,13,21,34] — asserted in both tests/fib-scramble.test.ts and the
 * Rust `fib_vector_is_stable` test.
 */
export function fibScramble(data: Uint8Array, key = ''): Uint8Array {
  const keyBytes = key ? new TextEncoder().encode(key) : null;
  let a = 1;
  let b = 1;
  let keyIndex = 0;
  return Uint8Array.from(data, (byte) => {
    const keyByte = keyBytes ? (keyBytes.at(keyIndex) ?? 0) : 0;
    const outByte = byte ^ (b & 0xff) ^ keyByte;
    if (keyBytes) {
      keyIndex = (keyIndex + 1) % keyBytes.length;
    }
    const c = (a + b) >>> 0;
    a = b;
    b = c;
    if (b > 1_000_000) {
      a = 1;
      b = 1;
    }
    return outByte;
  });
}
