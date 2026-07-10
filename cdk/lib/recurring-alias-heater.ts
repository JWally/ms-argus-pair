import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface RecurringAliasHeaterProps {
  ruleName: string;
  target: lambda.IFunction;
  invokesPerMinute: number;
  spacingSeconds: number;
  warmupPayload?: Record<string, unknown>;
}

export class RecurringAliasHeater extends Construct {
  constructor(scope: Construct, id: string, props: RecurringAliasHeaterProps) {
    super(scope, id);

    const heaterFn = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      memorySize: 128,
      timeout: cdk.Duration.seconds(
        Math.max(10, props.spacingSeconds * Math.max(0, props.invokesPerMinute - 1) + 10)
      ),
      code: lambda.Code.fromInline(`
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const client = new LambdaClient({});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.handler = async () => {
  const targetArn = process.env.TARGET_ARN;
  const invokes = Number(process.env.INVOKES_PER_MINUTE || "1");
  const spacingMs = Number(process.env.SPACING_SECONDS || "60") * 1000;
  const payload = Buffer.from(process.env.WARMUP_PAYLOAD || "{}");

  for (let index = 0; index < invokes; index += 1) {
    await client.send(new InvokeCommand({
      FunctionName: targetArn,
      InvocationType: "Event",
      Payload: payload,
    }));
    if (index < invokes - 1) await sleep(spacingMs);
  }

  return { invoked: invokes };
};
`),
      environment: {
        TARGET_ARN: props.target.functionArn,
        INVOKES_PER_MINUTE: String(props.invokesPerMinute),
        SPACING_SECONDS: String(props.spacingSeconds),
        WARMUP_PAYLOAD: JSON.stringify(
          props.warmupPayload ?? { source: 'serverless-plugin-warmup' }
        ),
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    props.target.grantInvoke(heaterFn);
    heaterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [props.target.functionArn],
      })
    );

    const rule = new events.Rule(this, 'Rule', {
      ruleName: props.ruleName,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      description: `Warm ${props.target.functionName} ${props.invokesPerMinute}x/min`,
    });
    rule.addTarget(new targets.LambdaFunction(heaterFn));
  }
}
