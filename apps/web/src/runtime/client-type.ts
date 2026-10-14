import { detectOpenDesignHostClientType } from '@open-design/host';

export type ClientType = 'web' | 'desktop';

// Desktop packaged builds install the OpenDesign host bridge so the
// same web bundle can distinguish desktop runs from browser visits.
// Falls back to 'web' when the host bridge isn't present.
export function detectClientType(): ClientType {
  if (typeof window === 'undefined') return 'web';
  return detectOpenDesignHostClientType();
}
