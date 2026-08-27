-- Monthly partitions for the two high-volume tables.
--
-- Run ahead of time (a scheduled job creates next month's partitions). Dropping
-- an old partition is how message log retention is enforced (FR-9.6).
--
-- Retention caveat worth stating plainly: an agent's inbox lives in `messages`
-- too, so a partition drop would take un-acked inbound mail with it. Roll up
-- aggregates before dropping, and exclude partitions still holding rows with
-- `mailbox_state IN ('unread', 'claimed')` — an agent's unread mail is not a
-- log line and does not age out on the log schedule.

CREATE OR REPLACE FUNCTION create_month_partition(parent regclass, month date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  partition_name text := format('%s_%s', parent::text, to_char(month, 'YYYYMM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    parent::text,
    month,
    (month + interval '1 month')::date
  );
END;
$$;

-- Current month plus the next two, so a send never arrives with nowhere to land.
SELECT create_month_partition('messages', date_trunc('month', now())::date);
SELECT create_month_partition('messages', (date_trunc('month', now()) + interval '1 month')::date);
SELECT create_month_partition('messages', (date_trunc('month', now()) + interval '2 months')::date);

SELECT create_month_partition('message_events', date_trunc('month', now())::date);
SELECT create_month_partition('message_events', (date_trunc('month', now()) + interval '1 month')::date);
SELECT create_month_partition('message_events', (date_trunc('month', now()) + interval '2 months')::date);
