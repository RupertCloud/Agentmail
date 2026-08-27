# Software Requirements Specification
## Silk Relay — Email Delivery Platform

| | |
|---|---|
| **Version** | 0.1 (draft) |
| **Date** | 27 August 2026 |
| **Author** | Amon Nyesigye |
| **Status** | For review |

> **Working name.** "Silk Relay" is a placeholder chosen to sit alongside Silk NOVA. Replace
> throughout before this document circulates. Earlier candidate: "Email Guru".

---

## 1. Introduction

### 1.1 Purpose

This document specifies the requirements for Silk Relay, a multi-tenant email delivery
platform built on Amazon Simple Email Service (SES). It is intended for the engineering
team implementing the system, and as the reference against which delivery is verified.

### 1.2 Scope

Silk Relay provides two capabilities to paying customers:

1. **Transactional email** — an HTTP API and SMTP relay for automated, one-to-one messages
   triggered by application events (verification, password reset, receipts, alerts).
2. **Campaigns** — a dashboard for managing contact lists and sending one-to-many broadcasts
   (newsletters, product announcements) with tracking and unsubscribe handling.

Both run on shared infrastructure, with per-customer isolation provided by SES Tenants.

The platform's differentiator is the market it serves: developers and businesses in Uganda
and East Africa, billed in mobile money, supported in local business hours. Resend, Mailgun
and Postmark are card-only and timezone-hostile to this market.

**Out of scope for this specification:** inbound email processing, SMS or push channels,
marketing automation (multi-step drip sequences), and CRM functionality. These are noted in
§11 as candidates for later versions.

### 1.3 Definitions

| Term | Meaning |
|---|---|
| **Tenant** | A customer account. Maps 1:1 to an SES Tenant resource. |
| **Identity** | A domain or email address verified for sending, owned by a tenant. |
| **Transactional message** | A single message sent to one recipient, triggered by an application event. |
| **Campaign** | A message composed in the dashboard and sent to many recipients from a list. |
| **Suppression** | A record preventing further sending to an address. |
| **Hard bounce** | Permanent delivery failure (address does not exist). |
| **Complaint** | Recipient marked the message as spam via their provider's feedback loop. |
| **Configuration set** | SES resource grouping event publishing and tracking options. |
| **AUP** | Acceptable Use Policy. |

### 1.4 References

- [Amazon SES Tenants documentation](https://docs.aws.amazon.com/ses/latest/dg/tenants.html)
- [SES tenant isolation and automated reputation policies (Aug 2025)](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)
- CAN-SPAM Act (US), GDPR (EU), Uganda Data Protection and Privacy Act 2019

---

## 2. Overall description

### 2.1 Product perspective

Silk Relay is a layer over SES, not a mail transfer agent. It never operates its own MTA or
IP reputation from scratch. AWS handles the sending infrastructure, IP warmth, and provider
relationships; Silk Relay provides the API, dashboard, list management, templating, billing,
and tenant isolation.

This is the same architecture as Resend, which runs on SES. It is a deliberate rejection of
the self-hosted-MTA approach (Postal, Mailcow), which would require owning IP reputation,
blocklist delisting, and 24/7 deliverability operations for no cost advantage.

```
Customer app ──HTTP/SMTP──▶ Silk Relay API ──▶ Queue ──▶ Workers ──▶ SES ──▶ Recipient
                                   │                                   │
                            Dashboard (Next.js)                  Events (SNS)
                                   │                                   │
                                   └───────── Postgres ◀───────────────┘
```

### 2.2 User classes

| Class | Description | Primary needs |
|---|---|---|
| **Developer** | Integrates the API into their application | Fast onboarding, clear docs, SDK, reliable delivery, visible logs |
| **Marketer** | Uses the dashboard to send campaigns | Contact management, composer, scheduling, open/click reporting |
| **Account owner** | Pays the bill | Usage visibility, mobile money top-up, invoices |
| **Platform operator** | Silk staff | Abuse review, tenant suspension, reputation monitoring, support |

### 2.3 Operating environment

- **Frontend / dashboard:** Next.js, TypeScript, ShadCN (consistent with existing portfolio)
- **API:** Node/TypeScript
- **Datastore:** PostgreSQL — see §3.2 for the rationale and the deviation it represents
- **Queue:** Amazon SQS
- **Sending:** Amazon SES (SESv2 API) with Tenants
- **Region:** Single AWS region initially. SES Tenants are region-scoped and do not replicate.

### 2.4 Constraints

- **C-1.** SES sending quotas apply at the AWS account level. Total platform throughput is
  bounded by the account's quota, which must be raised ahead of customer growth.
- **C-2.** SES Tenants are region-specific. Multi-region requires duplicated tenant setup.
- **C-3.** Default quota is 10,000 tenants per account, raisable to 300,000.
- **C-4.** Mobile money APIs (MTN MoMo, Airtel Money) have their own availability and
  settlement characteristics that the billing design must tolerate.
- **C-5.** The AWS account's standing depends on aggregate bounce and complaint rates.
  Abuse controls are a survival requirement, not a feature.

### 2.5 Assumptions

- **A-1.** The SES account is in production mode with quotas raised appropriately.
- **A-2.** Customers own the domains they send from and can edit their DNS.
- **A-3.** Initial volume is low enough that a shared IP pool is correct; dedicated IPs are a
  later, opt-in feature.
- **A-4.** Mobile money integration is available via existing Silk payment infrastructure.

---

## 3. System architecture

### 3.1 Tenant isolation model

This is the foundation of the design. Every customer maps to an SES Tenant.

| Silk Relay concept | SES resource |
|---|---|
| Customer account | Tenant |
| Customer's verified domain | Identity, associated to that tenant (dedicated) |
| Customer's event tracking config | Configuration set, associated to that tenant (dedicated) |

Every send specifies `TenantName` (API) or the `X-SES-TENANT` header (SMTP). SES validates
that the tenant is permitted to use the identity, configuration set, and template, and
rejects the send otherwise.

**Reputation policy: `Standard` for all tenants.** SES automatically pauses a tenant when a
high-severity reputation finding appears — excessive bounces, complaints, blocklist
appearance. This contains a bad customer to their own tenant instead of letting them degrade
delivery for everyone or endanger the AWS account.

Silk Relay subscribes to EventBridge for tenant status changes so the dashboard and the
operations team see a pause the moment it happens.

> **Why this matters:** before SES Tenants existed, building a multi-tenant sender meant one
> abusive customer could get the entire AWS account suspended, taking every customer offline.
> That risk was the strongest argument against building this product. SES Tenants removes it
> as a native platform feature.

### 3.2 Datastore decision — deviation from the standard stack

**The portfolio standard is Next.js + Firebase. This specification recommends PostgreSQL instead.**

Reasoning:

- An email platform writes one row per message and several rows per message *event* (sent,
  delivered, bounced, opened, clicked). At 1M messages/month that is several million
  append-only rows per month.
- Every dashboard view is an aggregate query over that data, sliced by tenant and time
  window. Firestore has no efficient aggregation; it would require maintaining denormalised
  counters for every dimension anyone might filter by, and each new report means a new
  counter and a backfill.
- Per-document read pricing makes log browsing — a core feature developers expect — costly
  and slow.
- Postgres handles this natively with indexes and time-bucketed aggregates, and partitioning
  handles retention cleanly.

Firebase Auth may still be used for dashboard sign-in if consistency with other Silk products
is wanted. That is orthogonal to the choice of primary datastore.

**This deviation should be confirmed before implementation begins.**

### 3.3 Send pipeline

Two queues, deliberately separated:

- **`transactional` queue (high priority)** — API-submitted single messages.
- **`campaign` queue (low priority)** — fan-out from campaign sends.

A single worker pool consumes both, always draining `transactional` first.

**Rationale:** without separation, a customer sending a 500,000-recipient campaign would sit
in front of every password reset on the platform. Password resets are time-critical and
campaigns are not. This separation is a hard requirement, not an optimisation.

```
POST /v1/emails ──▶ validate ──▶ suppression check ──▶ transactional queue ─┐
                                                                            ├─▶ worker ──▶ SES
campaign send ──▶ materialise recipients ──▶ batch ──▶ campaign queue ──────┘
```

### 3.4 Event ingestion

```
SES ──▶ Configuration set event destination ──▶ SNS ──▶ SQS ──▶ event worker ──▶ Postgres
```

Events consumed: Send, Delivery, Bounce, Complaint, Reject, Open, Click, DeliveryDelay,
RenderingFailure.

Bounces and complaints additionally write to the suppression table (§4.7).

---

## 4. Functional requirements

### 4.1 Accounts and authentication

- **FR-1.1** A user shall register with email and password, or via Google OAuth.
- **FR-1.2** Email address verification shall be required before any sending is permitted.
- **FR-1.3** An account shall map to exactly one SES Tenant, created automatically on
  registration.
- **FR-1.4** An account shall support multiple team members with roles: Owner, Developer,
  Marketer, Viewer.
- **FR-1.5** Owners shall be able to invite, remove, and change the role of team members.

### 4.2 Domain verification

- **FR-2.1** A tenant shall add a sending domain and receive the DNS records required to
  verify it: three Easy DKIM CNAMEs, a custom MAIL FROM MX and TXT, and a recommended SPF value.
- **FR-2.2** The system shall create the SES identity, enable Easy DKIM (RSA_2048), configure
  a custom MAIL FROM subdomain, and associate the identity with the tenant.
- **FR-2.3** The system shall poll verification status and surface it in the dashboard as
  Pending, Verified, or Failed, per record.
- **FR-2.4** The system shall detect and warn about the specific misconfigurations that break
  delivery: a DMARC policy at `quarantine` or `reject` with no aligned SPF or DKIM; more than
  one SPF TXT record on a domain; and a MAIL FROM subdomain missing its MX record.
- **FR-2.5** Sending from an unverified domain shall be rejected with a clear error.
- **FR-2.6** A tenant shall be able to remove a domain, which removes the tenant resource
  association before deleting the identity.

### 4.3 API keys

- **FR-3.1** A tenant shall create named API keys with a scope of Full, Sending only, or
  Read only.
- **FR-3.2** A key shall be displayed exactly once at creation and stored only as a hash.
- **FR-3.3** A key shall be revocable, with immediate effect.
- **FR-3.4** The dashboard shall display each key's last-used timestamp.
- **FR-3.5** Keys shall be scopeable to a single sending domain.

### 4.4 Transactional sending

- **FR-4.1** The system shall expose `POST /v1/emails` accepting `from`, `to`, `cc`, `bcc`,
  `reply_to`, `subject`, `html`, `text`, `headers`, `attachments`, and `tags`.
- **FR-4.2** The system shall expose `POST /v1/emails/batch` accepting up to 100 messages per
  request.
- **FR-4.3** The system shall provide an SMTP relay as an alternative to the HTTP API,
  authenticating with API key credentials.
- **FR-4.4** Every send shall check the tenant's suppression list first and silently skip
  suppressed recipients, recording the skip.
- **FR-4.5** The system shall accept a message, return an ID, and deliver asynchronously.
  A queued message shall not be lost on worker restart.
- **FR-4.6** The system shall support scheduled sending up to 30 days ahead.
- **FR-4.7** The system shall support idempotency keys to prevent duplicate sends on retry.
- **FR-4.8** Attachments shall be supported up to the SES limit of 40 MB per message.

### 4.5 Templates

- **FR-5.1** A tenant shall create, edit, version, and delete named templates.
- **FR-5.2** Templates shall support variable substitution with a documented syntax.
- **FR-5.3** A template shall have both an HTML and a plain-text body. If plain text is
  absent, the system shall generate it from the HTML.
- **FR-5.4** The system shall render a preview with sample data before sending.
- **FR-5.5** The API shall accept `template_id` and `variables` in place of an inline body.

### 4.6 Contacts and lists (campaigns)

- **FR-6.1** A tenant shall create named contact lists.
- **FR-6.2** Contacts shall be added individually, via CSV import, or via API.
- **FR-6.3** A contact shall carry an email address, optional name, arbitrary custom fields,
  a subscription status, and a source record.
- **FR-6.4** CSV import shall validate address syntax, report rejected rows with reasons, and
  deduplicate against the existing list.
- **FR-6.5** The system shall support double opt-in: an import or signup may be configured to
  send a confirmation email, with the contact remaining unconfirmed until they click through.
- **FR-6.6** Contacts shall be segmentable by custom field values, engagement (opened or
  clicked within N days), and subscription date.
- **FR-6.7** Unsubscribing shall apply at list level and be recorded with a timestamp and source.
- **FR-6.8** A tenant shall export any list as CSV.

### 4.7 Suppression

- **FR-7.1** The system shall maintain a per-tenant suppression list.
- **FR-7.2** Hard bounces shall be suppressed permanently and automatically.
- **FR-7.3** Complaints shall be suppressed permanently and automatically.
- **FR-7.4** Soft bounces shall be retried at most twice before suppression.
- **FR-7.5** Manual unsubscribes shall be suppressed for the relevant list; global
  unsubscribes shall be suppressed account-wide.
- **FR-7.6** A tenant shall view, search, export, and — for soft bounces and manual entries
  only — remove suppression entries. Complaint suppressions shall not be removable.
- **FR-7.7** The SES account-level suppression list shall be enabled as a second layer.

### 4.8 Campaigns

- **FR-8.1** A tenant shall create a campaign with a name, sending domain, from address,
  reply-to, subject, preview text, and body.
- **FR-8.2** The body shall be composable either in a visual editor or as raw HTML.
- **FR-8.3** A campaign shall target one or more lists or a saved segment, with suppressed and
  unsubscribed contacts excluded automatically.
- **FR-8.4** The system shall show an accurate recipient count before sending.
- **FR-8.5** A campaign shall be sendable immediately or scheduled, with the tenant's timezone
  respected.
- **FR-8.6** A test send to up to five addresses shall be possible without consuming the campaign.
- **FR-8.7** Every campaign email shall include a working unsubscribe link and the
  `List-Unsubscribe` and `List-Unsubscribe-Post` headers.
- **FR-8.8** A scheduled or in-progress campaign shall be pausable and cancellable.
- **FR-8.9** The system shall support A/B testing of subject lines across a configurable
  percentage of recipients, sending the winner to the remainder.
- **FR-8.10** Campaign sends shall be rate-limited to the tenant's configured throughput and
  shall never starve the transactional queue.

### 4.9 Tracking and analytics

- **FR-9.1** Open tracking shall be implemented as a pixel served from a per-tenant tracking
  subdomain, and shall be disableable per tenant and per campaign.
- **FR-9.2** Click tracking shall rewrite links through a per-tenant tracking subdomain, and
  shall be disableable per tenant and per campaign.
- **FR-9.3** The dashboard shall show, per campaign: sent, delivered, bounced, complained,
  opened, clicked, unsubscribed — as counts and rates.
- **FR-9.4** The dashboard shall show account-level delivery, bounce, and complaint rates over
  selectable time windows.
- **FR-9.5** The system shall provide a searchable message log with per-message event history,
  filterable by recipient, status, tag, and date.
- **FR-9.6** Message log retention shall be tiered by plan, with a documented minimum of 30 days.
- **FR-9.7** The system shall warn a tenant when their bounce rate exceeds 3% or complaint
  rate exceeds 0.08%, ahead of AWS thresholds.

### 4.10 Webhooks

- **FR-10.1** A tenant shall register HTTPS webhook endpoints for selected event types.
- **FR-10.2** Payloads shall be signed with a per-endpoint secret; the signature scheme shall
  be documented.
- **FR-10.3** Failed deliveries shall be retried with exponential backoff for up to 24 hours.
- **FR-10.4** The dashboard shall show recent webhook deliveries and allow manual replay.

### 4.11 Billing

- **FR-11.1** Billing shall operate on a prepaid wallet model: the tenant tops up, sends
  deduct from the balance.
- **FR-11.2** Top-up shall be supported via MTN Mobile Money, Airtel Money, and card.
- **FR-11.3** Balance shall be displayed in the tenant's chosen currency, with UGX and USD
  supported at launch.
- **FR-11.4** The system shall meter every accepted message and deduct at the tenant's rate.
- **FR-11.5** The system shall notify the tenant at configurable low-balance thresholds and
  support optional auto top-up.
- **FR-11.6** Sending shall be blocked at zero balance, with transactional and campaign
  sending blocked independently if the tenant configures a reserve for transactional.
- **FR-11.7** The system shall generate downloadable invoices and a transaction history.
- **FR-11.8** A free tier shall be available with a documented daily cap.

> **Design note.** The prepaid wallet is chosen over subscriptions because mobile money is a
> push-payment instrument — recurring card-style auto-debit is unreliable. This also matches
> the wallet model already used in Silk NOVA.

### 4.12 Operations and abuse control

- **FR-12.1** New tenants shall start with a low sending limit that increases automatically
  as clean sending history accumulates.
- **FR-12.2** No tenant shall send to any recipient before completing domain verification.
- **FR-12.3** The system shall auto-pause a tenant whose bounce rate exceeds 5% or complaint
  rate exceeds 0.3% over a rolling window, independently of SES's own policy.
- **FR-12.4** Operators shall have an admin console to inspect, pause, resume, rate-limit, and
  terminate tenants.
- **FR-12.5** Signups shall be screened for abuse indicators — disposable email domains,
  known-bad payment instruments, high-velocity registration from one source.
- **FR-12.6** The system shall subscribe to SES reputation findings via EventBridge and
  surface them to operators within one minute.
- **FR-12.7** Outbound content shall be scanned for phishing indicators, with matches routed
  to a manual review queue rather than blocked outright.
- **FR-12.8** Every administrative action shall be recorded in an immutable audit log.

---

## 5. External interface — REST API

Base: `https://api.<domain>/v1` · Auth: `Authorization: Bearer <api_key>`

| Method | Path | Purpose |
|---|---|---|
| POST | `/emails` | Send a transactional message |
| POST | `/emails/batch` | Send up to 100 messages |
| GET | `/emails/{id}` | Retrieve a message and its events |
| GET | `/emails` | List and filter messages |
| POST | `/domains` | Add a sending domain |
| GET | `/domains/{id}` | Verification status and required records |
| DELETE | `/domains/{id}` | Remove a domain |
| GET/POST/PATCH/DELETE | `/templates` | Manage templates |
| GET/POST/PATCH/DELETE | `/lists` | Manage contact lists |
| GET/POST/PATCH/DELETE | `/lists/{id}/contacts` | Manage contacts |
| POST | `/lists/{id}/import` | Bulk CSV import |
| GET/POST/PATCH/DELETE | `/campaigns` | Manage campaigns |
| POST | `/campaigns/{id}/send` | Send or schedule |
| POST | `/campaigns/{id}/test` | Test send |
| POST | `/campaigns/{id}/cancel` | Cancel |
| GET | `/campaigns/{id}/stats` | Campaign metrics |
| GET/POST/DELETE | `/suppressions` | Manage suppression list |
| GET/POST/DELETE | `/webhooks` | Manage webhook endpoints |
| GET | `/account/usage` | Usage and balance |

**Conventions.** JSON request and response bodies. Idempotency via the `Idempotency-Key`
header on all POST operations. Cursor pagination. Errors return a machine-readable `type`,
a human-readable `message`, and where applicable the offending field. Rate limits are
communicated via `X-RateLimit-*` response headers and a `429` with `Retry-After`.

---

## 6. Data model

Core tables. Names indicative.

| Table | Key columns | Notes |
|---|---|---|
| `accounts` | id, name, ses_tenant_name, status, plan, created_at | One row per customer |
| `users` | id, account_id, email, role, auth_provider | Team members |
| `api_keys` | id, account_id, name, key_hash, scope, domain_id, last_used_at, revoked_at | Hash only |
| `domains` | id, account_id, domain, ses_identity_arn, config_set_name, mail_from_subdomain, dkim_status, verified_at | |
| `templates` | id, account_id, name, version, subject, html, text | Versioned |
| `lists` | id, account_id, name, double_optin, created_at | |
| `contacts` | id, list_id, email, name, custom_fields (jsonb), status, confirmed_at, source | Unique on (list_id, email) |
| `campaigns` | id, account_id, name, domain_id, subject, html, text, status, scheduled_at, list_ids, segment_id | |
| `messages` | id, account_id, campaign_id, to_email, subject, status, ses_message_id, created_at | **Partitioned by month** |
| `message_events` | id, message_id, type, occurred_at, metadata (jsonb) | **Partitioned by month**; highest-volume table |
| `suppressions` | id, account_id, email, reason, list_id, created_at | Unique on (account_id, email) |
| `webhooks` | id, account_id, url, secret, event_types, active | |
| `webhook_deliveries` | id, webhook_id, event_id, status, attempts, last_attempt_at | |
| `wallet_transactions` | id, account_id, type, amount, currency, provider, provider_ref, balance_after | Append-only ledger |
| `audit_log` | id, actor, action, target, metadata, occurred_at | Immutable |

**Retention.** `messages` and `message_events` partitions are dropped per the plan's retention
period. Aggregate rollups are computed into a summary table before partition drop so historical
reporting survives detail expiry.

---

## 7. Non-functional requirements

### 7.1 Performance

- **NFR-1.1** `POST /v1/emails` shall return within 200 ms at p95, measured at the API edge.
- **NFR-1.2** A transactional message shall be handed to SES within 5 seconds of acceptance
  at p95 under normal load.
- **NFR-1.3** The system shall sustain 100 messages/second at launch, with a documented path
  to 1,000/second.
- **NFR-1.4** Dashboard views shall render within 2 seconds at p95 for accounts with up to
  10 million historical messages.

### 7.2 Reliability

- **NFR-2.1** API availability target: 99.9% monthly.
- **NFR-2.2** An accepted message shall never be lost. Queue persistence and worker restart
  shall not drop work.
- **NFR-2.3** A message shall never be delivered twice as a result of internal retry.
- **NFR-2.4** SES throttling shall be handled with exponential backoff, not message loss.
- **NFR-2.5** Failures that exhaust retries shall land in a dead letter queue with alerting.

### 7.3 Security

- **NFR-3.1** All external traffic over TLS 1.2 or higher.
- **NFR-3.2** API keys stored as salted hashes; never logged, never retrievable after creation.
- **NFR-3.3** Data encrypted at rest.
- **NFR-3.4** Every query shall be scoped by account; cross-tenant access shall be structurally
  prevented, not merely checked.
- **NFR-3.5** Webhook payloads signed; signature verification documented for customers.
- **NFR-3.6** Message bodies containing personal data shall be purged on the retention schedule.
- **NFR-3.7** Rate limiting per API key and per IP.
- **NFR-3.8** Admin console access shall require multi-factor authentication.

### 7.4 Compliance

- **NFR-4.1** The AUP shall prohibit unsolicited email, purchased lists, and scraped contact
  data, and shall be enforced, not merely published.
- **NFR-4.2** Every campaign message shall carry a working unsubscribe mechanism and the
  sender's physical postal address, as CAN-SPAM requires.
- **NFR-4.3** Unsubscribe requests shall be honoured within 24 hours; CAN-SPAM allows 10 days,
  and this requirement is deliberately stricter.
- **NFR-4.4** The platform shall act as a data processor, offering a Data Processing Agreement
  covering GDPR obligations.
- **NFR-4.5** Processing shall comply with the Uganda Data Protection and Privacy Act 2019,
  including lawful basis for processing and data subject rights.
- **NFR-4.6** Contact records shall retain evidence of consent — source, timestamp, and
  opt-in method — and expose it on request.
- **NFR-4.7** A data export and deletion mechanism shall be available to tenants for their
  contacts' data subject requests.

### 7.5 Observability

- **NFR-5.1** Structured logging with correlation IDs across API, queue, and worker.
- **NFR-5.2** Metrics for queue depth, send latency, SES error rates, per-tenant volume.
- **NFR-5.3** Alerting on: queue depth breach, DLQ arrivals, SES throttling, account-level
  bounce or complaint rates approaching AWS thresholds, tenant auto-pause events.
- **NFR-5.4** A status page reflecting real service health.

---

## 8. Deliverability requirements

- **DR-1** Every tenant domain shall use Easy DKIM with a 2048-bit key.
- **DR-2** Every tenant domain shall use a custom MAIL FROM subdomain, so that SPF aligns for
  DMARC and not only DKIM.
- **DR-3** The onboarding flow shall check the tenant's existing DMARC record and warn
  explicitly when a `quarantine` or `reject` policy is in place without aligned authentication
  — the configuration that silently sends all mail to spam.
- **DR-4** Shared IP pools at launch; dedicated IPs offered above a documented volume threshold
  where they help rather than hurt.
- **DR-5** A tenant crossing a volume threshold onto a dedicated IP shall be warmed
  automatically on a documented schedule.
- **DR-6** Bounce and complaint rates shall be visible to tenants in the dashboard, not just
  to operators.
- **DR-7** List hygiene tooling: flag addresses that have not engaged in 12 months, and
  surface syntactically invalid or role-based addresses at import.

---

## 9. Abuse prevention

This section exists because it is the difference between a working business and a suspended
AWS account. It is not optional scope.

| Control | Requirement |
|---|---|
| Progressive limits | New tenants start at 100 messages/day, increasing on clean history |
| Domain proof | No sending before DKIM verification completes |
| Payment signal | Free tier capped hard; a top-up is a meaningful trust signal |
| Content scanning | Phishing and credential-harvesting patterns route to manual review |
| Velocity checks | Signup and send-rate anomalies flag for review |
| Tenant isolation | SES Tenants with `Standard` reputation policy on every tenant |
| Kill switch | Operators can pause any tenant, or all sending, within seconds |
| List provenance | Bulk imports over a threshold require the tenant to attest to consent source |

**Policy position.** Cold email is prohibited by the AUP. This is not a moral stance but an
infrastructural one: SES's own acceptable use policy forbids unsolicited bulk commercial email,
and permitting it would put the AWS account — and therefore every customer — at risk. Customers
wanting cold outreach must be directed to tools that connect their own mailboxes, which is a
categorically different architecture.

---

## 10. Delivery phasing

The specification covers both transactional and campaigns, as requested. Delivery should still
be sequenced, because campaigns depend on infrastructure that transactional sending establishes.

**Phase 1 — Transactional foundation**
Accounts, SES tenant provisioning, domain verification, API keys, `POST /v1/emails`, suppression,
event ingestion, message log, wallet billing, admin console with kill switch.
*Exit criterion: a developer can sign up, verify a domain, send via API, and see the result.*

**Phase 2 — Campaigns**
Lists, contacts, CSV import, double opt-in, templates and composer, campaign send, scheduling,
unsubscribe handling, open and click tracking, campaign analytics.
*Exit criterion: a marketer can import a list, compose, send, and read the results.*

**Phase 3 — Scale and trust**
SMTP relay, webhooks, segmentation, A/B testing, dedicated IPs with automated warmup, team
roles, DPA and compliance tooling, public status page.

Phase 1 is the revenue-bearing minimum. Phase 2 is what makes it competitive with Mailchimp for
this market. Phase 3 is what makes it credible to a customer with real volume.

---

## 11. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | Abusive customer damages account reputation | Severe — platform-wide | SES Tenants with Standard policy; §9 controls; progressive limits |
| R-2 | AWS suspends the account despite tenant isolation | Existential | Aggressive internal thresholds below AWS's; operator alerting; documented incident response |
| R-3 | Mobile money integration unreliable | Revenue interruption | Card fallback; prepaid model tolerates settlement delay |
| R-4 | Deliverability perceived as worse than incumbents | Adoption failure | Enforce DR-1 to DR-3; publish delivery metrics; shared pool hygiene |
| R-5 | Postgres deviation rejected in favour of Firebase | Rework, or poor analytics performance | Resolve §3.2 before implementation starts |
| R-6 | Market too small to sustain the build | Sunk cost | Validate with paying customers before Phase 2; Phase 1 is deliberately small |
| R-7 | Attention diverted from Silk NOVA | Opportunity cost | Sequence explicitly; do not run both builds concurrently |

---

## 12. Open questions

1. **Product name.** "Silk Relay" is a placeholder.
2. **Datastore.** Postgres as recommended in §3.2, or Firebase for portfolio consistency?
3. **Pricing.** Per-message rate, free tier cap, and margin over the SES cost of $0.10/1,000.
4. **Region.** Which AWS region — latency to East Africa versus SES feature availability.
5. **Launch market.** Uganda only at first, or East Africa from the start?
6. **Existing Silk payment infrastructure.** Can Nova's mobile money integration be reused
   directly, or does this need its own?
7. **Support model.** What response times are promised, and who answers?

---

*End of specification.*
