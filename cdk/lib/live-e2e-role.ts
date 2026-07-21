import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

const E2E_STAGE = 'dev-jw';

export interface LiveE2eRoleProps {
  stage: string;
  /** GitHub owner/repository allowed to assume the role. */
  repo: string;
  pairTable: dynamodb.ITable;
}

/**
 * GitHub OIDC role for deployed Pair contract tests.
 *
 * The projection fixture can mint a dev credential, so this construct is
 * deliberately locked to dev-jw rather than accepting arbitrary stages.
 */
export class LiveE2eRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: LiveE2eRoleProps) {
    super(scope, id);

    if (props.stage !== E2E_STAGE) {
      throw new Error(`LiveE2eRole may only target ${E2E_STAGE}; received ${props.stage}`);
    }

    const stack = cdk.Stack.of(this);
    const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidc',
      `arn:${stack.partition}:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`
    );

    this.role = new iam.Role(this, 'Role', {
      roleName: `${stack.stackName}-live-e2e`,
      description: 'GitHub Actions role for ms-argus-pair deployed dev-jw contract tests',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${props.repo}:*`,
        },
      }),
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
        ],
        resources: [props.pairTable.tableArn],
      })
    );

    const parameterPaths = {
      merchantsTable: `/argus/${E2E_STAGE}/data/merchants-table-name`,
      integrityTable: `/argus/${E2E_STAGE}/data/integrity-results-table-name`,
      signingKeyArn: `/argus-platform/${E2E_STAGE}/api-signing-key-arn`,
      apiKeyId: `/argus-api/${E2E_STAGE}/merchant-projection-e2e-api-key-id`,
    } as const;
    const merchantsTableName = ssm.StringParameter.valueForStringParameter(
      this,
      parameterPaths.merchantsTable
    );
    const integrityTableName = ssm.StringParameter.valueForStringParameter(
      this,
      parameterPaths.integrityTable
    );
    const signingKeyArn = ssm.StringParameter.valueForStringParameter(
      this,
      parameterPaths.signingKeyArn
    );
    const apiKeyId = ssm.StringParameter.valueForStringParameter(this, parameterPaths.apiKeyId);

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
        ],
        resources: [merchantsTableName, integrityTableName].map((tableName) =>
          stack.formatArn({
            service: 'dynamodb',
            resource: 'table',
            resourceName: tableName,
          })
        ),
      })
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters'],
        resources: Object.values(parameterPaths).map((parameterPath) =>
          stack.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: parameterPath.replace(/^\//, ''),
          })
        ),
      })
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['apigateway:GET'],
        // API Gateway control-plane ARNs uniquely retain a slash after the
        // empty account segment: `...:region::/apikeys/{id}`.
        resources: [`arn:${stack.partition}:apigateway:${stack.region}::/apikeys/${apiKeyId}`],
      })
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [signingKeyArn],
      })
    );

    new cdk.CfnOutput(this, 'RoleArn', {
      value: this.role.roleArn,
      description: 'Set the ms-argus-pair Actions variable AWS_ROLE_ARN to this value',
    });
    new cdk.CfnOutput(this, 'PairTableName', {
      value: props.pairTable.tableName,
      description: 'Set the ms-argus-pair Actions variable PAIR_TABLE_NAME to this value',
    });
  }
}
