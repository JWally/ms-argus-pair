#!/usr/bin/env node
// Prints the deployed WS API URL so the deploy script can bake it into
// the Vite build via VITE_PAIR_WS_URL. The eager-WS path in
// startDesktopSession() opens the WebSocket in parallel with the
// /session/start HTTP request, saving the ~50–450ms WS handshake from
// the critical path. When this script returns empty (first deploy ever,
// or CFN lookup fails), the client falls back to the serial path.
//
// We shell out to the AWS CLI instead of using the SDK so we don't pull
// a per-deploy dependency that's only used here. Suppresses errors —
// empty stdout is the "use fallback" signal the deploy script reads.
import { execSync } from "node:child_process";

const STACK = "ms-argus-pair-dev-jw";
try {
  const out = execSync(
    `aws cloudformation describe-stacks --stack-name ${STACK} --query "Stacks[0].Outputs[?OutputKey=='WsApiUrl'].OutputValue" --output text`,
    { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" }
  ).trim();
  if (out && !out.includes("None")) process.stdout.write(out);
} catch {
  /* first deploy or AWS CLI not configured — print nothing, fallback path runs */
}
