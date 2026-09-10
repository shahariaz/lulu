-- 006_provider_contracts.sql
--
-- Persisted snapshots of what each gateway actually did, so provider drift becomes a diff
-- across time rather than an invisible change between test runs. Contract tests prove the
-- contract at the moment they run; this records it continuously so a capability that
-- disappears on a Tuesday is attributable to that Tuesday.

CREATE TABLE provider_contract_snapshots (
  id TEXT PRIMARY KEY,
  gateway_url TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  resolved_model TEXT,
  reachable INTEGER NOT NULL CHECK (reachable IN (0, 1)),
  -- Capability surface. Stored as columns rather than JSON so drift can be queried directly.
  honours_requested_model INTEGER,
  reports_usage INTEGER,
  reports_reasoning_tokens INTEGER,
  returns_text_content INTEGER,
  stop_reason TEXT,
  usage_keys_json TEXT NOT NULL DEFAULT '[]',
  content_types_json TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT NOT NULL,
  error TEXT,
  observed_at INTEGER NOT NULL
);

CREATE INDEX idx_contract_gateway ON provider_contract_snapshots(gateway_url, observed_at);
CREATE INDEX idx_contract_fingerprint ON provider_contract_snapshots(fingerprint);
