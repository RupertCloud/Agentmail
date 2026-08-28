# SRS traceability

Every requirement in [`SRS-silk-relay.md`](../SRS-silk-relay.md) v0.1 and in
[Amendment A](SRS-amendment-a-agents.md), against what is actually in this
repository. 116 requirements in the base document, 41 in the amendment.

**Done** — implemented and covered by a test.
**Partial** — the useful part works; the note says what is missing.
**Open** — not started.

Counts: **96 done · 21 partial · 40 open** across all 157.
The base document alone: 57 done, 19 partial, 40 open.

The wire format is additionally specified, vendor-neutrally, as
[ACCP](accp/SPEC.md); the implementation conforms to Core, Mailbox and
Directory.

The concentration of Open rows is not accidental. Everything requiring the AWS
control plane (SES identity provisioning, tenant creation, EventBridge), a
dashboard, or billing is deliberately absent — this is the API and its domain
logic, not the product. The rows that matter are the Partial ones, because a
half-built control is more dangerous than a missing one.

---

## 4.1 Accounts and authentication

| Req | State | Note |
|---|---|---|
| FR-1.1 | Open | No sign-up flow; accounts are created through the service API. Dashboard auth is out of scope here. |
| FR-1.2 | Open | No email verification gate. Domain verification (FR-2.5) is enforced instead, which is the control that protects deliverability. |
| FR-1.3 | Done | Account creation calls `CreateTenant` and every send is scoped to it. Not exercised against a live AWS account. |
| FR-1.4 | Partial | `users` carries the four roles; nothing enforces them, because every caller here authenticates with an API key rather than as a user. |
| FR-1.5 | Open | No invite flow. |

## 4.2 Domain verification

| Req | State | Note |
|---|---|---|
| FR-2.1 | Done | Three DKIM CNAMEs, MAIL FROM MX and TXT, and an SPF value, returned on `POST /v1/domains`. |
| FR-2.2 | Done | Creates the configuration set, the identity with Easy DKIM at 2048 bits, the custom MAIL FROM, and both tenant associations. The DKIM tokens published are the ones SES returned. |
| FR-2.3 | Partial | Verification requires DNS to resolve *and* SES to report the identity verified, and says so when they disagree. Polling is on demand, not a background loop. |
| FR-2.4 | Done | Strict DMARC with nothing aligned, multiple SPF records, and a MAIL FROM without MX are all detected and explained. |
| FR-2.5 | Done | Sending from an unverified domain is refused. |
| FR-2.6 | Done | The SES identity is deleted before the record is forgotten. |

## 4.3 API keys

| Req | State | Note |
|---|---|---|
| FR-3.1 | Done | `full`, `send`, `read`, plus `agent` from FR-20.1. |
| FR-3.2 | Done | Returned once, stored as a salted scrypt hash. |
| FR-3.3 | Done | Revocation takes effect on the next request. |
| FR-3.4 | Done | `last_used_at` updated per authenticated call. |
| FR-3.5 | Done | A domain-scoped key is refused when it sends from any other domain. |

## 4.4 Transactional sending

| Req | State | Note |
|---|---|---|
| FR-4.1 | Done | All listed fields, plus `structured` from FR-16.1. |
| FR-4.2 | Done | Batch capped at 100. |
| FR-4.3 | Open | No SMTP relay. Phase 3 in the SRS's own sequencing. |
| FR-4.4 | Done | Suppressed recipients are dropped and the skip is recorded. |
| FR-4.5 | Partial | Accepted, identified and delivered asynchronously — but the queue is in-process, so a restart loses queued work. Durability arrives with SQS. |
| FR-4.6 | Done | Scheduling works and is capped at 30 days. |
| FR-4.7 | Done | `Idempotency-Key` collapses a retried send. |
| FR-4.8 | Done | 40 MB ceiling enforced across all attachments. |

## 4.5 Templates

| Req | State | Note |
|---|---|---|
| FR-5.1 | Done | Editing bumps the version rather than rewriting it. |
| FR-5.2 | Done | `{{value}}` escaped, `{{{value}}}` raw, dot paths; documented in the API reference. |
| FR-5.3 | Done | Plain text generated from HTML when absent. |
| FR-5.4 | Done | `POST /v1/templates/{id}/preview`. |
| FR-5.5 | Done | `template_id` and `variables` in place of an inline body. |

## 4.6 Contacts and lists

| Req | State | Note |
|---|---|---|
| FR-6.1 | Done | |
| FR-6.2 | Done | Individually, by CSV, or by API. |
| FR-6.3 | Done | Address, name, custom fields, status, source. |
| FR-6.4 | Done | Syntax validated, rejected rows reported with reasons, duplicates counted. |
| FR-6.5 | Partial | `double_optin` holds contacts at `unconfirmed`; the confirmation email and click-through are not built. |
| FR-6.6 | Open | No segmentation. |
| FR-6.7 | Done | Unsubscribe applies to the list, records a timestamp and its source, and updates the contact. |
| FR-6.8 | Done | `GET /v1/lists/{id}/export` returns RFC 4180 CSV including custom columns. |

## 4.7 Suppression

| Req | State | Note |
|---|---|---|
| FR-7.1 | Done | Per account. |
| FR-7.2 | Done | Hard bounces suppress permanently and automatically. |
| FR-7.3 | Done | Complaints suppress permanently and automatically. |
| FR-7.4 | Done | Soft bounces suppress on the third failure. |
| FR-7.5 | Partial | Entries record the list they came from, but the suppression check is account-wide. List-scoped suppression is a query change, not a model change. |
| FR-7.6 | Done | View, search by address and reason, CSV export; complaint and hard-bounce entries refuse removal. |
| FR-7.7 | Open | The SES account-level list is not configured from here. |

## 4.8 Campaigns

| Req | State | Note |
|---|---|---|
| FR-8.1 | Partial | All fields except `domain_id`, which is accepted and unused. |
| FR-8.2 | Partial | Raw HTML only; the visual editor belongs to the dashboard. |
| FR-8.3 | Partial | Lists yes, saved segments no (FR-6.6). Suppressed and unsubscribed contacts are excluded. |
| FR-8.4 | Done | `recipient_count` reflects exclusions. |
| FR-8.5 | Partial | Immediate send works; `scheduled_at` is stored but no scheduler fires it, and there is no tenant timezone. |
| FR-8.6 | Done | Test send capped at five addresses. |
| FR-8.7 | Done | Unsubscribe link, `List-Unsubscribe` and `List-Unsubscribe-Post`. |
| FR-8.8 | Done | The fan-out checks campaign status between recipients, so pause and cancel take effect mid-send. |
| FR-8.9 | Open | No A/B testing. |
| FR-8.10 | Done | Separate campaign queue, always drained after transactional. |

## 4.9 Tracking and analytics

| Req | State | Note |
|---|---|---|
| FR-9.1 | Open | No open pixel. |
| FR-9.2 | Open | No click rewriting. |
| FR-9.3 | Done | `GET /v1/campaigns/{id}/stats` returns counts and rates. |
| FR-9.4 | Partial | `GET /v1/account/usage` gives today's volume and limits; no selectable windows or rate series. |
| FR-9.5 | Done | Message log filterable by recipient, status, kind, direction, thread, tag, free text and date, with full per-message event history. |
| FR-9.6 | Open | Retention is described in the migrations; nothing enforces it. |
| FR-9.7 | Open | No threshold warnings. |

## 4.10 Webhooks

| Req | State | Note |
|---|---|---|
| FR-10.1 | Done | HTTPS enforced, per-event-type subscription. |
| FR-10.2 | Done | HMAC-SHA256 over `"<timestamp>.<body>"`, documented, verified in tests. |
| FR-10.3 | Done | 24 attempts with a one-hour ceiling, spanning more than 24 hours. |
| FR-10.4 | Done | Delivery history and manual replay. |

## 4.11 Billing

| Req | State | Note |
|---|---|---|
| FR-11.1 – FR-11.8 | Open | No wallet, no mobile money, no invoices. Metering has a natural home — every accepted message already writes one row — but nothing is charged. |

## 4.12 Operations and abuse control

| Req | State | Note |
|---|---|---|
| FR-12.1 | Partial | New accounts start at a low daily limit and sending is refused past it. The automatic increase on clean history is not built. |
| FR-12.2 | Done | Enforced at send time. |
| FR-12.3 | Open | No automatic tenant pause on rate thresholds. A paused or suspended account is already refused everywhere, so this is a monitor away from working. |
| FR-12.4 | Partial | Account status is honoured throughout, but there is no admin API to set it. |
| FR-12.5 | Open | No signup screening. |
| FR-12.6 | Open | No EventBridge subscription. |
| FR-12.7 | Open | No content scanning. |
| FR-12.8 | Done | Account, key, domain, agent, suppression, webhook and inbound-rejection actions are recorded; the DDL grants no UPDATE or DELETE on the table. |

## 5. REST API

Every path in §5 exists, with these differences: `/emails/{id}` returns the
event history inline rather than as a sub-resource; templates, lists,
campaigns, suppressions and webhooks are as listed; and the surface is extended
with `/v1/agents/**`, `/v1/directory`, `/ingest/**` and `/u/{token}`.
Conventions — bearer auth, `Idempotency-Key`, cursor pagination, typed errors,
`X-RateLimit-*` and `429` with `Retry-After` — are implemented.

## 6. Data model

Implemented in `migrations/001_init.sql` with the amendment's additions. Monthly
partitioning of `messages` and `message_events` is in `002_partitions.sql`.
Rollup-before-drop and the exclusion of un-acked agent mail from partition drops
are documented there but not automated.

## 7. Non-functional requirements

| Req | State | Note |
|---|---|---|
| NFR-1.1 – NFR-1.4 | Open | Latency and scale targets are deployment properties; nothing here is benchmarked, and the in-memory store makes any number meaningless. |
| NFR-2.1 | Open | Availability is a deployment property. |
| NFR-2.2 | Partial | The worker never drops a job it holds — a lease returns it — but the queue itself is in-process. |
| NFR-2.3 | Done | Idempotency keys upstream, ack-on-success downstream; a retried job that already sent is skipped by status. |
| NFR-2.4 | Done | Exponential backoff on retryable provider errors, no loss. |
| NFR-2.5 | Done | Exhausted retries land in a dead letter queue and mark the message failed. |
| NFR-3.1 | Open | TLS terminates ahead of this process. |
| NFR-3.2 | Done | Salted scrypt, never logged, not retrievable. |
| NFR-3.3 | Open | Encryption at rest is a datastore property. |
| NFR-3.4 | Done | Every query is scoped by account, and an agent key is structurally confined to one mailbox. |
| NFR-3.5 | Done | Signed and documented. |
| NFR-3.6 | Open | No purge job. |
| NFR-3.7 | Partial | Per-key fixed-window limiting with headers; no per-IP limiting. |
| NFR-3.8 | Open | No admin console to protect. |
| NFR-4.1 | Open | The AUP is a document that does not exist yet. |
| NFR-4.2 | Partial | Unsubscribe is implemented; the sender's postal address is not collected or appended. |
| NFR-4.3 | Done | Unsubscribe is honoured immediately. |
| NFR-4.4 – NFR-4.5 | Open | Legal instruments, not code. |
| NFR-4.6 | Done | Contacts carry source and confirmation timestamp. |
| NFR-4.7 | Partial | Export exists (FR-6.8); deletion on request does not. |
| NFR-5.1 | Partial | Requests carry a request id; there is no structured logger or correlation across the worker. |
| NFR-5.2 | Partial | Queue depth and dead letter counts on `/health` and `/v1/account/usage`; no metrics export. |
| NFR-5.3 | Open | No alerting. |
| NFR-5.4 | Open | No status page. |

## 8. Deliverability

| Req | State | Note |
|---|---|---|
| DR-1 | Done | `NextSigningKeyLength: RSA_2048_BIT` on identity creation. |
| DR-2 | Done | Custom MAIL FROM set with `BehaviorOnMxFailure: REJECT_MESSAGE`, so a broken MX fails loudly rather than silently breaking SPF alignment. |
| DR-3 | Done | The DMARC warning is the sharpest of the three diagnostics and is explained in the response. |
| DR-4 | Open | Pool policy is an SES-side decision. |
| DR-5 | Open | No warmup. |
| DR-6 | Partial | Bounce and complaint events are visible per message; there is no rate view. |
| DR-7 | Open | No hygiene tooling. |

## Amendment A

| Req | State | Note |
|---|---|---|
| FR-13.1 – FR-13.5 | Done | Hosted addressing with no DNS, own-domain option, capability tags, address released on delete. |
| FR-14.1 – FR-14.6 | Done | Lease lifecycle including expiry and redelivery, ack, release, and a long poll capped at 60 seconds. |
| FR-14.7 | Partial | An agent's `webhook_url` is stored but not yet dispatched to; account-level webhooks carry `received` events in the meantime. Polling, which the requirement says must always work, does. |
| FR-15.1 – FR-15.4 | Done | Routing, internal delivery, mixed recipients, unified logging. |
| NFR-A1 | Partial | Internal delivery is a synchronous write and a notifier wake, comfortably inside the budget; not benchmarked. |
| FR-16.1 – FR-16.4 | Done | Payload preserved internally, carried as an `application/accp+json` part externally, prose generated when absent. |
| FR-17.1 – FR-17.4 | Done | Header-based threading with a subject fallback, account-scoped, whole-thread read, reply endpoint. |
| FR-18.1 – FR-18.5 | Done | Four policies, `verified` default, audited rejections, opt-in directory searchable by capability. |
| FR-19.1 – FR-19.5 | Done | Hop counter and ceiling, per-thread rate ceiling, refusals surfaced as errors, agent traffic counted against the account limit. |
| FR-20.1 – FR-20.3 | Done | Agent scope, confined reach, independent revocation. |
| FR-21.1 – FR-21.3 | Done | Eleven tools over stdio, agent-scoped auth, the claim/ack contract stated in the descriptions. |

---

## What I would build next, in order

1. **The Postgres store.** Everything above is a development toy until state
   survives a restart. The port and schema exist; this is mechanical work.
2. **SQS queues** (NFR-2.2, FR-4.5). Same reasoning, second because the queue
   is smaller than the store.
3. **Run the SES path against a live account.** The control plane is wired and
   its shapes are verified against the SDK's types, but it has never touched
   the service. Expect the first real run to find something.
4. **The inbound Lambda and the SNS adapter.** `/ingest/inbound` and
   `/ingest/events` are finished and tested; nothing yet calls them from AWS.
5. **Auto-pause on reputation thresholds** (FR-12.3, FR-9.7). The cheapest
   remaining protection against R-2, the existential risk in the SRS.
6. **Per-agent push** (FR-14.7) and **list-scoped suppression** (FR-7.5) — the
   two Partial rows that are closest to done.
