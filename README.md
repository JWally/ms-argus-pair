# ms-argus-pair

The **Argus Captcha** — QR device-pairing as proof of humanity. A desktop page
shows a QR; a real phone scans it; both sides run an Argus integrity scan; the
phone adds proof-of-life (silent device-trust token, WebAuthn passkey, or
Google sign-in); the server scores it all and hands back a **signed verdict
token** the embedding site verifies server-to-server.

One self-contained microservice: the pairing app + backend (deployed at
`captcha-dev-jw.argus.pw`) plus the embeddable loader and its CDN
(`static-captcha-dev-jw.argus.pw`). Marketing pages live in `ms-argus-www`;
fraud scoring lives in `ms-argus-api` (consumed here as the "merchant API").

## Embed (what a customer writes)

```html
<script
  src="https://static-captcha-dev-jw.argus.pw/captcha.js"
  data-cpi="argus_cpi_live_..."
  data-onresult="onPair"
></script>
<div class="argus-captcha"></div>
<script>
  function onPair(r) {
    // r = { sessionId, verdict, reason, token }
    // POST r.token to YOUR server → it calls POST {pairOrigin}/api/verify
    // → trusted { valid, passed, verdict, sessionId, cpi }.
    // Gate on `passed` (true only when verdict === "paired"), NOT `valid`
    // — `valid` just means the signature is authentic; a real token can
    // carry a "failed" verdict. Never trust the browser's r.verdict alone.
  }
</script>
```

Or programmatically: `window.argusCaptcha.render(el, { cpi, onResult, onEvent })`.

The loader (`loader/loader.ts`) injects a cross-origin iframe at
`{EMBED_ORIGIN}/embed` and relays origin-checked postMessages up. The browser
message is a **notification**; the HMAC-signed `token` verified via
`POST /api/verify` is the proof. The loader carries no secrets.

## How a pairing works

```
desktop /embed                      Lambda API + WS relay                    phone
──────────────                      ─────────────────────                    ─────
POST /api/session/start ──────────► session in Valkey (TTL'd)
WS whoami (bootstrap token) ──────► sealed AES-GCM envelope back
POST …/{id}/pair-token ───────────► 128-bit single-use token, TTL 300s
                                    render + seal poisoned PNG frame bundle
display sealed QR animation ◄───── worker decrypts display bytes
scan QR  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ camera ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►  scan
                                    POST /api/pair-token/redeem (GETDEL) ◄── redeem
                                    → /pair/{id}#{wsUrl,e,pt,n}  (hash never hits the server)
◄──────────── WS relay: phone-here / desktop-ready (sealed envelopes) ─────► WS whoami
argus.run(desktop) ───────────────► desktop-attest                           argus.run(phone)
                                                                             + proof-of-life
                                    verdict computed on ◄─────────────────── phone-attest
◄── verdict pushed over WS (or /result poll fallback)
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
  the single-use token and server verdict are the lock.
- **WS relay, not WebRTC.** Both sides authenticate to the WebSocket API with
  HMAC bootstrap tokens (5-min TTL) and receive sealed AES-GCM envelopes; the
  relay verifies envelope auth-tags, one live connection per {session, role},
  and only relays between distinct roles of the same session. There is no
  peer-to-peer channel and no STUN.
- **Attestation + verdict.** Each side runs the Argus integrity SDK
  (`argus.run`, purpose `argus-pair-v1`); the server fetches scan projections
  from the merchant API and scores them (individual ≤ 30, total ≤ 50, PAT
  floor 70). Missing or stale projections fail **closed**. Proof-of-life is
  required: silent device-trust redeem (12h IndexedDB token) → WebAuthn →
  Google OAuth.
- **Desktop trusts only the server.** The verdict must arrive `from:'server'`
  (WS push or authenticated `/result` poll) — a phone-side forgery via the
  relay is ignored.

## SSO continuity (demo)

A second flow (`/merchant` → `/sso/challenge/:id` → `/merchant/validate`)
proving the _same phone, device, and network_ across a merchant round-trip:
three Argus scans + 90s single-use return codes, evaluated by
`cdk/lib/sso-continuity.ts` (same device keyId, same/nearby network, bounded
risk drift). Approval sets a cookie and can mint a device-trust token.
`POST /api/sso/{id}/claim` records a display-name claim.

## Repo layout

```
ms-argus-pair/
├── loader/loader.ts            # embeddable captcha.js (own build + CDN stack)
├── src/
│   ├── main.tsx                # SPA entry: /embed, /merchant, /sso/*, /merchant/validate
│   ├── phone-main.tsx          # phone entry (vanilla DOM, phone.html): /pair/*, /p/*
│   ├── lib/pair.ts             # session orchestration (desktop + phone)
│   ├── lib/ws.ts               # WS client (whoami / message)
│   ├── lib/qr-keyholder.ts     # worker ECDH + sealed QR image open
│   ├── lib/device-trust.ts     # silent re-auth token (IndexedDB)
│   └── pages/                  # Embed, Pair, MerchantSso, SsoChallenge, MerchantValidate
├── cdk/
│   ├── bin/app.ts, pair-config.mjs   # stacks + single-source domain config
│   ├── lib/pair-stack.ts             # S3+CloudFront+HTTP API+WS API+DDB+secrets
│   ├── lib/pair-api.ts               # the API Lambda (all HTTP routes)
│   ├── lib/pair-api/                 # pair-token, QR PNG, verdict-token, attestation
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
it (everything else keeps DENY).

Stores: **Valkey** (ElastiCache Serverless, shared via `ms-argus-infra` SSM)
holds sessions, pair-tokens, and rate limits; **DynamoDB** holds WS connection
slots, SSO sessions, and the claim counter (and is the session fallback).
Secrets Manager holds the device-trust, verdict-signing, and WS-envelope keys.

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
fallback, exactly one CFF).

Stacks (stage `dev-jw`; no prod stage configured yet):

- `ms-argus-pair-dev-jw` → `captcha-dev-jw.argus.pw` (alias `qr.arcades.click`)
- `ms-argus-pair-captcha-dev-jw` → `static-captcha-dev-jw.argus.pw` (loader CDN)

## LLM cleanup loop

For repeated LLM-assisted cleanup/hardening passes, use `LLM_DEV_LOOP.md` and
the helper:

```sh
npm run llm:loop -- start
npm run llm:loop -- baseline
npm run llm:loop -- branch cleanup/<target>
npm run llm:loop -- verify
npm run llm:loop -- deploy
npm run llm:loop -- red-team
```

The loop keeps a durable `dev-loop` branch, does one scoped branch at a time,
deploys runtime changes to `dev-jw`, red-teams the changed boundary, then merges
clean passes back into `dev-loop`.

## Known gaps

- OAuth: only Google is wired end-to-end on the client; GitHub/Facebook have
  server-side verifiers but stub clients (`src/lib/oauth.ts`).
- `originAllowlist` is stored per-CPI but not yet enforced (domain-locking).
- The poisoned 33×33 QR has not been verified with a real phone scan
  end-to-end since the short-token change.
- `GET /api/_valkey-debug` is a temporary unauthenticated connectivity probe.
