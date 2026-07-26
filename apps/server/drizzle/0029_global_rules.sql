-- One administrator-owned NORN.md applied to every future task briefing.
-- Project NORN.md directives remain separately versioned and can be more
-- specific for their own project.

CREATE TABLE global_rule_settings (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  filename TEXT NOT NULL CHECK (filename = 'NORN.md'),
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL CHECK (version > 0),
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON global_rule_settings TO norns_app;
