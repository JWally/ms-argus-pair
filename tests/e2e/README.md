# Pair deployed-infrastructure tests

`npm run test:e2e` drives the deployed Pair stack. It is intentionally separate from the unit
suite and is not a substitute for pure state-machine tests. Live cases retry twice at the
individual-test boundary to absorb transient API/AWS reads without rerunning the whole suite.

## Coverage

- `stolen-token.e2e.ts` exercises the public QR/token/phone-attestation boundary over HTTP.
- `phone-handshake.e2e.ts` opens both deployed WebSocket roles and proves the relay stamps
  `phone-here` and `desktop-ready` with the current session, authenticated role, and exact sender
  envelope used by the browser trust boundary.
- `sso-infra.e2e.ts` exercises API Gateway, the Pair Lambda, and the real Pair DynamoDB table. It
  seeds short-lived SSO fixtures directly in DynamoDB, calls only deployed HTTP routes, verifies
  atomic approval consumption, and removes every fixture after each test.
- `merchant-projection.e2e.ts` crosses from Pair's HTTP adapter into the deployed merchant API. It
  creates a two-credit merchant and integrity row, signs a CPI-bound credential with the dev-jw
  platform key, and proves `401`, `200`, `404`, then real `402` credit exhaustion. The API Gateway
  identity is stable because newly associated REST API keys propagate asynchronously; all
  billable and session state is isolated and removed after the test.

The SSO infrastructure suite covers live request mapping and persistence behavior without adding
a test-only production endpoint. It does not claim to issue genuine Argus browser scans, Apple PATs,
passkeys, or Google tokens; those require browser/device coverage above this layer.

## Targeting and safety

The defaults target `https://captcha-dev-jw.argus.pw` and the single DynamoDB table matching the
`ms-argus-pair-dev-jw` stack. Fixture IDs are random UUIDs and records carry five-minute TTLs in
case cleanup is interrupted.

Optional environment variables:

- `PAIR_HOST` changes the deployed HTTP target.
- `PAIR_STACK_NAME` changes the stack used for table discovery.
- `PAIR_TABLE_NAME` avoids `ListTables` and selects an exact table.
- `MERCHANT_API_URL` defaults to `https://merchant-dev-jw.argus.pw`.
- `AWS_REGION` defaults to `us-east-1`.
- `PAIR_E2E_ALLOW_NON_DEV=1` is required before fixture writes to a target whose stack or table name
  does not contain `dev-jw`.

## GitHub Actions

`.github/workflows/live-e2e.yml` runs nightly and on manual dispatch. `PairStack` owns its
repository-scoped GitHub OIDC role in `cdk/lib/live-e2e-role.ts` and exports both values needed by
Actions. Set repository variable `AWS_ROLE_ARN` from the `LiveE2eRoleArn...` stack output and
`PAIR_TABLE_NAME` from `LiveE2ePairTableName...`. Keeping the exact table name in Actions avoids
granting the role account-wide `dynamodb:ListTables` access.

The role grants `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, and
`dynamodb:DeleteItem` on the dev-jw PairSessions table. The projection contract additionally needs:

- `ssm:GetParameters` for the four exact `/argus/.../dev-jw` table/key pointers used by the fixture;
- `apigateway:GET` for the exact dev-jw projection-test API key;
- `secretsmanager:GetSecretValue` for `argus-platform/dev-jw/api-signing-key-*`;
- `dynamodb:GetItem`, `PutItem`, `UpdateItem`, and `DeleteItem` on the dev-jw merchants and integrity
  tables.

That signing permission is intentionally powerful. Keep the GitHub role restricted to this
repository/environment and never grant it the production signing secret.

The public HTTP portion of the suite needs no AWS permission. The construct refuses to synthesize
for any stage other than `dev-jw`; do not broaden that guard or its repository trust for a
production test target.
