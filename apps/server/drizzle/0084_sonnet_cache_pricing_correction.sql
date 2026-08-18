-- Claude Sonnet 5 prompt-cache reads are 0.1x regular input and five-minute
-- cache writes are 1.25x. The former registry charged both categories as
-- ordinary input. Preserve the canonical append-only ledger by recording a
-- signed adjustment for every observation made before this migration.
DO $correction$
DECLARE
  observed ai_usage_events%ROWTYPE;
  corrected_cost NUMERIC(24,9);
  next_sequence INTEGER;
BEGIN
  FOR observed IN
    SELECT usage.*
      FROM ai_usage_events usage
     WHERE usage.event_type='usage_observed'
       AND usage.provider='anthropic'
       AND usage.model='claude-sonnet-5'
       AND usage.cost_usd IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM ai_usage_events adjustment
          WHERE adjustment.adjusts_event_id=usage.id
            AND adjustment.id='cache-price-correction:' || usage.id
       )
     ORDER BY usage.request_id, usage.sequence
  LOOP
    corrected_cost := CEIL((
      (observed.input_tokens - observed.cache_read_tokens - observed.cache_write_tokens) * 2
      + observed.cache_read_tokens * 0.2
      + observed.cache_write_tokens * 2.5
      + observed.output_tokens * 10
    ) * 1000) / 1000000000;
    IF corrected_cost IS DISTINCT FROM observed.cost_usd THEN
      SELECT COALESCE(MAX(sequence), 0) + 1
        INTO next_sequence
        FROM ai_usage_events
       WHERE request_id=observed.request_id;
      INSERT INTO ai_usage_events (
        id, request_id, sequence, event_type, status, occurred_at,
        provider, model, provider_request_id, endpoint, request_type,
        retry_group_id, retry_attempt, initiated_by_user_id, project_id,
        phase_id, task_id, run_id, usage_source, confidence,
        pricing_profile_id, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, cost_usd, cost_classification, latency_ms,
        http_status, error_code, error_category, error_message_redacted,
        sanitized_error, adjusts_event_id
      ) VALUES (
        'cache-price-correction:' || observed.id,
        observed.request_id, next_sequence, 'adjustment', 'adjusted',
        GREATEST(clock_timestamp(), observed.occurred_at),
        observed.provider, observed.model, observed.provider_request_id,
        observed.endpoint, observed.request_type, observed.retry_group_id,
        observed.retry_attempt, observed.initiated_by_user_id,
        observed.project_id, observed.phase_id, observed.task_id,
        observed.run_id, 'manual_adjustment', 1, NULL,
        NULL, NULL, NULL, NULL, corrected_cost - observed.cost_usd,
        'actual', NULL, NULL, NULL, NULL, NULL, NULL, observed.id
      );
    END IF;
  END LOOP;
END;
$correction$;

-- The execution UI and reservation guard still consume the compact legacy
-- ledger. Match its rows to the canonical provider observations and bring the
-- displayed/enforced cost into agreement with the audited corrected total.
WITH corrected AS (
  SELECT DISTINCT ON (legacy.id)
         legacy.id,
         CEIL((
           (canonical.input_tokens - canonical.cache_read_tokens - canonical.cache_write_tokens) * 2
           + canonical.cache_read_tokens * 0.2
           + canonical.cache_write_tokens * 2.5
           + canonical.output_tokens * 10
         ) * 1000) / 1000000000 AS cost_usd
    FROM usage_events legacy
    JOIN ai_usage_events canonical
      ON canonical.run_id=legacy.run_id
     AND canonical.event_type='usage_observed'
     AND canonical.provider='anthropic'
     AND canonical.model='claude-sonnet-5'
     AND canonical.input_tokens=legacy.input_tokens
     AND canonical.output_tokens=legacy.output_tokens
   WHERE legacy.provider='anthropic'
     AND legacy.model='claude-sonnet-5'
   ORDER BY legacy.id,
            ABS(EXTRACT(EPOCH FROM (canonical.occurred_at - legacy.occurred_at)))
)
UPDATE usage_events legacy
   SET cost_usd=corrected.cost_usd
  FROM corrected
 WHERE legacy.id=corrected.id;

UPDATE agent_runs run
   SET usage_cost_usd=totals.cost_usd,
       updated_at=now()
  FROM (
    SELECT run_id, SUM(cost_usd) AS cost_usd
      FROM usage_events
     WHERE run_id IS NOT NULL
     GROUP BY run_id
  ) totals
 WHERE run.id=totals.run_id
   AND EXISTS (
     SELECT 1 FROM usage_events usage
      WHERE usage.run_id=run.id
        AND usage.provider='anthropic'
        AND usage.model='claude-sonnet-5'
   );
