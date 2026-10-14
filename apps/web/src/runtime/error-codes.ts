import {
  API_ERROR_CODES,
  CLIENT_REQUEST_ID_HEADER,
  normalizeUpstreamCode,
  parseApiFailureDetail,
  type ApiFailureDetail,
} from '@open-design/contracts';

const REQUEST_ERROR_CODES = new Set<string>([
  ...API_ERROR_CODES,
  'network_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'server_error',
  'request_failed',
  'FETCH_FAILED',
  'INVALID_ARCHIVE',
  'INVALID_MANIFEST',
]);

export function boundedRequestErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ERROR_CODES.has(value)
    ? value
    : undefined;
}

interface DaemonFailureFields {
  failure?: ApiFailureDetail;
  daemonErrorCode?: string;
}

export function withDaemonFailure<E extends Error>(
  error: E,
  fields: { failure?: unknown; daemonErrorCode?: unknown },
): E & DaemonFailureFields {
  const failure = parseApiFailureDetail(fields.failure);
  const daemonErrorCode = normalizeUpstreamCode(fields.daemonErrorCode);
  return Object.assign(error, {
    ...(failure ? { failure } : {}),
    ...(daemonErrorCode ? { daemonErrorCode } : {}),
  });
}

export function clientRequestIdHeaders(requestId: string | undefined): Record<string, string> {
  return requestId ? { [CLIENT_REQUEST_ID_HEADER]: requestId } : {};
}

export const GENERIC_DEPLOY_ENVELOPE_CODES = new Set([
  'BAD_REQUEST',
  'FILE_NOT_FOUND',
  'INTERNAL',
  'INTERNAL_ERROR',
  'UNKNOWN',
]);
