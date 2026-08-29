-- Durable, provenance-carrying agent memory (ACCP §12).
--
-- Deliberately NOT partitioned like `messages`. Memory is small, long-lived and
-- read constantly; it has no retention schedule to hang partitions off, and a
-- partition drop that silently removed what an agent knows is exactly the
-- failure §12.6 exists to prevent.
--
-- Two constraints below carry the protocol rules rather than leaving them to
-- application code, because the whole point of §12.3 is that trust is not
-- something a caller can assert:
--
--   * `trust` is a closed enum. There is no level above `attested`.
--   * `attested` is only reachable when provenance actually records a verified
--     payload under DKIM pass. A row claiming `attested` on anything else is
--     rejected by the database, not merely by the service that wrote it.

BEGIN;

CREATE TABLE agent_memory (
  id             text PRIMARY KEY,
  account_id     text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id       text        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,

  key            text        NOT NULL,
  value          jsonb       NOT NULL,
  summary        text        NOT NULL DEFAULT '',

  trust          text        NOT NULL
                             CHECK (trust IN ('attested', 'authenticated', 'asserted', 'derived')),

  -- Shape of `provenance` is §12.4: origin, message_id, rfc_message_id,
  -- content_digest, asserted_by, integrity, dkim, derived_from.
  provenance     jsonb       NOT NULL,

  thread_id      text,
  supersedes     text        REFERENCES agent_memory(id) ON DELETE SET NULL,
  superseded_at  timestamptz,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- §12.3: both halves, or it is not attested. Enforced here so a bug in any
  -- writer cannot mint an actionable memory out of an unverified message.
  CONSTRAINT agent_memory_attested_requires_proof CHECK (
    trust <> 'attested' OR (
      provenance ->> 'origin'    = 'message' AND
      provenance ->> 'integrity' = 'verified' AND
      upper(provenance ->> 'dkim') = 'PASS'
    )
  ),

  -- §12.4: an inference must say what it was inferred from.
  CONSTRAINT agent_memory_inference_cites_sources CHECK (
    provenance ->> 'origin' <> 'inference' OR
    jsonb_array_length(coalesce(provenance -> 'derived_from', '[]'::jsonb)) > 0
  )
);

-- The common read is "the live value for this key", so index the live rows only.
CREATE UNIQUE INDEX agent_memory_live_key_idx
  ON agent_memory (agent_id, key)
  WHERE superseded_at IS NULL AND revoked_at IS NULL;

-- Prefix recall (`policy.`) and full listings, newest first.
CREATE INDEX agent_memory_agent_idx ON agent_memory (agent_id, key text_pattern_ops, created_at DESC);

-- Reverse lookup: everything an agent concluded from one message, for the case
-- where a sender retracts and every downstream belief has to be found.
CREATE INDEX agent_memory_source_message_idx
  ON agent_memory ((provenance ->> 'message_id'))
  WHERE provenance ->> 'message_id' IS NOT NULL;

CREATE INDEX agent_memory_thread_idx ON agent_memory (thread_id) WHERE thread_id IS NOT NULL;

COMMIT;
