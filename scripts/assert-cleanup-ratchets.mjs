import { readFileSync } from 'node:fs';

const ratchets = [
  {
    file: 'cdk/lib/pair-stack.ts',
    maxLines: 532,
    why: 'keep the stack as infrastructure composition while tested resource factories own service policy',
  },
  {
    file: 'cdk/lib/pair-http-api.ts',
    maxLines: 87,
    why: 'keep the HTTP route inventory, CORS, throttling, and access logs in one synth-tested boundary',
  },
  {
    file: 'cdk/lib/ws-handler.ts',
    maxLines: 326,
    why: 'keep the WebSocket Lambda focused on AWS, secret, crypto, and transport composition',
  },
  {
    file: 'cdk/lib/ws-handler/router.ts',
    maxLines: 240,
    why: 'keep WebSocket identity, relay, replay, and verdict-release policy directly testable',
  },
  {
    file: 'cdk/lib/ws-handler/publisher.ts',
    maxLines: 56,
    why: 'keep API Gateway publication and stale-connection handling in a tested transport adapter',
  },
  {
    file: 'cdk/lib/pair-api.ts',
    maxLines: 515,
    why: 'keep the pair API route from absorbing extracted feature-slice helpers',
  },
  {
    file: 'cdk/lib/pair-api/pair-session-repository.ts',
    maxLines: 121,
    why: 'keep DDB and Valkey session normalization behind one tested storage boundary',
  },
  {
    file: 'cdk/lib/session-store.ts',
    maxLines: 211,
    why: 'keep Valkey key and transport mechanics independent from Pair session policy',
  },
  {
    file: 'cdk/lib/pair-api/router.ts',
    maxLines: 149,
    why: 'keep HTTP validation and dispatch independent from runtime infrastructure adapters',
  },
  {
    file: 'cdk/lib/pair-api/phone-attestation-commit.ts',
    maxLines: 84,
    why: 'keep single-writer phone persistence independent from proof and verdict policy',
  },
  {
    file: 'cdk/lib/pair-api/phone-attestation-request.ts',
    maxLines: 157,
    why: 'keep authenticated phone request binding separate from proof and persistence work',
  },
  {
    file: 'cdk/lib/pair-api/phone-attestation-route.ts',
    maxLines: 236,
    why: 'keep phone verdict orchestration below the new-file size limit',
  },
  {
    file: 'cdk/lib/pair-api/phone-verdict-decision.ts',
    maxLines: 84,
    why: 'keep phone verdict policy independent from proof transport, persistence, and disclosure',
  },
  {
    file: 'cdk/lib/pair-api/desktop-attestation-route.ts',
    maxLines: 75,
    why: 'keep desktop scan orchestration independent from route multiplexing and persistence',
  },
  {
    file: 'cdk/lib/pair-api/pair-token-mint-route.ts',
    maxLines: 88,
    why: 'keep sparse QR token authorization and sealing independent from route multiplexing',
  },
  {
    file: 'cdk/lib/pair-api/session-result-route.ts',
    maxLines: 57,
    why: 'keep authenticated verdict polling separate from route multiplexing and persistence',
  },
  {
    file: 'cdk/lib/pair-api/session-start.ts',
    maxLines: 116,
    why: 'keep the session-start application flow independent from AWS and route multiplexing',
  },
  {
    file: 'cdk/lib/pair-api/session-start-store.ts',
    maxLines: 92,
    why: 'keep session-start persistence separate from request policy and response shaping',
  },
  {
    file: 'cdk/lib/pair-api/merchant-projection.ts',
    maxLines: 39,
    why: 'keep the current merchant projection model explicit and transport-free',
  },
  {
    file: 'cdk/lib/pair-api/projection-contract.ts',
    maxLines: 91,
    why: 'keep API wire validation separate from projection policy and transport',
  },
  {
    file: 'cdk/lib/pair-api/projection-client.ts',
    maxLines: 125,
    why: 'keep the merchant HTTP adapter narrow and dependency-injectable',
  },
  {
    file: 'cdk/lib/pair-api/projection-verdict.ts',
    maxLines: 334,
    why: 'keep projection policy from absorbing transport and wire validation',
  },
  {
    file: 'cdk/lib/oauth-providers.ts',
    maxLines: 161,
    why: 'keep retired OAuth provider scaffolding out of the server trust boundary',
  },
  {
    file: 'src/lib/oauth.ts',
    maxLines: 172,
    why: 'keep retired OAuth provider scaffolding out of the browser bundle',
  },
  {
    file: 'src/lib/pair.ts',
    maxLines: 293,
    why: 'keep Pair focused on desktop and phone composition instead of absorbing SSO or SDK concerns',
  },
  {
    file: 'src/lib/argus-client.ts',
    maxLines: 95,
    why: 'keep signed SDK bootstrap and attested scan policy in one small browser adapter',
  },
  {
    file: 'src/lib/sso-client.ts',
    maxLines: 269,
    why: 'keep mobile SSO proof selection and transport orchestration independently testable',
  },
  {
    file: 'src/lib/merchant-validation-flow.ts',
    maxLines: 207,
    why: 'keep merchant assurance transitions and callback binding independent from React',
  },
  {
    file: 'src/pages/MerchantValidate.tsx',
    maxLines: 124,
    why: 'keep merchant validation lifecycle orchestration below the component size target',
  },
  {
    file: 'src/pages/MerchantValidationView.tsx',
    maxLines: 192,
    why: 'keep SSO return presentation separate from validation policy and browser effects',
  },
  {
    file: 'src/lib/passkey-client.ts',
    maxLines: 185,
    why: 'keep host-bound WebAuthn and optional browser hints independent from Pair and SSO orchestration',
  },
  {
    file: 'src/lib/phone-session-runtime.ts',
    maxLines: 202,
    why: 'keep the QR-bound phone handshake independent from proof and attestation submission',
  },
  {
    file: 'src/lib/phone-attestation.ts',
    maxLines: 245,
    why: 'keep trusted and fresh phone proof transitions directly testable and below the new-file limit',
  },
  {
    file: 'src/lib/desktop-session-runtime.ts',
    maxLines: 207,
    why: 'keep authenticated peer routing, polling fallback, and expiry independent from evidence collection',
  },
  {
    file: 'src/lib/desktop-session-bootstrap.ts',
    maxLines: 88,
    why: 'keep desktop session transport bootstrap isolated from evidence and verdict orchestration',
  },
  {
    file: 'src/lib/desktop-evidence.ts',
    maxLines: 170,
    why: 'keep desktop integrity, host evidence, and attestation submission directly testable',
  },
  {
    file: 'src/lib/desktop-qr.ts',
    maxLines: 110,
    why: 'keep canonical-origin policy and sealed QR minting isolated from session composition',
  },
  {
    file: 'src/phone-main.tsx',
    maxLines: 508,
    why: 'keep the single phone entry focused on browser lifecycle and rendering',
  },
  {
    file: 'src/lib/phone-proof-flow.ts',
    maxLines: 198,
    why: 'keep phone proof selection, submission, and result policy directly testable and below the new-file limit',
  },
  {
    file: 'src/lib/phone-drawing-board.ts',
    maxLines: 222,
    why: 'keep the sole phone challenge isolated from pairing orchestration and alternate UI modes',
  },
  {
    file: 'src/lib/phone-view.ts',
    maxLines: 141,
    why: 'keep phone status presentation pure and directly testable',
  },
  {
    file: 'src/lib/phone-pair-failure.ts',
    maxLines: 42,
    why: 'keep phone proof failure policy pure and independent from DOM orchestration',
  },
  {
    file: 'src/lib/phone-pair.ts',
    maxLines: 14,
    why: 'keep the lazy phone-to-pair boundary explicit and minimal',
  },
  {
    file: 'src/main.tsx',
    maxLines: 35,
    why: 'keep phone pairing out of the React SPA router',
  },
  {
    file: 'src/lib/desktop-result-poll.ts',
    maxLines: 116,
    why: 'keep the authenticated verdict fallback independent from desktop orchestration',
  },
  {
    file: 'src/lib/desktop-verdict-gate.ts',
    maxLines: 153,
    why: 'keep verdict reveal timing independent from transport and page orchestration',
  },
  {
    file: 'cdk/lib/pair-api/sso-start.ts',
    maxLines: 77,
    why: 'keep SSO start policy independent from AWS and API Gateway response shaping',
  },
  {
    file: 'cdk/lib/pair-api/sso-challenge.ts',
    maxLines: 84,
    why: 'keep SSO challenge policy independent from AWS and API Gateway response shaping',
  },
  {
    file: 'cdk/lib/pair-api/sso-challenge-store.ts',
    maxLines: 22,
    why: 'keep SSO challenge persistence as a narrow DynamoDB adapter',
  },
  {
    file: 'cdk/lib/pair-api/sso-validation.ts',
    maxLines: 168,
    why: 'keep SSO validation orchestration independent from AWS and API Gateway responses',
  },
  {
    file: 'cdk/lib/pair-api/sso-validation-proof.ts',
    maxLines: 102,
    why: 'keep SSO proof policy isolated from continuity and persistence',
  },
  {
    file: 'cdk/lib/pair-api/sso-validation-store.ts',
    maxLines: 36,
    why: 'keep SSO validation persistence as a narrow DynamoDB adapter',
  },
  {
    file: 'cdk/lib/pair-api/sso-session.ts',
    maxLines: 25,
    why: 'keep shared SSO session state explicit and free of route implementation',
  },
  {
    file: 'cdk/lib/pair-api/sso-approval-route.ts',
    maxLines: 100,
    why: 'keep one-time SSO redemption as a narrow, reviewable trust boundary',
  },
  {
    file: 'loader/loader.ts',
    maxLines: 148,
    why: 'keep customer-loader orchestration from absorbing message validation policy',
  },
  {
    file: 'loader/message-contract.ts',
    maxLines: 62,
    why: 'keep the cross-window message trust boundary small and directly testable',
  },
  {
    file: 'src/pages/Embed.tsx',
    maxLines: 96,
    why: 'keep the embed route focused on iframe effects and React state wiring',
  },
  {
    file: 'src/pages/EmbedView.tsx',
    maxLines: 82,
    why: 'keep captcha markup independent from iframe effects and session resources',
  },
  {
    file: 'src/lib/embed-config.ts',
    maxLines: 43,
    why: 'keep URL and parent-message validation pure and directly testable',
  },
  {
    file: 'src/lib/embed-session.ts',
    maxLines: 178,
    why: 'keep QR resources and embed completion independent from React and iframe sizing',
  },
  {
    file: 'src/lib/embed-presentation.ts',
    maxLines: 64,
    why: 'keep captcha presentation policy pure, compact, and directly testable',
  },
  {
    file: 'src/components/EmbedIcons.tsx',
    maxLines: 48,
    why: 'keep embed-only SVG presentation separate from session orchestration',
  },
];

function lineCount(file) {
  const body = readFileSync(file, 'utf8');
  return (body.match(/\n/g) ?? []).length + (body.endsWith('\n') ? 0 : 1);
}

let failed = false;
for (const ratchet of ratchets) {
  const lines = lineCount(ratchet.file);
  if (lines > ratchet.maxLines) {
    console.error(
      `[cleanup-ratchets] ${ratchet.file} has ${lines} lines; max is ${ratchet.maxLines} (${ratchet.why})`
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('[cleanup-ratchets] ok');
