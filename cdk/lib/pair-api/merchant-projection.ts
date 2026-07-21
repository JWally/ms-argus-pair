export interface MerchantProjection {
  schema_version: 1;
  session_id: string;
  automation: number;
  device_tampering: number;
  network_tampering: number;
  created_at: number;
  verdict: 'clean' | 'suspect' | 'block';
  identification: {
    browserDetails: {
      browserName: string | null;
      browserVersion: string | null;
      device: string | null;
      os: string | null;
      userAgent: string | null;
    };
  };
  ip: string | null;
  ipLocation: {
    city: string | null;
    country: string | null;
  };
  ipInfo: {
    asn: { organization: string | null };
    datacenter: { result: boolean };
    mobile: { result: boolean };
    vpn: { result: boolean };
    hosting: { result: boolean };
  };
  tags: string[];
  worker_scope_evidence: {
    all_scopes_consistent: boolean;
    main_web_consensus_id: string | null;
    shared_partition_candidate: boolean;
    brave_detected: boolean;
    device_tampering_without_worker: number;
  } | null;
}
