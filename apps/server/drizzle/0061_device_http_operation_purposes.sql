-- LOCAL AGENT RELIABILITY: the replay ledger originally allowed only the
-- first three signed device HTTP operations. Repository registration,
-- revocation, and publication permits were added later but their
-- domain-separated purposes were not added to the database constraint. The
-- request was therefore rejected by PostgreSQL before the route could act.

ALTER TABLE device_http_request_replays
  DROP CONSTRAINT device_http_request_replays_purpose_check;

ALTER TABLE device_http_request_replays
  ADD CONSTRAINT device_http_request_replays_purpose_check CHECK (
    purpose IN (
      'norns.runner-http.context-retrieval.v1',
      'norns.runner-http.gateway-credential-mint.v1',
      'norns.runner-http.visual-evidence-upload.v1',
      'norns.runner-http.repository-registration.v1',
      'norns.runner-http.repository-registration-revocation.v1',
      'norns.runner-http.publication-permit-issue.v1',
      'norns.runner-http.publication-permit-consume.v1'
    )
  );
