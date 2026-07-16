import { MerchantSso } from './MerchantSso';
import { MerchantValidate } from './MerchantValidate';
import { MobileSso } from './MobileSso';
import { SsoChallenge } from './SsoChallenge';

type SsoPage = 'merchant' | 'mobile' | 'challenge' | 'validate';

export function SsoRoute({ page }: { page: SsoPage }) {
  switch (page) {
    case 'merchant':
      return <MerchantSso />;
    case 'mobile':
      return <MobileSso />;
    case 'challenge':
      return <SsoChallenge />;
    case 'validate':
      return <MerchantValidate />;
  }
}
