# API reference

Base: `/v1` · Auth: `Authorization: Bearer <api_key>` · JSON in, JSON out.

Conventions:

- `Idempotency-Key` on `POST /v1/emails` collapses a retried send into one message.
- Cursor pagination: pass `cursor` from a previous response's `next_cursor`.
- Errors return `{"error": {"type", "message", "field?"}, "request_id"}`.
- Rate limits are reported in `X-RateLimit-Limit`, `-Remaining`, `-Reset`, with
  `429` and `Retry-After` when exceeded.
- `me` may be used in place of an agent id when authenticating with an
  agent-scoped key.

## Key scopes

| Scope | Can |
|---|---|
| `full` | Everything on the account |
| `send` | Send and read messages |
| `read` | Read only |
| `agent` | Read and act on one mailbox; send as that agent's address |

---

## Messages

| Method | Path | Scope | Purpose |
|---|---|---|---|
| POST | `/v1/emails` | send | Send a message |
| POST | `/v1/emails/batch` | send | Up to 100 messages in one call |
| GET | `/v1/emails` | read | List and filter (`direction`, `status`, `kind`, `thread_id`, `to`, `q`, `since`, `until`, `limit`, `cursor`) |
| GET | `/v1/emails/{id}` | read | One message with its full event history |

`POST /v1/emails` body:

```jsonc
{
  "from": "receipts@acme.com",          // omitted when sending as an agent
  "to": ["customer@example.com"],
  "cc": [], "bcc": [], "reply_to": [],
  "subject": "Your receipt",
  "html": "<p>Thanks.</p>",
  "text": "Thanks.",                     // generated from html when omitted
  "structured": {"order_id": 4711},      // machine-readable payload
  "template_id": "tpl_...",              // in place of an inline body
  "variables": {"name": "Ada"},
  "headers": {"X-Order": "4711"},
  "attachments": [{"filename": "receipt.pdf", "content_type": "application/pdf", "content": "<base64>"}],
  "tags": {"order": "4711"},
  "in_reply_to": "<message-id@host>",    // threads the reply
  "scheduled_at": "2026-09-01T09:00:00Z" // up to 30 days ahead
}
```

Responds `202` with the message, plus `skipped_recipients` (suppressed
addresses dropped under FR-4.4) and `internal_deliveries` (mailbox ids written
on the internal fast path).

## Agents and mailboxes

| Method | Path | Scope | Purpose |
|---|---|---|---|
| POST | `/v1/agents` | full | Create an agent |
| GET | `/v1/agents` | read | List agents |
| GET | `/v1/agents/{id}` | read | One agent |
| PATCH | `/v1/agents/{id}` | full | Update policy, capabilities, ceilings |
| DELETE | `/v1/agents/{id}` | full | Remove an agent and release its address |
| POST | `/v1/agents/{id}/keys` | full | Mint an agent-scoped key |
| GET | `/v1/agents/{id}/messages` | read | Mailbox, filtered by `state`, `thread_id`, `direction` |
| GET | `/v1/agents/{id}/messages/wait` | read | Long poll (`wait`, `claim`, `max`, `lease_seconds`, `worker`) |
| POST | `/v1/agents/{id}/messages/claim` | read | Claim with a lease |
| GET | `/v1/agents/{id}/messages/{mid}` | read | One message |
| POST | `/v1/agents/{id}/messages/{mid}/ack` | read | Finish a message |
| POST | `/v1/agents/{id}/messages/{mid}/release` | read | Hand a claim back |
| POST | `/v1/agents/{id}/messages/{mid}/archive` | read | Archive |
| POST | `/v1/agents/{id}/messages/{mid}/reply` | send | Reply in thread |
| GET | `/v1/agents/{id}/threads/{thread_id}` | read | Whole conversation, oldest first |
| GET | `/v1/directory` | read | Search published agents (`q`, `capability`, `limit`) |

## Domains

| Method | Path | Scope | Purpose |
|---|---|---|---|
| POST | `/v1/domains` | full | Add a sending domain, returns required DNS records |
| GET | `/v1/domains` | read | List |
| GET | `/v1/domains/{id}` | read | Status and records |
| POST | `/v1/domains/{id}/verify` | full | Re-check DNS and run the deliverability diagnostics |
| DELETE | `/v1/domains/{id}` | full | Remove |

`verify` returns per-record status plus `warnings` for the three
configurations that silently destroy delivery: a strict DMARC policy with
nothing aligned to satisfy it, more than one SPF record, and a MAIL FROM
subdomain with no MX.

## Keys, suppression, templates

| Method | Path | Scope |
|---|---|---|
| POST / GET | `/v1/api-keys` | full |
| DELETE | `/v1/api-keys/{id}` | full |
| GET / POST | `/v1/suppressions` | read / full |
| DELETE | `/v1/suppressions/{id}` | full |
| POST / GET | `/v1/templates` | full / read |
| PATCH / DELETE | `/v1/templates/{id}` | full |
| POST | `/v1/templates/{id}/preview` | read |

Complaint and hard-bounce suppressions cannot be deleted. Template syntax:
`{{path.to.value}}` is HTML-escaped, `{{{path.to.value}}}` is raw.

## Lists and campaigns

| Method | Path | Scope |
|---|---|---|
| POST / GET | `/v1/lists` | full / read |
| DELETE | `/v1/lists/{id}` | full |
| GET / POST | `/v1/lists/{id}/contacts` | read / full |
| POST | `/v1/lists/{id}/import` | full |
| POST / GET | `/v1/campaigns` | full / read |
| GET | `/v1/campaigns/{id}` | read |
| POST | `/v1/campaigns/{id}/send` | full |
| POST | `/v1/campaigns/{id}/test` | full |
| POST | `/v1/campaigns/{id}/cancel` | full |
| GET | `/v1/campaigns/{id}/stats` | read |

`import` takes `csv` (with a header row) or `contacts`, and reports
`imported`, `duplicates` and `rejected` rows with reasons. `GET
/v1/campaigns/{id}` includes `recipient_count` after suppression and
unsubscribe exclusions.

## Webhooks

| Method | Path | Scope |
|---|---|---|
| POST / GET | `/v1/webhooks` | full |
| DELETE | `/v1/webhooks/{id}` | full |
| GET | `/v1/webhooks/{id}/deliveries` | full |

The endpoint secret is returned once, on creation. Each delivery carries
`agentmail-signature: t=<unix>,v1=<hex>` where the HMAC-SHA256 covers
`"<t>.<body>"`. Verify with a constant-time comparison and reject timestamps
more than five minutes old. Failed deliveries retry with exponential backoff.

## Account

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/v1/account/usage` | read | Plan, agent namespace, sent today, daily limit, queue depth |
| GET | `/v1/audit` | full | Administrative and policy events |

## Public endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness, provider, queue depth, dead letters |
| POST | `/ingest/inbound` | `x-agentmail-ingest-secret` | Deliver an inbound message |
| POST | `/ingest/events` | `x-agentmail-ingest-secret` | Provider delivery, bounce and complaint events |
| GET / POST | `/u/{token}` | none | One-click unsubscribe |

## Event types

`accepted`, `queued`, `sent`, `delivered`, `bounced`, `complained`, `rejected`,
`opened`, `clicked`, `delayed`, `failed`, `skipped`, `received`, `claimed`,
`acked`.
