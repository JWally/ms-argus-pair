//! QR SCIF enclave.
//!
//! The pair token arrives worker-hash + fib-XOR-scrambled (the AES plaintext, so hooking
//! WebCrypto's `subtle.decrypt` in JS yields scrambled garbage, not the URL).
//! This module un-scrambles it, builds the QR, applies the spatial-frequency
//! poison, and rasters to an RGBA buffer — all in wasm linear memory. The
//! plaintext pair URL never becomes a JS value; only the pixel buffer leaves.
//! An attacker who owns the page realm is forced to dump wasm memory or
//! optically decode the rendered (poisoned) pixels — the hard ceiling.
//!
//! MUST stay in lockstep with the JS side:
//!   - fib scramble: src/lib/fib-scramble.ts (server applies it before sealing)
//!   - poison + geometry: src/lib/qr-paint.ts (SCALE, QUIET, POISON, function
//!     modules) — this is the Rust mirror, covered by the same blur-decode spec.

use qrcode::{EcLevel, QrCode};

// Tiny allocator instead of std's dlmalloc — trims a few KB off the wasm. The
// enclave renders one QR then the worker is terminated, but FreeListAllocator
// frees anyway so repeated renders wouldn't leak. Single-threaded: wasm is.
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOC: lol_alloc::AssumeSingleThreaded<lol_alloc::FreeListAllocator> =
    unsafe { lol_alloc::AssumeSingleThreaded::new(lol_alloc::FreeListAllocator::new()) };

const SCALE: usize = 24; // backing px per module — matches qr-paint.ts
const QUIET: usize = 2; // quiet-zone margin in modules
const POISON: f64 = 0.18; // inverted-center width as a fraction of a module

/// Fibonacci-modulated XOR — self-inverse. Mirror of fib-scramble.ts. The
/// optional worker-hash key binds the sealed bytes to the exact worker asset
/// the server verified before minting.
fn fib_unscramble(data: &mut [u8], key: &[u8]) {
    let (mut a, mut b) = (1u32, 1u32);
    for (i, byte) in data.iter_mut().enumerate() {
        let key_byte = if key.is_empty() { 0 } else { key[i % key.len()] };
        *byte ^= (b & 0xff) as u8 ^ key_byte;
        let c = a.wrapping_add(b);
        a = b;
        b = c;
        if b > 1_000_000 {
            a = 1;
            b = 1;
        }
    }
}

/// Function modules (finders/timing/alignment) carry the code's structure and
/// are never poisoned. Mirror of isFunctionModule in qr-paint.ts (versions 1-6).
fn is_function_module(r: usize, c: usize, n: usize) -> bool {
    if r < 9 && c < 9 {
        return true;
    }
    if r < 9 && c >= n - 8 {
        return true;
    }
    if r >= n - 8 && c < 9 {
        return true;
    }
    if r == 6 || c == 6 {
        return true;
    }
    if n >= 25 {
        let a = (n - 7) as isize;
        if (r as isize - a).abs() <= 3 && (c as isize - a).abs() <= 3 {
            return true;
        }
    }
    false
}

#[inline]
fn fill(data: &mut [u8], width: usize, mx: usize, my: usize, w: usize, v: u8) {
    for y in 0..w {
        for x in 0..w {
            let i = ((my + y) * width + (mx + x)) * 4;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
        }
    }
}

/// Core render (no wasm glue) so it's unit-testable natively with `cargo test`.
/// Returns RGBA bytes; the image is square, so width = sqrt(len / 4).
pub fn render_core(scrambled: &[u8], base: &str, suffix: &str, worker_hash: &str) -> Vec<u8> {
    let mut token_bytes = scrambled.to_vec();
    fib_unscramble(&mut token_bytes, worker_hash.as_bytes());
    // Build the URL as raw bytes (no format!/String → no core::fmt bloat). The
    // URL exists only here, in wasm memory, for the lifetime of this call.
    let mut url = Vec::with_capacity(base.len() + 3 + token_bytes.len() + suffix.len());
    url.extend_from_slice(base.as_bytes());
    url.extend_from_slice(b"/p/");
    url.extend_from_slice(&token_bytes);
    url.extend_from_slice(suffix.as_bytes());

    let code = match QrCode::with_error_correction_level(&url, EcLevel::M) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let n = code.width();
    let colors = code.to_colors();
    let dark = |r: usize, c: usize| colors[r * n + c] == qrcode::Color::Dark;

    let span = n + QUIET * 2;
    let width = span * SCALE;
    let mut data = vec![255u8; width * width * 4]; // white background (RGBA)

    // Dark modules.
    for r in 0..n {
        for c in 0..n {
            if dark(r, c) {
                fill(&mut data, width, (c + QUIET) * SCALE, (r + QUIET) * SCALE, SCALE, 0);
            }
        }
    }

    // Poison: invert a centered square on every DATA module.
    let dot = (POISON.clamp(0.0, 1.0) * SCALE as f64).round() as usize;
    if dot > 0 {
        let off = ((SCALE - dot) as f64 / 2.0).round() as usize;
        for r in 0..n {
            for c in 0..n {
                if is_function_module(r, c, n) {
                    continue;
                }
                let v = if dark(r, c) { 255 } else { 0 }; // inverted center
                fill(&mut data, width, (c + QUIET) * SCALE + off, (r + QUIET) * SCALE + off, dot, v);
            }
        }
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Apply the (self-inverse) fib scramble to a plaintext token, the way the
    /// server does before sealing, so render_core can un-scramble it back.
    fn scramble(token: &str) -> Vec<u8> {
        let mut b = token.as_bytes().to_vec();
        fib_unscramble(&mut b, b"");
        b
    }

    fn scramble_with_key(token: &str, key: &str) -> Vec<u8> {
        let mut b = token.as_bytes().to_vec();
        fib_unscramble(&mut b, key.as_bytes());
        b
    }

    /// Separable box blur on luminance — models the phone lens low-pass.
    fn blur(rgba: &[u8], w: usize, k: i32) -> Vec<u8> {
        let lum: Vec<f64> = (0..w * w).map(|i| rgba[i * 4] as f64).collect();
        let clamp = |v: i32| v.clamp(0, w as i32 - 1) as usize;
        let norm = (2 * k + 1) as f64;
        let mut tmp = vec![0.0f64; w * w];
        for y in 0..w {
            for x in 0..w {
                let mut s = 0.0;
                for d in -k..=k {
                    s += lum[y * w + clamp(x as i32 + d)];
                }
                tmp[y * w + x] = s / norm;
            }
        }
        let mut out = vec![0u8; w * w];
        for x in 0..w {
            for y in 0..w {
                let mut s = 0.0;
                for d in -k..=k {
                    s += tmp[clamp(y as i32 + d) * w + x];
                }
                out[y * w + x] = (s / norm) as u8;
            }
        }
        out
    }

    fn decode(gray: &[u8], w: usize) -> Option<String> {
        let mut img = rqrr::PreparedImage::prepare_from_greyscale(w, w, |x, y| gray[y * w + x]);
        let grids = img.detect_grids();
        grids.first().and_then(|g| g.decode().ok()).map(|(_, s)| s)
    }

    #[test]
    fn poisoned_qr_decodes_through_a_lens() {
        let base = "https://captcha-dev-jw.argus.pw";
        let token = "0DJ06tuZ5eEzdLcJJRWWwg";
        let rgba = render_core(&scramble(token), base, "", "");
        let w = (rgba.len() as f64 / 4.0).sqrt() as usize;
        assert!(w > 0, "render produced no pixels");
        let blurred = blur(&rgba, w, (SCALE as f64 * 0.35).round() as i32);
        assert_eq!(
            decode(&blurred, w).as_deref(),
            Some(format!("{base}/p/{token}").as_str()),
            "a lens (blur) must decode the true URL"
        );
    }

    #[test]
    fn fib_scramble_is_self_inverse() {
        let original = b"hello-token-123";
        let mut buf = original.to_vec();
        fib_unscramble(&mut buf, b"");
        assert_ne!(&buf, original, "scramble must change the bytes");
        fib_unscramble(&mut buf, b"");
        assert_eq!(&buf, original, "applying twice must restore");
    }

    #[test]
    fn worker_hash_key_is_required_to_render_token() {
        let base = "https://captcha-dev-jw.argus.pw";
        let token = "0DJ06tuZ5eEzdLcJJRWWwg";
        let key = "sha256-example";
        let rgba = render_core(&scramble_with_key(token, key), base, "", key);
        let wrong = render_core(&scramble_with_key(token, key), base, "", "sha256-other");
        let w = (rgba.len() as f64 / 4.0).sqrt() as usize;
        let wrong_w = (wrong.len() as f64 / 4.0).sqrt() as usize;
        assert!(!rgba.is_empty(), "matching worker hash should render");
        let expected = format!("{base}/p/{token}");
        assert_eq!(decode(&blur(&rgba, w, (SCALE as f64 * 0.35).round() as i32), w).as_deref(), Some(expected.as_str()));
        assert_ne!(
            decode(&blur(&wrong, wrong_w, (SCALE as f64 * 0.35).round() as i32), wrong_w).as_deref(),
            Some(expected.as_str()),
            "wrong worker hash must not produce the real token URL"
        );
    }

    /// Pins the exact fib byte-stream so the JS server side (fib-scramble.ts)
    /// can assert against the SAME vector — cross-language lockstep.
    #[test]
    fn fib_vector_is_stable() {
        let mut buf = vec![0u8; 8]; // XOR against zero → the raw fib keystream
        fib_unscramble(&mut buf, b"");
        assert_eq!(buf, vec![1, 2, 3, 5, 8, 13, 21, 34]);
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm_exports {
    use wasm_bindgen::prelude::*;

    /// Un-scramble + raster. Input: the fib-scrambled token bytes (AES plaintext)
    /// and the public base origin. Output: RGBA pixels (square; width = sqrt/4).
    #[wasm_bindgen]
    pub fn render_qr(scrambled: &[u8], base: &str, suffix: &str, worker_hash: &str) -> Vec<u8> {
        super::render_core(scrambled, base, suffix, worker_hash)
    }
}
