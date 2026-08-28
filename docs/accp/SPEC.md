# Agent Communication Context Protocol (ACCP)

**Version 0.1 (draft)** · Status: for discussion · Not yet submitted to any
standards body

---

## Abstract

ACCP defines how autonomous software agents address, authenticate and exchange
structured messages with one another across organisational boundaries.

It is not a new transport. ACCP is a **profile over RFC 5322 and MIME** — the
message format the world's email already speaks — adding the small number of
things agent-to-agent traffic needs and ordinary mail lacks: a machine-readable
payload with a defined media type, correlation across a conversation, declared
intent, capability discovery, and mandatory loop control.

A conformant ACCP message is a valid email. It reaches an agent through the
existing federated mail system, and a human can read it in an ordinary mail
client.

---

## 1. Why a second protocol

The Model Context Protocol (MCP) solved a real problem and does not solve this
one. The two run on different axes.

|  | MCP | ACCP |
|---|---|---|
| **Axis** | Vertical: an agent reaching **down** to tools and data | Horizontal: an agent reaching **across** to a peer |
| **Trust boundary** | One. The agent and its servers are operated together | Many. The two ends may never have met |
| **Session** | Long-lived, stateful, negotiated at connect | None. Every message stands alone |
| **Timing** | Synchronous request/response | Asynchronous. The peer may be offline for days |
| **Addressing** | Local configuration names the server | Global. An address resolves from anywhere |
| **Delivery** | A connection, or an error | Store-and-forward, with retry and bounce |
| **Failure modes** | Connection refused, tool error | Bounced, delayed, quarantined, silently dropped |

An agent needs both, and they compose cleanly: **an agent uses MCP to reach its
own mailbox, and ACCP is what is on the wire between agents.** One is how it
holds a tool; the other is how it holds a conversation.

### 1.1 Why email, rather than something new

Agent-to-agent messaging needs five properties. Building them takes years each:

1. **Global addressing** — any agent can be named from anywhere.
2. **Federation** — no central registry, no operator everyone must join.
3. **Sender authentication** — the recipient can tell who actually sent it.
4. **Offline delivery** — the recipient need not be running right now.
5. **An audit trail humans can read** when something goes wrong.

Exactly one deployed system has all five: email. SPF, DKIM and DMARC are
imperfect but universal; MX-based routing federates without permission; a
mailbox holds messages for an agent that is redeploying.

The alternative — a new JSON-RPC service each agent exposes — reinvents
addressing, discovery, authentication and retry, and requires both peers to be
reachable at the same moment. That last constraint is the fatal one. Agents
restart, scale to zero, and run on schedules.

So ACCP adds a layer rather than a stack. The cost is email's warts: latency
measured in seconds, MIME's awkwardness, spam. Section 9 addresses each.

### 1.2 Relationship to prior work

ACCP is not unprecedented and does not claim to be.

- **FIPA-ACL** (1997–2002) defined agent messages with *performatives* —
  `inform`, `request`, `agree`, `refuse`. ACCP's intents (§4) are deliberately a
  small, modern subset of that idea. FIPA assumed an agent platform every
  participant joined; ACCP assumes only that both ends can send mail.
- **A2A (Agent2Agent)** exchanges JSON-RPC over HTTP between agents, with agent
  cards for discovery. It is a good fit when both peers are online services with
  a prior arrangement. ACCP targets the case where they are not: different
  organisations, no shared infrastructure, no guarantee the peer is up.
- **MCP** is the vertical axis, as above. ACCP borrows its lesson that the
  valuable part of a protocol is a boring, well-specified envelope.

The three can coexist in one agent. They answer different questions.

---

## 2. Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, MAY and
OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174.

| Term | Meaning |
|---|---|
| **Agent** | An autonomous program addressable at one mailbox address |
| **Agent address** | An RFC 5322 addr-spec naming an agent |
| **ACCP message** | An RFC 5322 message carrying the headers in §3 |
| **Payload** | The structured, machine-readable body part (§5) |
| **Conversation** | A set of messages correlated by `ACCP-Conversation` |
| **Hop** | One agent-generated message in a conversation |
| **Endpoint** | The implementation that sends and receives on an agent's behalf |

---

## 3. Message format

An ACCP message MUST be a valid RFC 5322 message. It MUST carry the headers
below. Header field names follow RFC 6648: no `X-` prefix.

### 3.1 Required headers

| Header | Value |
|---|---|
| `ACCP-Version` | The protocol version. `0.1` for this document. |
| `ACCP-Intent` | One of the intents in §4. |
| `ACCP-Conversation` | An opaque token, globally unique at origin, identifying the conversation. |
| `ACCP-Hops` | A non-negative integer: how many agent-generated messages precede this one in the conversation, plus one. |

Senders MUST also set `Message-ID`, `Date` and `From` as RFC 5322 requires. A
reply MUST set `In-Reply-To` and SHOULD set `References`.

### 3.2 Optional headers

| Header | Value |
|---|---|
| `ACCP-Agent` | The sending agent's canonical address, when it differs from `From` (for example when sent through a shared relay). |
| `ACCP-Capability` | The capability token (§6) this message invokes. |
| `ACCP-Correlation` | An opaque token echoed unchanged in the response, for a sender correlating replies to its own outstanding requests. |
| `ACCP-Idempotency-Key` | Set by the sender; a receiver that has already acted on this key MUST NOT act again, and SHOULD return its previous response. |
| `ACCP-Expires` | An RFC 3339 timestamp after which the message is no longer worth acting on. |

### 3.3 Conversation identity

`ACCP-Conversation` is generated by the agent that begins the conversation and
MUST be echoed unchanged by every participant for its lifetime.

It exists because RFC 5322 threading (`In-Reply-To` / `References`) is
reconstructed rather than declared, and reconstruction fails: clients truncate
`References`, some strip it, and subject-based fallback is a guess. A declared
token is unambiguous.

Implementations MUST still populate `In-Reply-To` and `References`, so that mail
clients — and humans — thread the conversation correctly. When the two
disagree, `ACCP-Conversation` wins.

Receivers MUST treat the token as opaque. It MUST NOT be parsed for meaning, and
implementations MUST NOT assume it is unique across trust boundaries: two
organisations may independently mint the same token, so a receiver's index key
is (sender domain, conversation token), never the token alone.

### 3.4 Hop counting

`ACCP-Hops` MUST be set to zero on a message a human originated, and to the
predecessor's value plus one on every agent-generated message.

An endpoint MUST refuse to send a message whose hop count would exceed its
configured ceiling, and MUST surface the refusal to its operator rather than
dropping it silently. The default ceiling SHOULD be 10.

This is not an optimisation. Two agents that reply to each other do not get
bored, do not go to lunch, and will exchange messages until something external
stops them. Every deployed autoresponder loop in email history was bounded by a
human noticing. Autonomous peers remove that bound, so the protocol has to
supply one.

---

## 4. Intents

`ACCP-Intent` declares what the sender wants, so a receiver can route and
prioritise before parsing the payload.

| Intent | Meaning | Reply expected |
|---|---|---|
| `request` | Asking the recipient to do something or answer something | Yes |
| `response` | Answering a prior `request` | No |
| `notify` | Informing, with no action required | No |
| `error` | Reporting that a prior message could not be handled (§7) | No |
| `ack` | Confirming receipt where work will take time | No |

A `response`, `error` or `ack` MUST set `In-Reply-To` to the `Message-ID` of the
message it answers.

Receivers MUST accept an unrecognised intent and SHOULD treat it as `notify`,
so the vocabulary can grow without breaking deployed agents.

This list is deliberately short. FIPA-ACL's twenty-two performatives encoded a
theory of agent reasoning that implementations did not share; the interoperable
subset was always about this size.

---

## 5. Payload

### 5.1 Media type

Structured content MUST be carried in a MIME part with media type
`application/accp+json`, encoded as UTF-8 JSON.

The part SHOULD carry `Content-Disposition: inline; filename="accp.json"`, so
that mail infrastructure treats it as content rather than an attachment, and so
a human opening the message in a mail client sees something named
comprehensibly.

A message MUST NOT contain more than one `application/accp+json` part. A
receiver encountering several MUST use the first and SHOULD report the rest as
an error.

### 5.2 A human-readable part is mandatory

A message carrying a payload MUST also carry a `text/plain` or `text/html` part
conveying the same substance in prose.

This is the requirement implementers will most want to skip, and it is the one
that matters most. Agent mail is read by humans far more often than its author
expects: in a support queue, during an incident, in a compliance review, in a
customer's own inbox when the conversation escapes the platform. A message that
is only machine-readable is opaque at exactly the moment somebody needs to
understand what an agent did on their behalf.

Where the sender has no prose to offer, the endpoint MUST generate a rendering
of the payload rather than omit the part.

### 5.3 Payload schema

ACCP standardises the **envelope**, not the ontology. The payload's internal
structure is a matter for the two agents and their domain.

A payload SHOULD be a JSON object. It MAY carry a `$schema` member naming a JSON
Schema the sender claims to conform to. Receivers MUST NOT require it.

This is a deliberate limit. Attempts to standardise a universal
agent-interaction ontology have consistently failed; what survives is a shared
envelope with domain-specific contents. §11 discusses what a capability
registry would need to look like if the ecosystem later wants stronger
guarantees.

---

## 6. Discovery

An agent that cannot find its counterpart is limited to addresses hardcoded when
it was built.

### 6.1 Agent card

An endpoint MAY publish a card for an agent, as `application/json`:

```json
{
  "accp_version": "0.1",
  "address": "invoices@acme.example",
  "display_name": "Invoice parser",
  "description": "Extracts totals and due dates from invoices.",
  "capabilities": ["invoice.parse", "invoice.query"],
  "accepts_unsolicited": false,
  "payload_schemas": {
    "invoice.parse": "https://acme.example/schemas/invoice-parse.json"
  }
}
```

Publication MUST be opt-in per agent.

### 6.2 Resolution

Given an address, a client SHOULD resolve the card by requesting
`https://<domain>/.well-known/accp/agent?address=<addr-spec>`.

An endpoint MAY additionally offer a search interface. Search is explicitly not
part of the core: a queryable index of every agent address is also a harvesting
surface, and whether to run one is a policy decision, not a protocol one.

### 6.3 Capability tokens

`capabilities` is a list of dotted lowercase tokens (`invoice.parse`). They are
advisory: a sender uses them to choose a recipient, and a receiver MUST still
validate what actually arrives.

---

## 7. Errors

An agent that cannot handle a message SHOULD reply with `ACCP-Intent: error`
and a payload:

```json
{
  "error": {
    "code": "payload_invalid",
    "message": "quantity must be a positive integer",
    "field": "quantity",
    "retryable": false
  }
}
```

Registered codes for this version:

| Code | Meaning |
|---|---|
| `payload_invalid` | The payload was malformed or failed validation |
| `capability_unsupported` | The requested capability is not offered |
| `not_authorized` | The sender is not permitted to make this request |
| `rate_limited` | Too many messages; `retryable` is true |
| `hop_limit_exceeded` | The conversation exceeded its hop ceiling |
| `expired` | `ACCP-Expires` had passed on arrival |
| `internal_error` | The receiver failed for its own reasons; `retryable` is true |

An error reply MUST NOT itself provoke an error reply. An endpoint MUST NOT send
`error` in response to `error`. Without this rule, two agents can trade error
reports indefinitely — the same loop §3.4 guards, arriving by a different door.

---

## 8. Trust and admission

Every agent MUST declare an inbox policy. Endpoints MUST implement all four
tiers.

| Policy | Accepts |
|---|---|
| `open` | Any sender |
| `verified` | Senders passing DMARC alignment, or vouched for by the endpoint |
| `allowlist` | Named addresses or domains only |
| `closed` | Nothing; the agent only sends |

The default for a newly created agent MUST be `verified`.

A rejected message MUST be recorded with its reason and MUST NOT be delivered.
Rejection SHOULD be silent to the sender where the policy is `allowlist` or
`closed`, to avoid confirming that an address exists.

### 8.1 Sender authentication

An endpoint MUST evaluate SPF, DKIM and DMARC on inbound messages and MUST make
the results available to the receiving agent.

Agent identity in ACCP is domain identity: an ACCP message is exactly as
trustworthy as the claim that it came from `acme.example`. This is a real limit.
It says nothing about which program at `acme.example` sent it, or whether that
program was behaving as its operator intended. §9 covers the consequences.

---

## 9. Security considerations

### 9.1 Inbound content is untrusted input to a model

An agent reading its mail is reading text written by anyone who can reach its
address. Prompt injection is not a hypothetical here; it is the expected case.

The protocol cannot make that content safe. What it requires instead is that the
consequences be bounded:

- An endpoint MUST scope an agent's credential to that agent alone. Reading
  another agent's mail, sending as another address, and changing account
  configuration MUST be outside what the credential can reach.
- Endpoints SHOULD treat payload and prose identically for scanning purposes.
  Hiding an instruction in JSON does not make it inert.
- Endpoints MUST record what arrived, so an operator can reconstruct why an
  agent did something.

Containment belongs in the credential, not in the agent's judgement. Whatever
the agent is persuaded to attempt, the credential must not be able to do it.

### 9.2 Loops and amplification

§3.4 and §7 bound automated exchange. Endpoints MUST additionally enforce a
per-conversation rate ceiling; 30 messages per minute is a reasonable default.
An agent pair exchanging messages as fast as a datacentre allows will exhaust a
sending quota and damage a domain's reputation long before a human notices.

### 9.3 A compromised agent is an insider

It holds a valid credential and sends well-formed, authenticated messages.
Nothing in the envelope detects this. Endpoints MUST provide per-agent sending
limits and the ability to suspend an agent immediately.

### 9.4 Spam at agent scale

Automated senders can generate volume no human can. ACCP's admission policies
(§8) put the decision with the receiver rather than relying on content
filtering, which is why `verified` and not `open` is the default. Endpoints
issuing addresses on a shared domain SHOULD apply progressive sending limits to
new agents: reputation on that domain is a shared resource.

### 9.5 Confidentiality

ACCP inherits email's: hop-to-hop TLS where available, nothing end-to-end.
Payloads containing personal or sensitive data SHOULD be encrypted with S/MIME
or OpenPGP, which compose with this profile unchanged — the `application/accp+json`
part is encrypted along with the rest of the body.

---

## 10. Conformance

### 10.1 Core (required)

An implementation conforms to **ACCP Core** if it:

1. Sends messages that are valid RFC 5322 with all §3.1 headers.
2. Sets `ACCP-Hops` correctly and refuses to exceed its ceiling (§3.4).
3. Carries structured content as `application/accp+json` (§5.1) with a
   human-readable part alongside (§5.2).
4. Populates `In-Reply-To` and `References` on replies (§3.3).
5. Accepts unrecognised intents as `notify` (§4).
6. Implements all four inbox policies, defaulting to `verified` (§8).
7. Evaluates SPF, DKIM and DMARC on inbound and exposes the results (§8.1).
8. Never replies to `error` with `error` (§7).

Core requires no HTTP API. An implementation that only sends and receives SMTP
can conform.

### 10.2 Mailbox profile (optional)

Adds delivery semantics for agents that process messages as work items:
at-least-once delivery with leases, acknowledgement, and redelivery of a lease
that expires.

An implementation conforms to the **Mailbox profile** if a message is redelivered
when its lease expires without acknowledgement, and if a message under an
unexpired lease is not delivered to a second consumer.

This exists because an agent's failure modes are a worker's, not a mail
reader's: it crashes mid-task, runs several replicas, and is restarted by a
deploy. A read flag loses work in all three cases. Endpoints implementing this
profile SHOULD honour `ACCP-Idempotency-Key` (§3.2), since at-least-once
delivery means a message can arrive twice.

### 10.3 Directory profile (optional)

Adds §6.2 resolution at `/.well-known/accp/agent`.

---

## 11. Open questions

1. **Payload semantics.** §5.3 standardises the envelope only. Is a capability
   registry with schema references worth the coordination cost, or does it
   repeat FIPA's mistake?
2. **Latency floor.** Store-and-forward across the public mail system is seconds
   to minutes. Should ACCP define a direct-delivery optimisation for peers that
   can reach each other, with identical semantics and addressing?
3. **Conversation token collisions.** §3.3 scopes by sender domain. Is a
   structured token (`<uuid>@<domain>`, matching `Message-ID`) better than an
   opaque one?
4. **Economics.** Nothing here meters or charges. Should the protocol carry a
   payment or quota assertion, or is that strictly an endpoint concern?
5. **Deprecating hop counting.** Is a hop ceiling the right bound, or should it
   be a conversation-lifetime budget the initiator sets and every participant
   decrements?
6. **The name.** "Context" sits oddly: context is what MCP supplies to a model,
   whereas this protocol carries messages between peers. **Agent Communication
   Protocol (ACP)** describes it more accurately. Retained as ACCP here because
   that is what was asked for; worth settling before anything is published.

---

## Appendix A — Complete example

A buyer agent requests a quote. Headers folded for readability.

```
From: Buyer <buyer@acme.example>
To: seller@widgets.example
Subject: Quote request: WIDGET-1 x40
Message-ID: <01J8X2QK@acme.example>
Date: Thu, 27 Aug 2026 20:41:03 +0000
MIME-Version: 1.0
ACCP-Version: 0.1
ACCP-Intent: request
ACCP-Conversation: cnv_01J8X2QK7ZP
ACCP-Hops: 1
ACCP-Capability: quote.request
ACCP-Idempotency-Key: quote-4711
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset=UTF-8

Requesting a quote for 40 units of WIDGET-1, delivered to Kampala
by 5 September.

--b1
Content-Type: application/accp+json; charset=UTF-8
Content-Disposition: inline; filename="accp.json"

{
  "sku": "WIDGET-1",
  "quantity": 40,
  "deliver_to": "Kampala, UG",
  "needed_by": "2026-09-05"
}
--b1--
```

The seller's reply:

```
From: Seller <seller@widgets.example>
To: buyer@acme.example
Subject: Re: Quote request: WIDGET-1 x40
Message-ID: <01J8X2R4@widgets.example>
In-Reply-To: <01J8X2QK@acme.example>
References: <01J8X2QK@acme.example>
ACCP-Version: 0.1
ACCP-Intent: response
ACCP-Conversation: cnv_01J8X2QK7ZP
ACCP-Hops: 2
Content-Type: multipart/alternative; boundary="b2"

--b2
Content-Type: text/plain; charset=UTF-8

40 units at 12,000 UGX each, total 480,000 UGX. Delivery 3 September.

--b2
Content-Type: application/accp+json; charset=UTF-8
Content-Disposition: inline; filename="accp.json"

{
  "unit_price": 12000,
  "currency": "UGX",
  "total": 480000,
  "delivery_date": "2026-09-03"
}
--b2--
```

Note what did not have to be arranged in advance: no shared session, no service
discovery handshake, no requirement that either agent was running when the other
sent. The buyer could be scaled to zero when the reply arrives.

---

## Appendix B — IANA considerations

Were this pursued as a standard, registration would be required for:

- **Media type** `application/accp+json`, per RFC 6838.
- **Header fields** `ACCP-Version`, `ACCP-Intent`, `ACCP-Conversation`,
  `ACCP-Hops`, `ACCP-Agent`, `ACCP-Capability`, `ACCP-Correlation`,
  `ACCP-Idempotency-Key`, `ACCP-Expires` in the Provisional Message Header Field
  Names registry, per RFC 3864.
- **Well-known URI** `accp`, per RFC 8615.
- Registries for intents (§4) and error codes (§7), with a low barrier to entry
  — specification required rather than standards action.

None of this has been done. This document is a draft for discussion.
