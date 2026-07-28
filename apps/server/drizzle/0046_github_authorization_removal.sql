-- A user may remove their own stored GitHub OAuth authorization from
-- Settings. The runtime role otherwise retains the original least-privilege
-- surface on integration tables.

GRANT DELETE ON github_user_authorizations TO norns_app;
