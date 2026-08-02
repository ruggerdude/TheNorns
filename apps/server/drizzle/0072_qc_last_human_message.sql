-- QCP-R7: AttentionService.portfolio()'s QC-gate branch computed the TTL
-- nudge by CROSS JOIN LATERAL-ing jsonb_array_elements(chat_messages) per
-- matching row on every poll (~every 10s per open project), rescanning the
-- whole append-only chat transcript from scratch. Denormalize the one value
-- that read actually needs: the timestamp of the latest human chat message.
--
-- Backfilled from the existing chat_messages JSONB so parked reviews keep
-- their correct TTL clock instead of getting reset to null. The backfill
-- UPDATE goes through conversation_plan_reviews_lifecycle_guard like any
-- other UPDATE on this table, and that trigger forbids touching terminal
-- (converged/cap_reached/cancelled) rows and restricts 'failed' rows to
-- chat_messages/markdown_artifacts/updated_at — so the guard is disabled for
-- the duration of the backfill, same pattern as 0009's agent_reviews backfill.

DO $qc_last_human_message_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0071_qc_zero_rounds'
  ) THEN
    RAISE EXCEPTION
      '0072_qc_last_human_message requires 0071_qc_zero_rounds'
      USING ERRCODE = '55000';
  END IF;
END
$qc_last_human_message_dependency$;

ALTER TABLE conversation_plan_reviews
  ADD COLUMN last_human_message_at TIMESTAMPTZ;

ALTER TABLE conversation_plan_reviews
  DISABLE TRIGGER conversation_plan_reviews_lifecycle_guard;

UPDATE conversation_plan_reviews review
   SET last_human_message_at = backfill.last_human_at
  FROM (
    SELECT r.id,
           max((msg->>'created_at')::timestamptz) AS last_human_at
      FROM conversation_plan_reviews r
      CROSS JOIN LATERAL jsonb_array_elements(r.chat_messages) msg
     WHERE msg->>'speaker' = 'human'
     GROUP BY r.id
  ) backfill
 WHERE backfill.id = review.id;

ALTER TABLE conversation_plan_reviews
  ENABLE TRIGGER conversation_plan_reviews_lifecycle_guard;
