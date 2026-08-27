-- AgentMail schema, v1.
--
-- Postgres rather than Firestore, for the reasons in SRS §3.2: every dashboard
-- view is an aggregate over an append-heavy event table, and log browsing is a
-- feature developers expect to be fast and cheap.

BEGIN;

-- Case-insensitive email and domain columns.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE accounts (
  id                 text PRIMARY KEY,
  slug               text        NOT NULL UNIQUE,
  name               text        NOT NULL,
  tenant_name        text        NOT NULL UNIQUE,
  status             text        NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'paused', 'suspended')),
  plan               text        NOT NULL DEFAULT 'free',
  daily_send_limit   integer     NOT NULL DEFAULT 100,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          text PRIMARY KEY,
  account_id  text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email       citext      NOT NULL,
  role        text        NOT NULL CHECK (role IN ('owner', 'developer', 'marketer', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, email)
);

-- Keys are stored as salted scrypt hashes; the plaintext is shown once and
-- never persisted (NFR-3.2). `agent_id` is what makes a credential reach
-- exactly one mailbox and nothing else.
CREATE TABLE api_keys (
  id           text PRIMARY KEY,
  account_id   text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  prefix       text        NOT NULL,
  key_hash     text        NOT NULL,
  scope        text        NOT NULL CHECK (scope IN ('full', 'send', 'read', 'agent')),
  agent_id     text,
  domain_id    text,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (scope <> 'agent' OR agent_id IS NOT NULL)
);
CREATE INDEX api_keys_prefix_idx ON api_keys (prefix) WHERE revoked_at IS NULL;
CREATE INDEX api_keys_account_idx ON api_keys (account_id);

CREATE TABLE domains (
  id                  text PRIMARY KEY,
  account_id          text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  domain              citext      NOT NULL,
  mail_from_subdomain text        NOT NULL,
  config_set_name     text        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'verified', 'failed')),
  records             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  warnings            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, domain)
);

CREATE TABLE agents (
  id              text PRIMARY KEY,
  account_id      text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug            text        NOT NULL,
  address         citext      NOT NULL UNIQUE,
  display_name    text        NOT NULL,
  description     text        NOT NULL DEFAULT '',
  capabilities    text[]      NOT NULL DEFAULT '{}',
  inbox_policy    text        NOT NULL DEFAULT 'verified'
                              CHECK (inbox_policy IN ('open', 'verified', 'allowlist', 'closed')),
  allowlist       text[]      NOT NULL DEFAULT '{}',
  discoverable    boolean     NOT NULL DEFAULT false,
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  webhook_url     text,
  max_hops        integer     NOT NULL DEFAULT 10,
  max_thread_rate integer     NOT NULL DEFAULT 30,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, slug)
);
CREATE INDEX agents_directory_idx ON agents USING gin (capabilities) WHERE discoverable;

-- One table for both directions. An agent's inbox entry is a row with
-- direction = 'inbound' and an agent_id; the outbound row is the send record.
-- Partitioned by month so retention is a DETACH, not a delete storm.
CREATE TABLE messages (
  id                  text        NOT NULL,
  account_id          text        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('transactional', 'campaign', 'agent')),
  direction           text        NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  transport           text        NOT NULL CHECK (transport IN ('internal', 'provider')),
  status              text        NOT NULL,
  from_address        jsonb       NOT NULL,
  to_addresses        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  reply_to_addresses  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  subject             text        NOT NULL DEFAULT '',
  html                text,
  text                text,
  headers             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  attachments         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  structured          jsonb,
  rfc_message_id      text        NOT NULL,
  in_reply_to         text,
  references_ids      text[]      NOT NULL DEFAULT '{}',
  thread_id           text        NOT NULL,
  agent_id            text,
  campaign_id         text,
  template_id         text,
  tags                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  hops                integer     NOT NULL DEFAULT 0,
  provider_message_id text,
  error               text,
  idempotency_key     text,
  mailbox_state       text        CHECK (mailbox_state IN ('unread', 'claimed', 'acked', 'archived')),
  claimed_by          text,
  lease_expires_at    timestamptz,
  delivery_attempts   integer     NOT NULL DEFAULT 0,
  scheduled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX messages_account_created_idx ON messages (account_id, created_at DESC);
CREATE INDEX messages_thread_idx          ON messages (account_id, thread_id, created_at);
CREATE INDEX messages_rfc_idx             ON messages (account_id, rfc_message_id);
CREATE INDEX messages_provider_idx        ON messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX messages_idempotency_idx ON messages (account_id, idempotency_key, created_at)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_campaign_idx ON messages (campaign_id, created_at) WHERE campaign_id IS NOT NULL;

-- The mailbox working set: claim() reads exactly this index.
CREATE INDEX messages_inbox_idx ON messages (agent_id, mailbox_state, created_at)
  WHERE direction = 'inbound';
CREATE INDEX messages_lease_idx ON messages (lease_expires_at)
  WHERE mailbox_state = 'claimed';

CREATE TABLE message_events (
  id          text        NOT NULL,
  account_id  text        NOT NULL,
  message_id  text        NOT NULL,
  type        text        NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX message_events_message_idx ON message_events (message_id, occurred_at);
CREATE INDEX message_events_account_idx ON message_events (account_id, type, occurred_at DESC);

CREATE TABLE suppressions (
  id         text PRIMARY KEY,
  account_id text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email      citext      NOT NULL,
  reason     text        NOT NULL
                         CHECK (reason IN ('hard_bounce', 'soft_bounce', 'complaint', 'unsubscribe', 'manual')),
  list_id    text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, email)
);

CREATE TABLE templates (
  id         text PRIMARY KEY,
  account_id text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  version    integer     NOT NULL DEFAULT 1,
  subject    text        NOT NULL,
  html       text        NOT NULL,
  text       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);

CREATE TABLE lists (
  id           text PRIMARY KEY,
  account_id   text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  double_optin boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id            text PRIMARY KEY,
  account_id    text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  list_id       text        NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  email         citext      NOT NULL,
  name          text,
  custom_fields jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status        text        NOT NULL DEFAULT 'subscribed'
                            CHECK (status IN ('subscribed', 'unconfirmed', 'unsubscribed')),
  -- Consent evidence: where the address came from and when it was confirmed
  -- (NFR-4.6).
  source        text        NOT NULL DEFAULT 'api',
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (list_id, email)
);

CREATE TABLE campaigns (
  id           text PRIMARY KEY,
  account_id   text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  domain_id    text REFERENCES domains(id) ON DELETE SET NULL,
  from_address jsonb       NOT NULL,
  reply_to     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  subject      text        NOT NULL,
  preview_text text        NOT NULL DEFAULT '',
  html         text        NOT NULL,
  text         text        NOT NULL,
  list_ids     text[]      NOT NULL DEFAULT '{}',
  status       text        NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'canceled')),
  scheduled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhooks (
  id          text PRIMARY KEY,
  account_id  text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url         text        NOT NULL,
  secret      text        NOT NULL,
  event_types text[]      NOT NULL DEFAULT '{}',
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id              text PRIMARY KEY,
  account_id      text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  webhook_id      text        NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id        text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text,
  last_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id, created_at DESC);

-- Append-only: no UPDATE or DELETE grant is issued on this table (NFR/FR-12.8).
CREATE TABLE audit_log (
  id          text PRIMARY KEY,
  account_id  text,
  actor       text        NOT NULL,
  action      text        NOT NULL,
  target      text        NOT NULL,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_account_idx ON audit_log (account_id, occurred_at DESC);

COMMIT;
