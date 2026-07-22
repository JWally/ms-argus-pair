# ms-argus-pair

The **Argus Captcha** — QR device-pairing as proof of humanity. A desktop page
shows a QR; a real phone scans it; both sides run an Argus integrity scan; the
phone optionally adds proof-of-life (silent device-trust token, WebAuthn
passkey, or Google sign-in); the server scores it all and hands back a
**signed verdict token** the embedding site verifies server-to-server.

One self-contained microservice: the pairing app + backend (deployed at
`captcha-dev-jw.argus.pw`) plus the embeddable loader and its CDN
(`static-captcha-dev-jw.argus.pw`). Marketing pages live in `ms-argus-www`;
fraud scoring lives in `ms-argus-api` (consumed here as the "merchant API").

## Embed (what a customer writes)

```html
<script
  src="https://static-captcha-dev-jw.argus.pw/captcha.js"
  data-cpi="argus_cpi_live_..."
  data-challenge-id="checkout_1234567890abcdef"
  data-onresult="onPair"
></script>
<div class="argus-captcha"></div>
<script>
  function onPair(r) {
    // r = { sessionId, verdict, reason, token }
    // POST r.token to YOUR server → it calls POST {pairOrigin}/api/verify
    // with { token: r.token, cpi: "argus_cpi_live_....forceauth",
    //        challengeId: "checkout_1234567890abcdef" }
    // → trusted { valid, passed, verdict, sessionId, cpi, challengeId }.
    // Gate on `passed` (true only when verdict === "paired"), NOT `valid`
    // — `valid` just means the signature is authentic; a real token can
    // carry a "failed" verdict. Never trust the browser's r.verdict alone.
  }
</script>
```

Or programmatically:
`window.argusCaptcha.render(el, { cpi, challengeId, onResult, onEvent })`.

Mobile SSO is a separate merchant-owned action, not part of the QR widget. Wire
your own button to the loader API:

```js
window.argusCaptcha.startMobileSso({
  cpi: 'argus_cpi_live_....fastpass',
  challengeId: 'checkout_1234567890abcdef',
  returnUrl: 'https://merchant.example/captcha/sso-return',
});
```

The loader navigates to the canonical Argus mobile flow. The merchant controls
whether, where, and how the SSO action is presented.

The merchant backend must generate a fresh, unpredictable URL-safe
`challengeId` (16-128 characters) for each protected checkout or action and
store it with that transaction. Render that same value into the widget and send
it again from the backend to `/api/verify`. The challenge is public, not a
secret; exact binding prevents a valid result from being moved to a different
transaction without adding a redemption database call.

Append `.fastpass` for an explicit integrity-only flow, `.stepup` to accept
proof-of-life including cached device trust, or `.forceauth` to require a fresh
passkey/Google ceremony on every run:

```html
<script
  src="https://static-captcha-dev-jw.argus.pw/captcha.js"
  data-cpi="argus_cpi_live_EXAMPLE123.stepup"
  data-challenge-id="checkout_1234567890abcdef"
  data-onresult="onPair"
></script>
```

The suffix is public, not an authorization secret. Pair snapshots its
server-owned meaning onto the session, sends the resolved requirement to the
phone through the single-use QR token, and binds the exact scoped CPI into the
signed verdict. A sensitive merchant endpoint must verify against the exact
expected scoped CPI; a result for the base CPI is not interchangeable. Unknown
suffixes fail session creation instead of silently downgrading. The CPI field is
and challenge fields are required on `POST /api/verify`; token validity is
never returned without the merchant making both exact assertions.

The loader (`loader/loader.ts`) injects a cross-origin iframe at
`{EMBED_ORIGIN}/embed` and relays origin-checked postMessages up. The browser
message is a **notification**; the HMAC-signed `token` verified via
`POST /api/verify` is the proof. The loader carries no secrets.

For the iframe widget, QR minting does not wait for integrity collection. Once
`/session/start` returns, the isolated iframe scan runs concurrently with WS
setup and QR minting. The phone does not receive `desktop-ready`, and no verdict
can pass, until that scan is verified and stored by `desktop-attest`. The
merchant-realm preflight protocol remains available server-side for future
work, but the shipped loader does not launch a second browser scan.

## How a pairing works

```
desktop /embed                      Lambda API + WS relay                    phone
──────────────                      ─────────────────────                    ─────
POST /api/session/start ──────────► session in Valkey (TTL'd)
WS whoami (bootstrap token) ──────► sealed AES-GCM envelope back
POST …/{id}/pair-token ───────────► 128-bit single-use token, TTL 300s
                                    render + seal poisoned PNG frame bundle
display sealed QR animation ◄───── worker decrypts display bytes
isolated desktop scan ────────────► desktop-attest (single atomic desktop slot)
scan QR  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ camera ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►  scan
                                    POST /api/pair-token/redeem (GETDEL) ◄── redeem
                                    → /pair/{id}#{wsUrl,e,pt,n,pr} (hash never hits the server)
◄──────────── WS relay: phone-here / desktop-ready (sealed envelopes) ─────► WS whoami
desktop-ready after scan ─────────►                                           argus.run(phone)
                                                                             + proof-of-life
                                    verdict computed on ◄─────────────────── phone-attest
◄── fixed-size encrypted verdict              neutral decision-complete ──►
                                    phone-done ◄──────────────────────────── DONE
◄── reveal key over WS (or gated /result fallback)
```

Key mechanics:

- **Short-token QR.** The QR encodes only `/p/<128-bit token>` so it stays
  sparse (~33×33). The token is single-use (atomic Valkey `GETDEL`) with a
  5-minute TTL; redeeming returns the real session bundle, which travels to
  `/pair/{id}` in the URL **hash** so it never reaches a server log.
- **Server-rendered poisoned QR animation.** `cdk/lib/pair-api/server-qr-png.ts`
  renders PNG frames for `/p/<token>` and inverts a small square at each data
  module's center: a camera lens averages it away, a pixel-exact screenshot
  decoder fails ECC. The frames are packed into a binary bundle, gzip-compressed
  when the browser advertises native `DecompressionStream` support, and ECDH/AES
  sealed to the QR worker. The page receives display bytes instead of a
  structured URL/token. This is still a speed-bump against image extraction —
  the single-use token and server verdict are the lock. See the
  [QR poisoning research](docs/qr-poisoning-research.md) for the measured
  attack ladder and limits.
- **WS relay, not WebRTC.** Both sides authenticate to the WebSocket API with
  HMAC bootstrap tokens (5-min TTL) and receive sealed AES-GCM envelopes; the
  relay verifies envelope auth-tags, one live connection per {session, role},
  and only relays between distinct roles of the same session. There is no
  peer-to-peer channel and no STUN.
- **Attestation + verdict.** Each side runs the Argus integrity SDK
  (`argus.run`, purpose `argus-pair-v1`); the server fetches scan projections
  from the merchant API and scores them (individual ≤ 30, total ≤ 50, PAT
  floor 70). The HTTP adapter validates the single current merchant projection
  shape before policy reads it; malformed, unsupported, missing, or stale
  projections fail **closed**. Proof-of-life is required: silent device-trust
  redeem (12h IndexedDB token) → WebAuthn → Google OAuth.
- **Desktop trusts only the server.** The verdict must arrive `from:'server'`
  (WS push or authenticated `/result` poll) — a phone-side forgery via the
  relay is ignored.
- **Deferred verdict disclosure.** The verdict is calculated behind the drawing
  challenge, but pass and fail travel as the same fixed-size AES-GCM envelope.
  `/phone-attest` returns only neutral completion. The authenticated phone role
  writes `phone-done`; only then does the WS relay send the session-specific
  reveal key. `/result` and verdict-token minting enforce the same gate for
  reconnects and hostile embed code. A 90-second cap preserves the existing
  abandoned-phone recovery behavior.
- **Batched phone diagnostics.** Phone lifecycle timings stay in memory and are
  sent as one bounded, best-effort `/api/phone-perf` batch on completion,
  terminal bootstrap failure, or page exit. A same-origin `sessionStorage`
  handoff carries the initial short-token timings across the `/p/*` to
  `/pair/*` redirect. Do not turn individual lifecycle events back into API
  calls; one pairing should produce at most one diagnostics request.

## Mobile SSO continuity

A merchant-bound flow (`/sso/mobile` → `/sso/challenge/:id` →
`/merchant/validate`) proves the _same phone, device, and network_ across a
round-trip:
three Argus scans + 90s single-use return codes, evaluated by
`cdk/lib/sso-continuity.ts` (same device keyId, same/nearby network, bounded
risk drift). The loader passes a merchant-issued challenge and configured HTTPS
callback into the hosted flow. Approval returns a short-lived opaque code; the
merchant backend exchanges it once at `POST /api/sso/approval/exchange` using
the exact scoped CPI and challenge before creating its own session. Only the
code hash is stored. Callback origins come from `SSO_CALLBACK_ORIGINS` and are
validated before the SSO session is created.

`.fastpass` uses continuity and integrity only, `.stepup` accepts cached device
trust or fresh proof, and `.forceauth` requires a fresh passkey/OAuth ceremony.
The separate `/merchant` route remains the presentation demo and uses the
HttpOnly approval-cookie redemption endpoint.

Client SSO legs have explicit deadlines: 15 seconds for the Argus bootstrap and
20 seconds for Pair HTTP requests. Failures are shown as generic retryable
messages; response bodies remain available only to application code for
structured handling. Each SSO leg also emits a bounded, best-effort event to
`POST /api/sso/telemetry`. Search the Pair API log group for
`[pair] sso_client` and correlate on `session=` when a flow stalls. The HTTP API
access log records request id, route, status, integration status/error, and
response length without request bodies or credentials.

An otherwise-clean scan whose only risk is the 35-point isolated-location
mismatch is allowed through the per-side limit. The combined score must still
remain below 50, so two such mismatches fail closed; any automation/network
score or unrecognized reason tag also keeps the original 30-point limit.

## Repo layout

```
ms-argus-pair/
├── loader/loader.ts            # embeddable captcha.js (own build + CDN stack)
├── src/
│   ├── main.tsx                # SPA entry: /embed, /merchant, /sso/*, /merchant/validate
│   ├── phone-main.tsx          # phone orchestration entry (phone.html): /pair/*, /p/*
│   ├── lib/phone-drawing-board.ts # sole phone challenge UI: letter drawing
│   ├── lib/phone-view.ts       # pure proof-menu and status presentation
│   ├── lib/pair.ts             # session orchestration (desktop + phone)
│   ├── lib/ws.ts               # WS client (whoami / message)
│   ├── lib/qr-keyholder.ts     # worker ECDH + sealed QR image open
│   ├── lib/device-trust.ts     # silent re-auth token (IndexedDB)
│   └── pages/                  # Embed, MerchantSso, SsoChallenge, MerchantValidate
├── cdk/
│   ├── bin/app.ts, pair-config.mjs   # stacks + single-source domain config
│   ├── lib/pair-stack.ts             # S3+CloudFront+HTTP API+WS API+DDB+secrets
│   ├── lib/pair-api.ts               # API Lambda composition root and HTTP router
│   ├── lib/pair-api/                 # tested application slices, stores, tokens, attestation
│   │   ├── phone-attestation-request.ts # signed request + desktop binding boundary
│   │   ├── phone-attestation-route.ts   # proof/projection/verdict orchestration
│   │   └── phone-attestation-commit.ts  # Valkey/DDB single-writer policy
│   ├── lib/ws-handler.ts             # WS Lambda (whoami / message relay)
│   ├── lib/session-store.ts, valkey-client.ts, sso-continuity.ts, oauth-providers.ts
│   ├── lib/captcha-cdn/              # loader CDN stack (S3+CloudFront)
│   └── cloudfront/spa-router.js      # CFF: /pair/*,/p/* → phone.html; SPA fallback
└── scripts/                    # build-loader, SRI apply/assert, *.test.* hygiene suite
```

Routing: `index.html` serves the React SPA; `phone.html` is a separate
lightweight entry so the phone paints instantly. A CloudFront Function maps
`/pair/*` and `/p/*` to `phone.html`; `/api/*` goes to the HTTP API; `/embed`
gets its own behavior without `X-Frame-Options: DENY` so customers can iframe
it (everything else keeps DENY). There is deliberately no React phone fallback:
`src/phone-main.tsx` and its letter-drawing board are the single phone UI.

Stores: **Valkey** (ElastiCache Serverless, shared via `ms-argus-infra` SSM)
holds sessions, pair-tokens, and rate limits; **DynamoDB** holds WS connection
slots and SSO sessions (and is the session fallback).
Secrets Manager holds the device-trust, verdict-signing, and WS-envelope keys.
The verdict reveal key is derived per session from the WS root secret and is
never stored; DynamoDB records only challenge/Done state for reconnect-safe
release.

## Local development

```
npm install
npm run dev          # vite on :5173 (SPA only)
```

A real pairing needs HTTPS, the WS API, Valkey, and the merchant API — in
practice, deploy to dev-jw and test there. `scripts/test-oauth/` has a
localhost rig for iterating on OAuth verification in isolation.

## Build, tests, deploy

```
npm run deploy       # the only supported path — see below
```

The deploy script (bash — `source .env` matters) computes the canonical host +
WS URL, bakes `VITE_PAIR_URL_BASE` / `VITE_PAIR_WS_URL` into the SPA build and
`EMBED_ORIGIN` into the loader, runs the hygiene suite, asserts the host
actually landed in the bundle (`cdk/bin/assert-baked-host.mjs`), then
`cdk deploy --all` with merchant + OAuth context flags. **Read `CLAUDE.md`
before adding a context flag or touching the deploy chain** — the QR url-base
baking has bitten twice.

`npm run test:hygiene` chains the guard scripts: SRI correctness on every
built asset, loader SRI, no dev proof-skip leaked into prod bundles, SPA-router
and phone-entry invariants, QR poison geometry, pair-token semantics, WS
single-connection, SSO routes/continuity. `test:cdk-hardening` asserts the
synthesized CloudFront template (frame-deny, HSTS, no error-response SPA
fallback, exactly one CFF) and the bounded HTTP API access-log configuration.

`npm run test:e2e` drives the deployed `dev-jw` Pair and merchant APIs. The
merchant projection contract test creates isolated short-lived records, proves
the live 401/200/404/402 sequence through API Gateway and Lambda, and removes
its fixtures after the run. Required role permissions are documented in
`tests/e2e/README.md`.

Stacks (stage `dev-jw`; no prod stage configured yet):

- `ms-argus-pair-dev-jw` → `captcha-dev-jw.argus.pw` (alias `qr.arcades.click`)
- `ms-argus-pair-captcha-dev-jw` → `static-captcha-dev-jw.argus.pw` (loader CDN)

## LLM cleanup loop

For repeated LLM-assisted cleanup/hardening passes, use `LLM_DEV_LOOP.md`,
`ATTACK_TESTING.md`, and the helper:

```sh
npm run llm:loop -- start
npm run llm:loop -- baseline
npm run llm:loop -- branch cleanup/<target>
npm run llm:loop -- verify
npm run llm:loop -- deploy
npm run llm:loop -- red-team
```

The loop branches from current `main`, does one scoped change at a time, deploys
runtime changes to `dev-jw`, red-teams the changed boundary, then merges clean
passes through pull requests.

## Known gaps

- `originAllowlist` is stored per-CPI but not yet enforced (domain-locking).
- The poisoned 33×33 QR has not been verified with a real phone scan
  end-to-end since the short-token change.
