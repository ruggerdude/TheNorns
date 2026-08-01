-- attentionService.portfolio() UNIONs in a branch filtering
-- conversation_plan_reviews.status = 'awaiting_human' (paused QC gates).
-- portfolio() is polled roughly every 10s per open project, and the only
-- existing status index (conversation_plan_reviews_work_item_status_idx,
-- 0037) leads with work_item_id, so this scan is sequential over the whole
-- table and scales with total historical reviews rather than with how many
-- are actually parked. A partial index on the narrow 'awaiting_human'
-- predicate is cheap to build even inside the migration runner's
-- transaction wrapper (no CONCURRENTLY available).

DO $qc_attention_index_dependency$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM norns_schema_migrations
     WHERE name = '0068_qc_gate_a_accept_now'
  ) THEN
    RAISE EXCEPTION
      '0069_qc_attention_index requires 0068_qc_gate_a_accept_now'
      USING ERRCODE = '55000';
  END IF;
END
$qc_attention_index_dependency$;

CREATE INDEX conversation_plan_reviews_awaiting_human_idx
  ON conversation_plan_reviews(status)
  WHERE status = 'awaiting_human';
