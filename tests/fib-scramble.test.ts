/*
 * fib-scramble.ts must stay byte-identical to the Rust mirror in
 * wasm/qr-enclave/src/lib.rs (fib_unscramble), or the server scrambles with one
 * keystream and the wasm enclave un-scrambles with another → a broken QR. The
 * shared vector [1,2,3,5,8,13,21,34] is asserted here AND in the Rust
 * `fib_vector_is_stable` test; if they ever diverge, one side goes red.
 */
import { describe, expect, it } from 'vitest';
import { fibScramble } from '../src/lib/fib-scramble.ts';

describe('fibScramble', () => {
  it('matches the cross-language keystream vector (XOR against zeros)', () => {
    const keystream = Array.from(fibScramble(new Uint8Array(8)));
    expect(keystream).toEqual([1, 2, 3, 5, 8, 13, 21, 34]);
  });

  it('is self-inverse', () => {
    const original = new TextEncoder().encode('hello-token-123');
    const scrambled = fibScramble(original);
    expect(Array.from(scrambled)).not.toEqual(Array.from(original));
    expect(Array.from(fibScramble(scrambled))).toEqual(Array.from(original));
  });
});
