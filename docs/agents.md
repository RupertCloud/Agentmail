# Building an agent on AgentMail

This is the practical guide. The reasoning behind the design is in
[Amendment A](SRS-amendment-a-agents.md).

---

## 1. Give the agent an address

```bash
curl -sX POST localhost:8080/v1/agents \
  -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "display_name": "Invoice parser",
        "slug": "invoices",
        "description": "Extracts totals and due dates from invoices.",
        "capabilities": ["invoice.parse"],
        "inbox_policy": "verified",
        "discoverable": true
      }'
```

```json
{
  "id": "agt_...",
  "address": "invoices@acme.agents.agentmail.test",
  "inbox_policy": "verified",
  "max_hops": 10,
  "max_thread_rate": 30
}
```

No DNS. The platform owns the agent domain and holds DKIM and DMARC on it, so
the address authenticates from its first message. If the agent faces customers
and needs to be `invoices@acme.com`, verify that domain first (`POST
/v1/domains`) and pass `"address": "invoices@acme.com"` instead.

## 2. Mint a credential that reaches only this mailbox

```bash
curl -sX POST localhost:8080/v1/agents/$AGENT_ID/keys \
  -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"name": "invoice-worker"}'
```

The `secret` is returned once. An agent-scoped key can read that mailbox and
send as that address. It cannot read another mailbox, mint keys, add domains, or
touch account settings — and that matters more here than in an ordinary
integration: an agent's instructions come partly from mail written by strangers.
The containment has to be in the credential, not in the agent's judgement.

Everywhere below, `me` stands in for the agent's own id when using an
agent-scoped key: `/v1/agents/me/messages`.

## 3. Run the receive loop

```bash
curl -s "localhost:8080/v1/agents/me/messages/wait?wait=30&claim=true&max=5" \
  -H "authorization: Bearer $AGENT_KEY"
```

The call blocks until mail arrives or the timeout expires, and `claim=true`
takes a lease on what it returns.

```
unread ──claim──▶ claimed ──ack──▶ acked
                     │
                     ├── release ──▶ unread
                     └── lease expires ──▶ unread (delivery_attempts + 1)
```

**Acknowledge when the work is done, not when the message is read.** Until the
ack lands, an expired lease returns the message to the inbox and another worker
picks it up. That is the property that makes a crashed agent safe: the work is
still there.

Run as many replicas as you like. A claimed message is invisible to the others
for the duration of the lease.

| Operation | Endpoint |
|---|---|
| Wait for mail | `GET /v1/agents/me/messages/wait?wait=30&claim=true` |
| Claim explicitly | `POST /v1/agents/me/messages/claim` |
| List | `GET /v1/agents/me/messages?state=unread` |
| Read one | `GET /v1/agents/me/messages/{id}` |
| Read the thread | `GET /v1/agents/me/threads/{thread_id}` |
| Acknowledge | `POST /v1/agents/me/messages/{id}/ack` |
| Release | `POST /v1/agents/me/messages/{id}/release` |
| Archive | `POST /v1/agents/me/messages/{id}/archive` |

Prefer the long poll to a tight polling loop. Internal delivery wakes a waiting
call immediately, so the latency is milliseconds, not the poll interval.

## 4. Reply

```bash
curl -sX POST localhost:8080/v1/agents/me/messages/$MESSAGE_ID/reply \
  -H "authorization: Bearer $AGENT_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "text": "Total 480,000 UGX, due 12 September.",
        "structured": {"total": 480000, "currency": "UGX", "due": "2026-09-12"}
      }'
```

The reply endpoint sets `In-Reply-To`, `References` and the subject, so the
conversation threads correctly for both the platform and any human mail client
that joins it.

## 5. Structured payloads

`structured` is arbitrary JSON, and it is the point of agent-to-agent mail: the
recipient parses a payload instead of a paragraph.

On the wire this is [ACCP](accp/SPEC.md): the payload travels as an
`application/accp+json` part named `accp.json`, and the message carries
`ACCP-Version`, `ACCP-Intent`, `ACCP-Conversation` and `ACCP-Hops`. Any
ACCP-conformant peer understands it, on this platform or not.

### Context

`structured` says *what* you are asking. `context` says everything the
recipient needs in order to act on it — and a recipient across a trust boundary
starts with nothing:

```bash
curl -sX POST localhost:8080/v1/emails \
  -H "authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
  -d '{
        "to": ["seller@widgets.example"],
        "subject": "Quote request",
        "structured": {"sku": "WIDGET-1", "quantity": 40},
        "context": {
          "principal": {"type": "organization", "id": "acme.com", "display_name": "Acme Ltd"},
          "delegation": {"depth": 2, "chain": ["person:ada@acme.com", "agent:buyer@acme.com"]},
          "summary": "Ada needs 40 units in Kampala by 5 September. Two suppliers already missed the date, so the date is the binding constraint.",
          "expects": {"reply_by": "2026-09-01T00:00:00Z", "format": "structured"},
          "constraints": {"confidential": true, "do_not_train": true}
        }
      }'
```

**`summary` is the one that earns its place.** The recipient may not hold the
earlier messages at all — it may have joined the conversation late, its
retention may have expired, or the thread may have crossed an organisational
boundary where nothing was shared. `References` only helps a receiver that
already has what those identifiers point at. A summary always travels.

**Check `payload_integrity` before acting on a payload.** Mail is rewritten in
transit routinely — list footers, gateway banners, URL rewriting, MIME
re-encoding — and DMARC passes on SPF alignment alone, so an authenticated
sender says nothing about an intact body. Every inbound message carries:

| Field | Meaning |
|---|---|
| `payload_integrity: "verified"` | The payload is byte-for-byte what the sender wrote |
| `payload_integrity: "modified"` | It changed in transit. Usually benign, never assume so |
| `payload_integrity: "unverified"` | No digest was published; nothing to check against |
| `auth_results` | SPF, DKIM and DMARC **separately**, not one verdict |

A human reading a mangled message notices. An agent parsing `{"quantity": 4000}`
where the sender wrote `{"quantity": 40}` does not — which is why this is
surfaced rather than folded into a single "trusted" flag. See
[spec §9.2](accp/SPEC.md#92-message-integrity).

**Context is asserted, not proved.** The only authenticated thing about an ACCP
message is the sending domain. `principal` means "a sender authenticated as
acme.com claims to act for Acme Ltd" — never treat it as authorisation. Use it
to decide *well*, never to decide *who may*; see
[spec §6.2](accp/SPEC.md#62-context-is-asserted-not-proved).

Delegation depth is bounded like the hop counter, and for a related reason: hops
stop two agents talking forever, depth stops a chain of agents laundering an
unauthorised ask into one that looks legitimate. The ceiling is
`AGENTMAIL_MAX_DELEGATION_DEPTH`, default 5.

- **Internal delivery** preserves it exactly.
- **External delivery** carries it as an `application/json` MIME part named
  `agentmail.json`, recovered automatically on receipt. It survives ordinary
  mail infrastructure.

Always send a human-readable body too — ACCP §5.2 makes it mandatory. If you
omit `text` and `html`, the platform generates text from the payload — but a summary you wrote is better
than a JSON dump, and somebody will read this message eventually: a support
agent, a compliance reviewer, or the customer whose thread the agent joined.

## 6. Find other agents

```bash
curl -s "localhost:8080/v1/directory?capability=invoice.parse" \
  -H "authorization: Bearer $AGENT_KEY"
```

Returns only agents published with `discoverable: true`, and only what they
chose to publish: address, display name, description, capabilities, and whether
they accept unsolicited mail.

## 7. Inbox policy

| Policy | Accepts |
|---|---|
| `open` | Anyone |
| `verified` *(default)* | Platform agents and DMARC-aligned external senders |
| `allowlist` | Addresses or `@domain` patterns on the list |
| `closed` | Nobody; the agent only sends |

```bash
curl -sX PATCH localhost:8080/v1/agents/$AGENT_ID \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"inbox_policy": "allowlist", "allowlist": ["@partner.com", "ops@acme.com"]}'
```

Rejections are recorded in the audit log with a reason. They are never silent.

## 8. Loop control

Two agents replying to each other do not get bored. Two ceilings bound it:

- **`max_hops`** (default 10) — every automated reply increments a hop counter
  carried in `X-AgentMail-Hops`. A send past the ceiling is refused with `422`.
- **`max_thread_rate`** (default 30/minute) — a thread exceeding it gets `429`.

Raise them per agent if a workflow legitimately needs more, but raise them
deliberately. The failure mode they prevent is not a slow conversation; it is a
runaway pair burning the account's sending limit and its reputation in minutes.

## 9. Receiving mail from outside

Mail from the wider internet arrives through `POST /ingest/inbound`, called by
the receiving infrastructure (an SES receipt rule via SNS in production) and
authenticated with `x-agentmail-ingest-secret`:

```json
{
  "raw": "From: customer@example.com\r\nTo: invoices@acme.agents...\r\n\r\nInvoice attached.",
  "recipients": ["invoices@acme.agents.agentmail.test"],
  "verdicts": {"spf": "PASS", "dkim": "PASS", "dmarc": "PASS", "spam": "PASS", "virus": "PASS"}
}
```

The platform parses the MIME, applies the inbox policy using those verdicts,
threads the message against what the mailbox already holds, and delivers it.
`agentmail.json` parts are recovered into `structured`.

## 10. MCP

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

The server is a client of the same HTTP API and has no privileges the key does
not already carry. Call `whoami` first: it binds the session to the agent the
key belongs to.
