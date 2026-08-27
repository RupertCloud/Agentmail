# Amendment A — Agent Mailboxes
## Software Requirements Specification, Silk Relay / AgentMail

| | |
|---|---|
| **Amends** | `SRS-silk-relay.md` v0.1 (27 August 2026) |
| **Version** | A.1 (draft) |
| **Status** | For review |

> This amendment layers onto the base specification rather than replacing it.
> Section numbers prefixed **A** are new; where it changes a decision in the base
> document, the affected clause is named explicitly.

---

## A1. Why this amendment exists

The base specification describes a two-sided product: transactional email for
developers, campaigns for marketers. Both sides assume a human at one end of
every message and an application at the other.

A third party now needs an address: the AI agent. Agents book meetings, chase
invoices, answer support queues and negotiate with other agents. They need to
send mail, and — unlike an application firing off password resets — they need to
**receive** it, read it, and answer it.

Nothing in v0.1 serves that. §1.2 puts inbound processing out of scope, which
makes every address the platform issues write-only. An agent with a write-only
address is not reachable; it is a send-only client with a return address nobody
can use.

This amendment brings inbound into scope and specifies the mailbox, the routing,
the identity model and the containment that agent traffic requires. The human
sides of the product are unchanged: transactional and marketing email keep every
requirement in the base document. The three workloads share one substrate.

### A1.1 Positioning

The product is one email platform serving three workloads:

| Workload | Who sends | Who receives | What matters most |
|---|---|---|---|
| **Transactional** | An application | A human | Latency, deliverability, never lost |
| **Marketing** | A marketer | Many humans | List hygiene, consent, reporting |
| **Agent** | An agent | An agent, or a human | Reachability, structure, threading, containment |

The differentiator in the base document — a market billed in mobile money and
supported in local business hours — is unchanged. What this amendment adds is a
second differentiator that is not regional: incumbents (Resend, Postmark,
Mailgun) sell outbound APIs. None of them issues a working mailbox with a
one-call receive loop. An agent built on them still has to bolt an IMAP client
onto a mail host somebody else operates.

**Working name.** The repository is `AgentMail`, which the amendment adopts
throughout. This resolves open question §12.1 of the base document only if the
owner agrees; "Silk Relay" remains the alternative.

---

## A2. Scope change

**Amends §1.2.** Inbound email processing moves from out of scope to in scope,
limited to mail addressed to an agent mailbox. General-purpose mail hosting for
human users — folders, IMAP, a webmail client — remains out of scope, and is a
different product.

**Amends §2.2.** A fifth user class is added:

| Class | Description | Primary needs |
|---|---|---|
| **Agent** | An autonomous program with its own address | An address that works immediately, a receive loop, structured payloads, threading, credentials scoped to itself |

The agent is not a person, and the distinction has consequences throughout: it
polls rather than opens a client, it fails and restarts mid-task, it can be
prompted by the very mail it is reading, and it can generate replies faster than
any human — including replies to another agent that is doing the same thing.

---

## A3. Agent addressing and identity

- **FR-13.1** An account shall provision an agent by name alone, receiving a
  working address without configuring DNS.
- **FR-13.2** Hosted agent addresses shall be allocated under a
  platform-controlled namespace, one label per account:
  `<agent>@<account>.agents.<platform-domain>`. The platform holds DKIM and
  DMARC on that domain, so an agent is authenticated from its first message.
- **FR-13.3** An account may instead place an agent on a domain it has verified
  under FR-2, e.g. `support@acme.com`. Verification rules are unchanged.
- **FR-13.4** An agent record shall carry a display name, a description, a list
  of capability tags, an inbox policy, and a discoverability flag.
- **FR-13.5** Deleting an agent shall release its address, and shall not delete
  the message log retained under FR-9.6.

**Rationale for the hosted namespace.** Domain verification is the single
largest drop-off in onboarding for every incumbent: three CNAMEs, an MX, a TXT,
and a wait. That cost is worth paying for a company's transactional mail, where
the from-address must be the company's own. It is not worth paying to let an
agent exchange structured messages with another agent, where nobody reads the
domain. The hosted namespace makes an agent reachable in one API call, and the
verified-domain path stays available for agents that face customers.

---

## A4. The mailbox

An agent's inbox is specified as a **lease queue**, not a folder.

- **FR-14.1** Every message delivered to an agent shall be stored with a mailbox
  state of `unread`, `claimed`, `acked` or `archived`.
- **FR-14.2** An agent shall claim messages, taking a lease of configurable
  duration. A claimed message shall not be handed to any other claimer while the
  lease holds.
- **FR-14.3** An expired lease shall return the message to `unread` and increment
  its delivery attempt count.
- **FR-14.4** An agent shall acknowledge a message when it has finished with it.
  An acknowledged message shall not be redelivered.
- **FR-14.5** An agent shall be able to release a claimed message back to the
  inbox without acknowledging it.
- **FR-14.6** The API shall offer a long poll: a request that blocks until mail
  arrives or a timeout expires, up to 60 seconds, and that may claim what
  arrives in the same call.
- **FR-14.7** An agent may additionally register a push endpoint, notified on
  delivery. Push shall never be the only path; polling shall always work.

**Rationale.** The failure modes of an agent are the failure modes of a worker,
not of a mail reader. It crashes halfway through a task; it runs as three
replicas behind a queue; it is restarted by a deploy mid-message. A folder with
a read flag loses work in all three cases — the message is marked read and the
work is gone. A lease returns it. This is the semantic that message queues
settled on decades ago, and an agent inbox is a message queue that happens to
speak email at its edges.

It follows that IMAP is the wrong protocol here and is not offered. IMAP models
a human reading mail on several devices; nothing in it expresses "this worker
holds this item for 60 seconds".

---

## A5. Routing and the internal fast path

- **FR-15.1** On accepting a message, the platform shall resolve each recipient
  against its own agent registry.
- **FR-15.2** A recipient that resolves to an agent hosted on the platform shall
  be delivered directly into that mailbox, without handing the message to an
  external provider.
- **FR-15.3** A message with both hosted and external recipients shall deliver
  each by its own path, and shall be recorded once.
- **FR-15.4** Internally delivered messages shall be recorded, logged and
  visible in the message log exactly as externally delivered ones are.
- **NFR-A1** Internal delivery shall complete within 100 ms at p95, measured
  from acceptance to the message being visible to a waiting claimer. This
  replaces NFR-1.2's five-second budget for this path only.

**Rationale.** Two agents on the same platform exchanging a dozen messages to
settle a booking should not make a dozen round trips through SMTP, each with its
own delivery delay, bounce risk and spam evaluation. The addressing stays email
— the same address works from outside — but the transport collapses to a
database write when both ends are local. It is the difference between a
conversation that takes four seconds and one that takes four minutes.

---

## A6. Structured payloads

- **FR-16.1** A message may carry a structured JSON payload alongside its text
  and HTML bodies.
- **FR-16.2** On internal delivery the payload shall be preserved exactly.
- **FR-16.3** On external delivery the payload shall be carried as an
  `application/json` MIME part named `agentmail.json`, so it survives transit
  through ordinary mail infrastructure and is recovered on receipt.
- **FR-16.4** A message carrying a structured payload shall also carry a
  human-readable body. Where the sender supplies none, the platform shall
  generate one from the payload.

**Rationale for FR-16.4.** An agent's mail is read by humans more often than its
author expects — in a support queue, in a compliance review, in a customer's
own inbox when the conversation escapes the platform. A message that is only
machine-readable is unreadable at exactly the moment somebody needs to
understand what the agent did.

---

## A7. Threading

- **FR-17.1** Messages shall be grouped into threads using `Message-ID`,
  `In-Reply-To` and `References`, falling back to a normalised subject and
  participant match when a sender omits them.
- **FR-17.2** A thread identifier shall be scoped to an account. Two accounts in
  the same conversation shall thread it independently, as two mail hosts do.
- **FR-17.3** The API shall return a whole thread, oldest first, in one call.
- **FR-17.4** A reply endpoint shall construct the threading headers, so an
  agent does not have to.

---

## A8. Inbox policy and discovery

- **FR-18.1** Each agent shall carry one of four inbox policies: `open` (accept
  from anyone), `verified` (accept from platform agents and DMARC-aligned
  external senders), `allowlist` (accept from named addresses or domains), or
  `closed` (send only).
- **FR-18.2** The default for a new agent shall be `verified`.
- **FR-18.3** A rejected inbound message shall be recorded in the audit log with
  the reason, and shall not be delivered.
- **FR-18.4** An account may publish an agent to a directory, exposing its
  address, description and capability tags. Publication shall be opt-in and
  reversible.
- **FR-18.5** The directory shall be searchable by capability and free text.

**Rationale for the directory.** An agent that cannot find the agent it needs is
reduced to whatever addresses were hardcoded at build time. A capability-tagged
directory is the smallest thing that makes discovery possible without inventing
a new protocol. It is deliberately not a marketplace, and carries no ranking,
reputation or payment.

---

## A9. Loop control

This section is to agent traffic what §9 is to bulk traffic: the part that keeps
the platform alive.

- **FR-19.1** Every automated reply shall carry a hop count, incremented on each
  agent-generated message in a conversation.
- **FR-19.2** An agent shall have a configurable hop ceiling, defaulting to 10.
  A send exceeding it shall be refused with a clear error.
- **FR-19.3** An agent shall have a configurable per-thread rate ceiling,
  defaulting to 30 messages per minute. A send exceeding it shall be refused.
- **FR-19.4** Refusals under FR-19.2 and FR-19.3 shall be visible to the account
  as events, not silent drops.
- **FR-19.5** Agent traffic shall count against the account's daily sending
  limit and its reputation metrics exactly as human-directed traffic does.

**Rationale.** Two agents that reply to each other do not get bored. A
misconfigured pair can exchange messages until something breaks, and the thing
that breaks is the account's bounce rate, the platform's queue, or the AWS
account's standing — the existential risk named in R-2. A human autoresponder
loop is bounded by how many humans are involved; an agent loop is bounded only
by what the platform enforces. Hop and rate ceilings are the enforcement.

The base document's §9 controls apply unchanged. The hosted agent namespace
does **not** exempt an agent from them: an agent that sends unsolicited mail to
external recipients is doing cold outreach, which the AUP prohibits regardless
of whether a human or a model composed it.

---

## A10. Credentials

- **FR-20.1** The API key scopes in FR-3.1 shall be extended with an `agent`
  scope, bound to exactly one agent.
- **FR-20.2** A key with `agent` scope shall be able to read and act on that
  agent's mailbox and send as that agent's address, and shall be refused
  everywhere else — including creating keys, reading another mailbox, and every
  account management operation.
- **FR-20.3** Agent-scoped keys shall be revocable independently.

**Rationale.** An agent is a program whose behaviour is shaped by text it did
not write and cannot fully validate — including the contents of its own inbox.
Prompt injection is not a hypothetical for a mail-reading agent; it is the
expected case. The containment therefore has to sit in the credential, not in
the agent's judgement: whatever the agent is persuaded to attempt, an
agent-scoped key cannot reach another tenant, another mailbox, or the account's
configuration. This is NFR-3.4 applied to a caller that may be actively
misled.

---

## A11. Model Context Protocol interface

- **FR-21.1** The platform shall ship an MCP server exposing one agent's mailbox
  as tools: identify self, wait for mail, list, read, read thread, claim,
  acknowledge, release, send, reply, and search the directory.
- **FR-21.2** The MCP server shall authenticate with an agent-scoped key, so its
  reach is bounded by FR-20.2.
- **FR-21.3** Tool descriptions shall state the claim/acknowledge contract
  explicitly, so a model using them does not leave work leased and unfinished.

**Rationale.** MCP is how agent runtimes attach tools today. Shipping the server
means an agent gets a mailbox by adding one entry to a config file, rather than
by writing an integration. The HTTP API remains the interface of record; the MCP
server is a client of it, with no privileges the API does not grant.

---

## A12. Data model additions

**Amends §6.**

| Table | Key columns | Notes |
|---|---|---|
| `agents` | id, account_id, slug, address, capabilities, inbox_policy, allowlist, discoverable, max_hops, max_thread_rate | One row per agent; address unique platform-wide |

`messages` gains: `direction`, `transport`, `structured`, `rfc_message_id`,
`in_reply_to`, `references`, `thread_id`, `agent_id`, `hops`, `mailbox_state`,
`claimed_by`, `lease_expires_at`, `delivery_attempts`.

`api_keys` gains `agent_id`, with a constraint that an `agent`-scoped key names one.

**One table, both directions.** An agent's inbox entry is a `messages` row with
`direction = 'inbound'` and an `agent_id`. A separate mailbox table would need
to be kept consistent with the log for the same underlying message, and the
first bug in any such design is the two diverging.

**Retention interaction.** §6 drops `messages` partitions on the plan's
retention schedule. Un-acknowledged agent mail must not be dropped with them: an
agent's unread inbox is live state, not a log line. Partition drops shall skip
partitions still holding rows in `unread` or `claimed`, and aggregate rollups
shall be computed before any drop, as the base document already requires.

---

## A13. Abuse and safety additions

**Extends §9.**

| Control | Requirement |
|---|---|
| Hop ceiling | Automated replies bounded per conversation (FR-19.2) |
| Thread rate ceiling | Bounded messages per minute per thread (FR-19.3) |
| Credential containment | Agent-scoped keys reach one mailbox only (FR-20.2) |
| Inbox policy | Default `verified`; unauthenticated strangers rejected (FR-18.2) |
| Payload inspection | Structured payloads scanned on the same path as bodies (FR-12.7) |
| Directory opt-in | An agent is only discoverable if published (FR-18.4) |
| Rejection visibility | Policy rejections are audited, never silent (FR-18.3) |

Two additions to the base document's threat model:

**A compromised or misled agent is an insider.** It holds a valid credential and
sends legitimate-looking mail. Rate ceilings, per-agent sending limits and the
audit log are what bound the damage; the kill switch in §9 applies to an agent
as it does to a tenant.

**Inbound content is untrusted input to a model.** An agent that reads its mail
is reading text written by whoever could reach its address. The platform cannot
make that text safe, and should not pretend to. What it can do is bound the
consequences (FR-20.2), authenticate senders by default (FR-18.2), and give the
operator a record of what arrived (FR-18.3).

---

## A14. Risks

**Extends §11.**

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-8 | Agent loop floods the platform or an external recipient | Severe — reputation and cost | Hop and thread-rate ceilings, FR-19; daily limits apply to agents |
| R-9 | Prompt injection via inbound mail drives an agent to misuse its credential | Moderate to severe, per credential reach | Agent-scoped keys, FR-20.2; audit log; no privilege escalation path from a mailbox |
| R-10 | Hosted agent namespace becomes a spam origin and the platform domain is blocklisted | Severe — every hosted agent affected | AUP applies to agents unchanged; progressive limits; content scanning; the namespace is a platform-owned domain and can be defended per-account |
| R-11 | Agent workload distracts from the revenue-bearing Phase 1 in §10 | Opportunity cost | Agent work reuses the same pipeline; sequenced in A15 after transactional foundations, not instead of them |

---

## A15. Delivery phasing

**Amends §10.** The phases are unchanged in intent; agent work is inserted where
its dependencies are met.

**Phase 1 — Transactional foundation.** Unchanged.

**Phase 1b — Agent mailboxes.** Agent registry and hosted addressing, inbound
ingestion, mailbox with leases, internal fast path, threading, structured
payloads, agent-scoped keys, MCP server, loop control, directory.
*Exit criterion: two agents on different accounts complete a multi-turn
exchange, and an external human can join the same thread from an ordinary mail
client.*

**Phase 2 — Campaigns.** Unchanged.

**Phase 3 — Scale and trust.** Unchanged, plus per-agent throughput controls and
dedicated agent subdomains for accounts that want their own.

Phase 1b is placed before campaigns because it shares the whole of Phase 1's
pipeline — accounts, keys, queues, event ingestion, message log — and adds one
new capability, inbound. Campaigns add list management, a composer, tracking and
consent tooling, which share almost nothing with it.

---

## A16. Open questions

Extends §12.

8. **Naming.** Adopt AgentMail, keep Silk Relay, or run them as one product with
   two names?
9. **Hosted namespace shape.** `agent@account.agents.example.com` reads clearly
   and isolates accounts. A flatter `account-agent@agents.example.com` is
   shorter. Which is worth the ambiguity?
10. **Directory reach.** Account-local, or platform-wide? Platform-wide makes
    discovery useful and makes address harvesting easy in the same step.
11. **Agent pricing.** Internal delivery costs no SES fee. Charge for it anyway,
    at a lower rate, or make it free and price the mailbox?
12. **Inbound retention.** How long does acknowledged agent mail stay readable,
    and does it follow the plan's log retention or its own schedule?

---

*End of amendment.*
