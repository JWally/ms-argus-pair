import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { StaticSiteConstruct } from './static-site';

export interface CaptchaCdnStackProps extends StackProps {
  stage: string;
  customDomain?: string;
  rootDomain?: string;
}

/**
 * CDN for the embeddable captcha loader (static-captcha[-stage].argus.pw).
 * A separate stack from PairStack so the loader's SRI/caching/deploy stay
 * decoupled from the pairing app + backend, while living in one repo.
 */
export class CaptchaCdnStack extends Stack {
  constructor(scope: Construct, id: string, props: CaptchaCdnStackProps) {
    super(scope, id, props);
    new StaticSiteConstruct(this, 'Site', {
      stage: props.stage,
      customDomain: props.customDomain,
      rootDomain: props.rootDomain,
    });
  }
}
