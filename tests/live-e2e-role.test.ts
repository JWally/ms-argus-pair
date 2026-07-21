import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { describe, expect, it } from 'vitest';
import { LiveE2eRole } from '../cdk/lib/live-e2e-role';

function synthesizeRole(stage = 'dev-jw'): Record<string, unknown> {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'PairRoleTest', {
    env: { account: '263318538229', region: 'us-east-1' },
    stackName: `ms-argus-pair-${stage}`,
  });
  const pairTable = new dynamodb.Table(stack, 'PairSessions', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  });

  new LiveE2eRole(stack, 'LiveE2eRole', {
    stage,
    repo: 'JWally/ms-argus-pair',
    pairTable,
  });

  return Template.fromStack(stack).toJSON();
}

function resourcesOfType(template: Record<string, unknown>, type: string) {
  const resources = template.Resources as Record<string, { Type: string; Properties: unknown }>;
  return Object.values(resources).filter((resource) => resource.Type === type);
}

describe('LiveE2eRole', () => {
  it('trusts only this repository through the account GitHub OIDC provider', () => {
    const template = synthesizeRole();
    const [role] = resourcesOfType(template, 'AWS::IAM::Role');
    const serialized = JSON.stringify(role);

    expect(serialized).toContain('token.actions.githubusercontent.com:aud');
    expect(serialized).toContain('sts.amazonaws.com');
    expect(serialized).toContain('token.actions.githubusercontent.com:sub');
    expect(serialized).toContain('repo:JWally/ms-argus-pair:*');
    expect(serialized).not.toContain('repo:*');
  });

  it('grants the exact fixture operations without account-wide table discovery', () => {
    const template = synthesizeRole();
    const policies = resourcesOfType(template, 'AWS::IAM::Policy');
    const serialized = JSON.stringify(policies);

    for (const action of [
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'ssm:GetParameters',
      'apigateway:GET',
      'secretsmanager:GetSecretValue',
    ]) {
      expect(serialized).toContain(action);
    }
    expect(serialized).not.toContain('dynamodb:ListTables');
    expect(JSON.stringify(template)).toContain('/argus/dev-jw/data/merchants-table-name');
    expect(JSON.stringify(template)).toContain('/argus/dev-jw/data/integrity-results-table-name');
    expect(JSON.stringify(template)).toContain('/argus-platform/dev-jw/api-signing-key-arn');
    expect(JSON.stringify(template)).toContain(
      '/argus-api/dev-jw/merchant-projection-e2e-api-key-id'
    );
    expect(serialized).toContain('::/apikeys/');
  });

  it('refuses to create a signing-capable role outside dev-jw', () => {
    expect(() => synthesizeRole('prod')).toThrow(/dev-jw/);
  });
});
