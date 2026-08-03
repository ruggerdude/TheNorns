-- Routine QC uses one reviewer/PM cycle by default. Projects can still opt
-- into two or more rounds for higher-risk plans, and existing explicit
-- project settings remain untouched.
ALTER TABLE planning_reviewer_settings
  ALTER COLUMN default_max_rounds SET DEFAULT 1;
