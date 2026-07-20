# Pair deployed-infrastructure tests

`npm run test:e2e` drives the deployed Pair stack. It is intentionally separate from the unit
suite and is not a substitute for pure state-machine tests. Live cases retry twice at the
individual-test boundary to absorb transient API/AWS reads without rerunning the whole suite.

## Coverage

- `stolen-token.e2e.ts` exercises the public QR/token/phone-attestation boundary over HTTP.
- `sso-infra.e2e.ts` exercises API Gateway, the Pair Lambda, and the real Pair DynamoDB table. It
  seeds short-lived SSO fixtures directly in DynamoDB, calls only deployed HTTP routes, verifies
  atomic approval consumption, and removes every fixture after each test.

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
- `AWS_REGION` defaults to `us-east-1`.
- `PAIR_E2E_ALLOW_NON_DEV=1` is required before fixture writes to a target whose stack or table name
  does not contain `dev-jw`.

## GitHub Actions

`.github/workflows/live-e2e.yml` runs nightly and on manual dispatch. It intentionally fails with a
clear setup error until the repository Actions variable `AWS_ROLE_ARN` names a GitHub OIDC role.
The role needs `dynamodb:ListTables` when `PAIR_TABLE_NAME` is unset, plus
`dynamodb:GetItem`, `dynamodb:PutItem`, and `dynamodb:DeleteItem` on the dev-jw PairSessions table.

Set the optional repository variable `PAIR_TABLE_NAME` to the exact dev-jw table name to remove the
`ListTables` permission from the role. The public HTTP portion of the suite needs no AWS permission.
