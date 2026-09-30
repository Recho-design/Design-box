/**
 * Classify a failed publish/unpublish error into a stable, queryable analytics
 * code for `artifact_publish_result.error_code`.
 */

import type { TrackingPublishErrorCode } from '@open-design/contracts/analytics';

export function publishErrorCode(_err: unknown): TrackingPublishErrorCode {
  return 'publish_failed';
}
