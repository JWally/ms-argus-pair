import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { createPairHttpApi } from '../cdk/lib/pair-http-api';

const EXPECTED_ROUTE_KEYS = [
  'ANY /api/{proxy+}',
  'GET /api/session/{id}/info',
  'GET /api/session/{id}/result',
  'GET /api/session/{id}/verdict-token',
  'POST /api/pair-token/redeem',
  'POST /api/phone-perf',
  'POST /api/session/start',
  'POST /api/session/{id}/desktop-attest',
  'POST /api/session/{id}/pair-token',
  'POST /api/session/{id}/phone-attest',
  'POST /api/sso/approval/exchange',
  'POST /api/sso/approval/redeem',
  'POST /api/sso/start',
  'POST /api/sso/telemetry',
  'POST /api/sso/{id}/challenge',
  'POST /api/sso/{id}/validate',
  'POST /api/verify',
].sort();

interface SynthResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

function synthesizePairHttpApi(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'PairHttpApiTest');
  const handler = new lambda.Function(stack, 'PairHandler', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 });'),
  });
  createPairHttpApi(stack, {
    allowOrigins: ['https://captcha.example.com', 'https://alias.example.com'],
    handler,
  });
  return Template.fromStack(stack);
}

function resourcesOfType(template: Template, type: string): SynthResource[] {
  return Object.values(template.findResources(type)) as SynthResource[];
}

describe('Pair HTTP API infrastructure', () => {
  it('synthesizes the exact public route inventory', () => {
    const template = synthesizePairHttpApi();
    const routeKeys = resourcesOfType(template, 'AWS::ApiGatewayV2::Route')
      .map((resource) => String(resource.Properties?.RouteKey))
      .sort();

    expect(routeKeys).toEqual(EXPECTED_ROUTE_KEYS);
  });

  it('limits browser preflight to the configured origins and methods', () => {
    const template = synthesizePairHttpApi();
    const [api] = resourcesOfType(template, 'AWS::ApiGatewayV2::Api');

    expect(api?.Properties?.CorsConfiguration).toEqual({
      AllowHeaders: ['content-type'],
      AllowMethods: ['GET', 'POST'],
      AllowOrigins: ['https://captcha.example.com', 'https://alias.example.com'],
    });
  });

  it('keeps throttling and structured access logs on the default stage', () => {
    const template = synthesizePairHttpApi();
    const [stage] = resourcesOfType(template, 'AWS::ApiGatewayV2::Stage');
    const accessLogs = stage?.Properties?.AccessLogSettings as Record<string, unknown> | undefined;

    expect(stage?.Properties?.DefaultRouteSettings).toEqual({
      ThrottlingBurstLimit: 50,
      ThrottlingRateLimit: 20,
    });
    expect(accessLogs?.DestinationArn).toBeDefined();
    expect(String(accessLogs?.Format)).toContain('$context.requestId');
    expect(String(accessLogs?.Format)).toContain('$context.routeKey');
    expect(String(accessLogs?.Format)).toContain('$context.status');
    expect(resourcesOfType(template, 'AWS::Logs::LogGroup')).toHaveLength(1);
  });
});
