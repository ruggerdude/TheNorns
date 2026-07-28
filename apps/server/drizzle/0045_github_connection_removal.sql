-- Keep a local tombstone when an administrator removes a GitHub connection.
-- GitHub's installation inventory is refreshed opportunistically, so a hard
-- delete would recreate the connection on the next refresh while the remote
-- GitHub App installation still exists.

ALTER TABLE service_connections
  DROP CONSTRAINT IF EXISTS service_connections_status_check;

ALTER TABLE service_connections
  ADD CONSTRAINT service_connections_status_check
  CHECK (status IN ('connected', 'action_required', 'disconnected', 'deleted'));
