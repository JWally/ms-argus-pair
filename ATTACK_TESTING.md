# Attack Regression Direction

This repository should keep a standing red-team harness around the pair and captcha flows. The goal is not to prove that QR secrecy or browser code secrecy is perfect. The goal is to continuously check that old bypasses stay closed, new changes do not reopen them, and any exposed weakness is classified against the real trust boundary.

## End Goal

Attack bots should give us fast, repeatable answers to three questions:

- Did an old vulnerability come back?
- Did a new implementation detail expose a fresh bypass?
- If an attacker can steal or tamper with client-side material, does the server still refuse to produce a passing verdict?

The harnesses should be honest. If a token can be stolen but cannot pass verification, that is not the same finding as a full captcha bypass. If a browser-side secret can be extracted, call it friction loss, not server compromise.

## What Bots Should Test

Regression bots should cover old findings first:

- Plaintext pair-token leaks from `/api/session/{id}/pair-token`.
- Pair-token minting without the desktop bootstrap token.
- Pair-token reuse after first redemption.
- QR URL exposure through DOM, console logs, canvas debug paths, worker messages, or network payloads.
- Worker rewrite, worker wrapping, blob-worker substitution, and route-level worker replacement.
- WebCrypto hook extraction before and after AES decrypt.
- WASM render input/output extraction.
- Forged phone-attest calls without a valid desktop envelope.
- Forged phone-attest calls with a stolen desktop envelope but no valid phone proof.
- Verification consumers incorrectly trusting `valid: true` without requiring `passed: true`.
- Virtual or test WebAuthn authenticators being treated as strong real-device proof.
- SSO challenge legs accepting non-phone or unclassified scans.

Bots should also probe for new exposures:

- New response fields that disclose tokens, secrets, hashes, routing envelopes, or verdict material.
- New query params or debug flags that bypass normal sealing.
- New fallback paths that fail open when workers, WASM, WebCrypto, storage, WebSocket, or Argus integrity are unavailable.
- New API endpoints that accept client-declared state without server-side lookup.
- Any trust decision that moved from server-owned evidence into browser-owned evidence.

## Attack Bot Shape

Each bot should be small, named for the attack class, and produce machine-readable evidence:

- One primary question per bot.
- Clear target and environment fields.
- Exact URLs/endpoints exercised.
- Status codes and compact response bodies.
- Extracted token previews only when needed; do not dump long secrets by default.
- A final `ok` boolean whose meaning is documented.
- A result JSON artifact under the attack-bot repo's `results/` directory.

Prefer deterministic API checks for server contracts and browser automation only where the attack requires a real page, worker, canvas, WebCrypto, WebAuthn, or cross-frame behavior.

## Scoring Results

Use precise labels:

- `blocked`: attack could not obtain the material it needed.
- `stolen_but_failed`: attack obtained client-side material, but server verdict stayed failed.
- `friction_loss`: attack bypassed obfuscation or client-side secrecy but did not pass the captcha.
- `server_gate_bypass`: attack produced a passing verifier result without valid proof.
- `test_stale`: bot failed because the expected request or page shape changed; update the bot before drawing conclusions.

The most important distinction is `friction_loss` versus `server_gate_bypass`. Client-side extraction is useful evidence, but the actual lock is the server verdict and `passed` bit.

## Regression Flow

Run attack bots after any change that touches:

- Pair-token minting or redemption.
- QR rendering, workers, WASM, ECDH, AES, or scrambling.
- Phone proof, WebAuthn, OAuth, device trust, or attestation.
- Projection lookup, scoring, or verdict generation.
- CSP, SRI, loader, embed, or merchant verification behavior.
- SSO start, challenge, validate, or claim routes.

The normal loop:

1. Run the known regression bot.
2. If it fails because the product changed, classify it as `test_stale`.
3. Update the bot to the new legitimate contract.
4. Run the old attack and one adaptive variant.
5. Record whether the final result is blocked, friction loss, or server bypass.
6. If the bot found a real bypass, add or update a server-side test before fixing.

## Adaptive Variants

For every client-side hardening, add at least one adaptive attack:

- If the defense checks a worker hash, try reporting the original hash from a rewritten worker.
- If the defense moves logic to WASM, hook the JS/WASM boundary and observe inputs/outputs.
- If the defense hides data from network responses, hook the next consumer that receives it.
- If the defense changes a scramble key, derive the key from the same shipped logic.
- If the defense adds a browser-side tripwire, test both triggering it and bypassing it.

This keeps us from mistaking "old harness broke" for "attack class is fixed."

## Server-Side Invariants

No attack bot should be able to make these false:

- `/api/verify` must require `passed: true` for a successful captcha result.
- A pair token must be authenticated to the desktop bootstrap token.
- A pair token must be single-use.
- A phone proof must bind back to the desktop envelope and session nonce.
- Forged or missing projection evidence must fail closed.
- Unknown, test, or virtual authenticator signals must not score like strong real-device proof.
- Debug or fallback mode must not weaken production/dev-jw gates unless explicitly configured for a test environment.

When one of these invariants breaks, treat it as a product bug, not merely a bot success.

## Evidence Hygiene

Every bot run should preserve enough context to explain the result later:

- Git commit or branch when available.
- Target URL and pair host.
- Browser mode and user agent.
- Relevant extracted artifacts.
- Final API responses.
- Whether the bot used stale assumptions or an adaptive technique.

Do not rely on screenshots alone. Keep structured JSON artifacts so future cleanup and security work can diff old and new behavior.

## Definition of Done

An attack regression pass is done when:

- Known old attacks have been rerun.
- Stale bots have been updated or explicitly marked stale.
- At least one adaptive variant has been attempted for any changed client-side defense.
- Findings are classified as blocked, friction loss, or server bypass.
- Real server bypasses have a failing regression test before the fix.
- The final result is summarized in plain language with artifact paths.

This is the durable attack-regression contract for Pair. Keep it aligned with
the executable bots in `ms-argus-attack-bots` and the server-side invariants in
this repository.
