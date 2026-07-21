import type { MerchantProjection } from './merchant-projection';

export type ProjectionParseResult =
  | { ok: true; projection: MerchantProjection }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function hasBrowserContract(identification: unknown): boolean {
  if (!isRecord(identification) || !isRecord(identification.browserDetails)) return false;
  const browser = identification.browserDetails;
  return (
    isNullableString(browser.browserName) &&
    isNullableString(browser.browserVersion) &&
    isNullableString(browser.os) &&
    isNullableString(browser.device) &&
    isNullableString(browser.userAgent)
  );
}

function isResultFlag(value: unknown): boolean {
  return isRecord(value) && typeof value.result === 'boolean';
}

function hasNetworkContract(ipInfo: unknown): boolean {
  if (!isRecord(ipInfo) || !isRecord(ipInfo.asn)) return false;
  if (!isNullableString(ipInfo.asn.organization)) return false;
  return (
    isResultFlag(ipInfo.datacenter) &&
    isResultFlag(ipInfo.mobile) &&
    isResultFlag(ipInfo.vpn) &&
    isResultFlag(ipInfo.hosting)
  );
}

function hasWorkerContract(evidence: unknown): boolean {
  if (evidence === null) return true;
  if (!isRecord(evidence)) return false;
  return (
    typeof evidence.all_scopes_consistent === 'boolean' &&
    isNullableString(evidence.main_web_consensus_id) &&
    typeof evidence.shared_partition_candidate === 'boolean' &&
    typeof evidence.brave_detected === 'boolean' &&
    isScore(evidence.device_tampering_without_worker)
  );
}

function projectionContractError(value: Record<string, unknown>): string | null {
  if (value.schema_version !== 1) return 'unsupported schema_version';
  if (typeof value.session_id !== 'string' || value.session_id.trim().length === 0) {
    return 'missing session_id';
  }
  if (!Number.isSafeInteger(value.created_at) || (value.created_at as number) <= 0) {
    return 'missing created_at';
  }
  if (![value.automation, value.device_tampering, value.network_tampering].every(isScore)) {
    return 'invalid threat score';
  }
  if (!['clean', 'suspect', 'block'].includes(String(value.verdict))) return 'invalid verdict';
  if (!hasBrowserContract(value.identification)) return 'invalid browser details';
  if (!isNullableString(value.ip)) return 'invalid ip';
  if (!isRecord(value.ipLocation)) return 'invalid ipLocation';
  if (!isNullableString(value.ipLocation.city) || !isNullableString(value.ipLocation.country)) {
    return 'invalid ipLocation';
  }
  if (!hasNetworkContract(value.ipInfo)) return 'invalid ipInfo';
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) {
    return 'invalid tags';
  }
  if (!hasWorkerContract(value.worker_scope_evidence)) return 'invalid worker_scope_evidence';
  return null;
}

/** Parse the API-owned current contract before any Pair policy reads its fields. */
export function parseMerchantProjection(value: unknown): ProjectionParseResult {
  if (!isRecord(value)) return { ok: false, error: 'projection is not an object' };
  const error = projectionContractError(value);
  return error
    ? { ok: false, error }
    : { ok: true, projection: value as unknown as MerchantProjection };
}
