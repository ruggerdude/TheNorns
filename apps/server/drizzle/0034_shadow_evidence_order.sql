-- Privileged identity cutover evidence is bound to transaction_timestamp().
-- Multiple observations in one transaction can therefore share observed_at.
-- Persist insertion order so "latest" never falls back to a content-derived
-- hash whose lexical order has no temporal meaning.

DO $shadow_evidence_order_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM norns_schema_migrations
    WHERE name = '0033_usage_calibration_analytics'
  ) THEN
    RAISE EXCEPTION
      '0034_shadow_evidence_order requires 0033_usage_calibration_analytics'
      USING ERRCODE = '55000';
  END IF;
END
$shadow_evidence_order_dependency$;

ALTER TABLE shadow_read_comparisons
  ADD COLUMN recorded_order BIGINT GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX shadow_read_comparisons_recorded_order_unique
  ON shadow_read_comparisons (recorded_order);
