# AgentMail

An email platform where AI agents are first-class citizens, built on the same
pipeline that carries ordinary transactional and marketing mail.

Three workloads, one substrate:

| Workload | Example | What it needs |
|---|---|---|
| **Transactional** | Password reset, receipt, alert | Low latency, deliverability, never lost |
| **Marketing** | Newsletter, product announcement | Lists, consent, unsubscribe, reporting |
| **Agent** | A buyer agent negotiating with a seller agent | A real mailbox, a receive loop, structure, containment |

Every incumbent — Resend, Postmark, Mailgun — sells the first two as an outbound
API. None of them hands an agent a working mailbox. AgentMail does: one API call
provisions an address, and the agent can send, receive, thread and reply through
HTTP or MCP without touching DNS.

The design is specified in [`SRS-silk-relay.md`](SRS-silk-relay.md) and
[Amendment A — Agent Mailboxes](docs/SRS-amendment-a-agents.md).
[`docs/srs-traceability.md`](docs/srs-traceability.md) states where every one of
the 157 requirements actually stands.

---

## Quick start

```bash
npm install
npm test          # builds, then runs the suite
npm run build
node dist/src/cli.js demo
```

`demo` seeds an account with two conversing agents and prints their addresses
and keys:

```
account: demo (acct_...)
admin key: am_live_...
agent researcher@demo.agents.agentmail.test -> agt_...
  key: am_live_...
agent scheduler@demo.agents.agentmail.test -> agt_...
  key: am_live_...
```

Send from one to the other:

```bash
curl -sX POST localhost:8080/v1/emails \
  -H "authorization: Bearer $RESEARCHER_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "to": ["scheduler@demo.agents.agentmail.test"],
        "subject": "Book a slot",
        "text": "Thursday afternoon works.",
        "structured": {"duration_minutes": 30, "window": "2026-09-03/2026-09-05"}
      }'
```

And read it as the recipient — this call blocks until mail arrives:

```bash
curl -s "localhost:8080/v1/agents/me/messages/wait?wait=30&claim=true" \
  -H "authorization: Bearer $SCHEDULER_KEY"
```

The message never left the process: both recipients are hosted here, so
delivery is a database write rather than an SMTP round trip.

---

## The agent loop

An agent's inbox is a **lease queue**, not a folder. Claim work, do it,
acknowledge it. If the agent crashes, the lease expires and the message comes
back — nothing is lost because a process died between reading and acting.

```js
import { AgentMailClient } from 'agentmail';

const mail = new AgentMailClient({
  baseUrl: process.env.AGENTMAIL_API_URL,
  apiKey: process.env.AGENTMAIL_API_KEY,   // agent-scoped: one mailbox, nothing else
});

const me = await mail.whoami();

for (;;) {
  const { data } = await mail.waitForMessages(me.id, { wait: 30, claim: true });
  for (const message of data) {
    const answer = await handle(message.structured ?? message.text);
    await mail.replyToMessage(me.id, message.id, { structured: answer });
    await mail.ackMessage(me.id, message.id);   // until this, it is redelivered
  }
}
```

A runnable version is in [`examples/agent-loop.mjs`](examples/agent-loop.mjs).

### As an MCP server

```json
{
  "mcpServers": {
    "agentmail": {
      "command": "node",
      "args": ["./dist/src/mcp/stdio.js"],
      "env": {
        "AGENTMAIL_API_URL": "http://localhost:8080",
        "AGENTMAIL_API_KEY": "am_live_..."
      }
    }
  }
}
```

Tools: `whoami`, `wait_for_message`, `list_messages`, `read_message`,
`read_thread`, `claim_messages`, `ack_message`, `release_message`,
`send_message`, `reply_to_message`, `find_agents`.

---

## How it works

```
                      ┌───────────── agent-to-agent: internal, no SMTP ─────────────┐
                      │                                                             ▼
POST /v1/emails ──▶ validate ──▶ route ──▶ suppression ──▶ transactional queue ──▶ SES ──▶ recipient
                                   │                            ▲                          │
campaign send ──▶ materialise ─────┘                            │                     events (SNS)
                                                          campaign queue                    │
                                                                                            ▼
inbound (SES receipt) ──▶ /ingest/inbound ──▶ policy ──▶ mailbox ──▶ long poll / webhook ──▶ log
```

Design decisions worth knowing before reading the code:

- **The transactional queue is drained before the campaign queue, always.** A
  500,000-recipient broadcast must never sit in front of a password reset.
- **Local recipients skip the provider.** Two agents on the platform exchange
  messages in milliseconds; the addressing stays email, so the same address
  works from outside.
- **One `messages` table, both directions.** An inbox entry is a row with
  `direction = 'inbound'` and an `agent_id`. A separate mailbox table would
  drift from the log.
- **Credentials contain the blast radius.** An agent-scoped key reads one
  mailbox and sends as one address. An agent reading untrusted mail cannot be
  talked into reaching anything else, because the key cannot.
- **Loops are bounded in the platform, not in the agent.** Hop ceilings and
  per-thread rate limits stop two agents replying to each other forever.

### Layout

```
src/
  platform.ts        composition root — everything is constructed here
  types.ts           domain model
  config.ts          environment configuration
  client.ts          HTTP client / SDK
  cli.ts             serve, demo
  domain/            accounts, agents, mailbox, sending, delivery, domains,
                     suppression, templates, lists, campaigns, webhooks, events
  inbound/           inbound MIME ingestion and mailbox routing
  http/              router, auth, rate limiting, routes, serializers
  mcp/               MCP stdio server
  providers/         SES (SESv2, tenant-scoped) and in-memory adapters
  queue/             priority queues, at-least-once worker, DLQ
  store/             Store port + in-memory implementation
  util/              MIME build/parse, address handling, templating, crypto
migrations/          Postgres schema, monthly partitions
docs/                amendment, API reference, agent guide
```

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `AGENTMAIL_DOMAIN` | `agentmail.test` | Platform domain |
| `AGENTMAIL_AGENT_DOMAIN` | `agents.<platform>` | Namespace for hosted agent addresses |
| `AGENTMAIL_PUBLIC_URL` | `http://localhost:$PORT` | Base for unsubscribe and tracking links |
| `AGENTMAIL_STORE` | `memory` | `memory` or `postgres` |
| `DATABASE_URL` | — | Postgres connection string |
| `AGENTMAIL_PROVIDER` | `memory` | `memory` or `ses` |
| `AWS_REGION` | `eu-west-1` | SES region |
| `AWS_ACCOUNT_ID` | — | Required with `ses`; tenant association builds ARNs from it |
| `AGENTMAIL_SECRET` | development value | HMAC secret for unsubscribe tokens and ingest auth |
| `AGENTMAIL_MAX_HOPS` | `10` | Default automated-reply ceiling |
| `AGENTMAIL_MAX_THREAD_RATE` | `30` | Default per-thread messages per minute |
| `AGENTMAIL_LEASE_SECONDS` | `60` | Default mailbox lease |
| `AGENTMAIL_INITIAL_DAILY_LIMIT` | `100` | Sending limit for a new account |

Set `AGENTMAIL_SECRET` to a real value before running anywhere but a laptop: it
signs unsubscribe links and authenticates the inbound ingest endpoint.
[`.env.example`](.env.example) has the full set, and
[`docs/ses-setup.md`](docs/ses-setup.md) covers credentials, the IAM policy,
what AWS provisions automatically and what the customer pastes into DNS.

---

## Status

Implemented and tested (41 tests, `npm test`). Requirement by requirement, with
the partial ones named, in
[`docs/srs-traceability.md`](docs/srs-traceability.md) — 91 done, 26 partial,
40 open.

- Accounts, hashed API keys with `full` / `send` / `read` / `agent` scopes
- Domain verification with DNS record generation and the DMARC / SPF /
  MAIL FROM diagnostics from DR-3
- Agents, hosted addressing, inbox policies, opt-in directory
- Mailbox leases, long poll, threading, structured payloads, loop control
- Internal agent-to-agent routing and external delivery via a provider port
- Priority queues, retries with backoff, dead letter queue
- Suppression with bounce and complaint handling
- Templates, lists with CSV import and export, campaigns with one-click unsubscribe
- Signed webhooks with a 24-hour retry window and manual replay
- Message log filterable by recipient, status, thread, tag, text and date
- Audit trail over account, key, domain, agent, suppression and webhook actions
- REST API, MCP server, SDK

Not yet built, and the honest list:

- **The Postgres store adapter.** The schema is written
  (`migrations/001_init.sql`, `002_partitions.sql`) and the `Store` port is
  defined, but only the in-memory implementation exists. That makes this a
  development and integration-test platform, not a durable one.
- **SQS queues.** The queue port is SQS-shaped; the implementation is
  in-process, so a restart drops queued work.
- **The SES receipt path.** `/ingest/inbound` takes the raw message and
  envelope recipients; the SES receipt rule, S3 landing and the Lambda that
  would call it are not in this repository. Nor is the SNS adapter for
  `/ingest/events`. Outbound provisioning and sending *are* wired — see
  [`docs/ses-setup.md`](docs/ses-setup.md) — but have not been run against a
  live AWS account.
- **Dashboard, billing, SMTP relay, open and click tracking, A/B testing.**
  Specified in the base SRS, not started.

---

## Tests

```bash
npm test
```

Covers the mailbox lease lifecycle, threading across accounts, hop and rate
ceilings, inbox policy enforcement, queue priority, provider retry and dead
lettering, suppression and bounce handling, campaign exclusion and unsubscribe
tokens, webhook signature verification, MIME round trips including the
structured payload part, the full HTTP surface, and the MCP protocol end to end.
