import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

interface PairHttpApiProps {
  allowOrigins: string[];
  handler: lambda.IFunction;
}

interface PairHttpRoute {
  path: string;
  method: apigatewayv2.HttpMethod;
}

const PAIR_HTTP_ROUTES: PairHttpRoute[] = [
  { path: '/api/session/start', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/sso/start', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/sso/{id}/challenge', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/sso/{id}/validate', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/sso/approval/redeem', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/sso/approval/exchange', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/session/{id}/info', method: apigatewayv2.HttpMethod.GET },
  { path: '/api/session/{id}/verdict-token', method: apigatewayv2.HttpMethod.GET },
  { path: '/api/verify', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/session/{id}/pair-token', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/pair-token/redeem', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/phone-perf', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/sso/telemetry', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/session/{id}/desktop-attest', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/session/{id}/phone-attest', method: apigatewayv2.HttpMethod.POST },
  { path: '/api/session/{id}/result', method: apigatewayv2.HttpMethod.GET },
  // Return JSON for client URL drift instead of CloudFront-rewritten SPA HTML.
  { path: '/api/{proxy+}', method: apigatewayv2.HttpMethod.ANY },
];

function addPairRoutes(
  api: apigatewayv2.HttpApi,
  integration: integrations.HttpLambdaIntegration
): void {
  for (const route of PAIR_HTTP_ROUTES) {
    api.addRoutes({
      path: route.path,
      methods: [route.method],
      integration,
    });
  }
}

function configureDefaultStage(scope: Construct, api: apigatewayv2.HttpApi): void {
  const accessLogs = new logs.LogGroup(scope, 'PairApiAccessLogs', {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const stage = api.defaultStage!.node.defaultChild as apigatewayv2.CfnStage;
  stage.defaultRouteSettings = {
    throttlingBurstLimit: 50,
    throttlingRateLimit: 20,
  };
  stage.accessLogSettings = {
    destinationArn: accessLogs.logGroupArn,
    format: JSON.stringify({
      requestId: '$context.requestId',
      routeKey: '$context.routeKey',
      status: '$context.status',
      integrationStatus: '$context.integrationStatus',
      integrationError: '$context.integrationErrorMessage',
      responseLength: '$context.responseLength',
    }),
  };
}

export function createPairHttpApi(scope: Construct, props: PairHttpApiProps): apigatewayv2.HttpApi {
  const api = new apigatewayv2.HttpApi(scope, 'PairApi', {
    corsPreflight: {
      allowOrigins: props.allowOrigins,
      allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST],
      allowHeaders: ['content-type'],
    },
  });
  const integration = new integrations.HttpLambdaIntegration('PairInt', props.handler);
  addPairRoutes(api, integration);
  configureDefaultStage(scope, api);
  return api;
}
