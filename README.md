# ms-argus-pair

Phone-pair captcha demo. Desktop displays a QR; phone scans it; the two browsers
form a WebRTC DataChannel over a same-origin HTTP-polling signaling broker. Once
the channel opens, the phone sends a greeting and the desktop is "paired".

This is the v0.1 skeleton — pairing UX only. No PAT, no WebAuthn, no
persistent identity yet (those are v0.2/v0.3).

## Architecture

```
Desktop (/)                Signaling (Lambda + DDB)              Phone (/pair/<uuid>)
    │                              ▲                                    │
    │  POST /api/rooms             │                                    │
    │  GET  /api/rooms/:id/peers   │  same-origin via CloudFront        │
    │  PUT  /api/rooms/:id/signal  │  /api/* → APIGW                    │
    │  GET  /api/rooms/:id/signal  │                                    │
    │  POST /api/rooms/:id/end     │                                    │
    │                              │                                    │
    └──── direct WebRTC DataChannel (host/srflx via STUN) ───────────────┘
```

Signaling state lives in a single DynamoDB table with TTL=60s. Rooms accept at
most two peers; the desktop is peerId=1, the phone is peerId=2.

## Hardening over upstream web-quaker

- Room id is a UUIDv4 (122-bit entropy), not a 4-char code
- TTL = 60s (was 1 hour)
- Hard peer cap of 2, enforced atomically by a DDB conditional update
- ICE candidate count capped at 30 per peer
- Body size capped at 16KB before parsing
- Origin header allowlist (in addition to APIGW CORS)
- `/end` endpoint destroys the room after the channel opens
- No `/start` endpoint (Quake-specific)
- APIGW default-route throttling (50 burst / 20 rate)

## Local development

```
npm install
npm run dev:signaling   # local in-memory broker on :9090
npm run dev             # vite on :5173 (also exposed on LAN)
```

Open http://localhost:5173 on the desktop. To pair a real phone you need HTTPS
(WebRTC requires it on non-localhost origins) — easiest is to just `npm run
deploy` and use the dev-jw URL.

## Deploy

```
AWS_PROFILE=… AWS_REGION=us-east-1 npm run deploy
```

Stack: `ms-argus-pair-dev-jw`. Deployed at `https://captcha-dev-jw.argus.pw`.

## File layout

```
ms-argus-pair/
├── cdk/
│   ├── bin/app.ts              # CDK app entry
│   └── lib/
│       ├── pair-stack.ts       # S3+CF+APIGW+Lambda+DDB
│       └── signaling.ts        # Lambda handler
├── scripts/
│   └── dev-signaling.mjs       # local in-memory broker
├── src/
│   ├── lib/pairing.ts          # WebRTC client (createRoom / joinRoom)
│   ├── pages/
│   │   ├── Demo.tsx            # desktop: shows QR
│   │   └── Pair.tsx            # phone: joins room
│   ├── main.tsx
│   └── index.css
├── public/favicon.svg
├── index.html
├── vite.config.ts
├── tailwind.config.cjs
├── tsconfig*.json
└── eslint.config.mjs
```

## Roadmap

- v0.1 — pairing UX (this).
- v0.2 — server-issued token, redemption path proven via DataChannel.
- v0.3 — persistent ECDSA identity in IndexedDB; sign room creation and
  redemption with it.
- v0.4 — same-network co-location check from srflx ICE candidates.
- v0.5 — Apple PAT integration; gate so PAT-presenting Safari users skip the
  pairing step entirely.
