-- Authority assessment and conversation bounds (ACCP §14).
--
-- `authority` is the receiver's finding about the sender's `principal` claim,
-- which is why it lives beside `payload_integrity` rather than inside the
-- context blob: context is what the sender said, and this is what we concluded.
-- A sender that could write into this column would make the column worthless.

BEGIN;

ALTER TABLE agents
  ADD COLUMN max_delegation_depth integer NOT NULL DEFAULT 4,
  ADD COLUMN max_drifting_replies integer NOT NULL DEFAULT 3;

-- Shape of `authority` is §14.2: verdict, claimed, claimed_domain,
-- authenticated_domain, delegation_depth, delegation_consistent,
-- depth_exceeded, reason.
ALTER TABLE messages
  ADD COLUMN authority jsonb;

-- Only the four verdicts exist, and `aligned` is meaningful only when a domain
-- actually authenticated — a verdict of `aligned` with no authenticated domain
-- would be a claim with nothing behind it, which is the state this whole
-- assessment exists to distinguish.
ALTER TABLE messages
  ADD CONSTRAINT messages_authority_verdict_known CHECK (
    authority IS NULL OR (
      authority ->> 'verdict' IN ('aligned', 'unaligned', 'unauthenticated', 'none') AND
      (authority ->> 'verdict' <> 'aligned' OR authority ->> 'authenticated_domain' IS NOT NULL)
    )
  );

-- Finding every message where someone claimed an authority nothing backed is a
-- question worth being able to ask cheaply.
CREATE INDEX messages_unbacked_authority_idx
  ON messages ((authority ->> 'verdict'))
  WHERE authority ->> 'verdict' IN ('unaligned', 'unauthenticated');

COMMIT;
