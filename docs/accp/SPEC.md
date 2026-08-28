# Agent Communication Context Protocol (ACCP)

**Version 0.2 (draft)** · Status: for discussion · Not yet submitted to any
standards body

---

## Abstract

ACCP defines how autonomous software agents address, authenticate and exchange
structured messages with one another across organisational boundaries.

It is not a new transport. ACCP is a **profile over RFC 5322 and MIME** — the
message format the world's email already speaks — adding the small number of
things agent-to-agent traffic needs and ordinary mail lacks: a machine-readable
payload with a defined media type, **the context a recipient needs in order to
act on it** (§6), correlation across a conversation, declared intent, capability
discovery, and mandatory loop control.

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
| `ACCP-Version` | The protocol version. `0.2` for this document. |
| `ACCP-Intent` | One of the intents in §4. |
| `ACCP-Conversation` | An opaque token, globally unique at origin, identifying the conversation. |
| `ACCP-Hops` | A non-negative integer: how many agent-generated messages precede this one in the conversation, plus one. |

Senders MUST also set `Message-ID`, `Date` and `From` as RFC 5322 requires. A
reply MUST set `In-Reply-To` and SHOULD set `References`.

### 3.2 Optional headers

| Header | Value |
|---|---|
| `ACCP-Agent` | The sending agent's canonical address, when it differs from `From` (for example when sent through a shared relay). |
| `ACCP-Capability` | The capability token (§7) this message invokes. |
| `ACCP-Correlation` | An opaque token echoed unchanged in the response, for a sender correlating replies to its own outstanding requests. |
| `ACCP-Idempotency-Key` | Set by the sender; a receiver that has already acted on this key MUST NOT act again, and SHOULD return its previous response. |
| `ACCP-Expires` | An RFC 3339 timestamp after which the message is no longer worth acting on. |
| `ACCP-Content-Digest` | Per-part content commitment bound to the Message-ID. REQUIRED when an `application/accp+json` part is present (§9.2). |

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
| `error` | Reporting that a prior message could not be handled (§8) | No |
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

### 5.1 Media type and envelope

Structured content MUST be carried in a MIME part with media type
`application/accp+json`, encoded as UTF-8 JSON.

From version 0.2 that part is an envelope with three members:

```json
{
  "accp": "0.2",
  "context": { },
  "payload": { }
}
```

- `accp` — the envelope version. Its presence is what distinguishes an
  enveloped part from a 0.1 part, which carried the domain payload bare.
- `context` — what the recipient needs in order to act (§6). OPTIONAL, but
  see §6.1 for when it stops being optional in practice.
- `payload` — the domain content, whose structure is a matter for the two
  agents (§5.3).

A receiver encountering a part with no `accp` member MUST treat the whole object
as the payload, with no context. That is the 0.1 format, and it stays readable.

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

ACCP standardises the **envelope and the context**, not the ontology. The
payload's internal structure is a matter for the two agents and their domain.

A payload SHOULD be a JSON object. It MAY carry a `$schema` member naming a JSON
Schema the sender claims to conform to. Receivers MUST NOT require it.

This is a deliberate limit. Attempts to standardise a universal
agent-interaction ontology have consistently failed; what survives is a shared
envelope with domain-specific contents. §13 discusses what a capability
registry would need to look like if the ecosystem later wants stronger
guarantees.

---

## 6. Context

This is the section the protocol is named for, and the reason a bare envelope is
not enough.

A message crossing a trust boundary arrives at an agent that knows nothing about
where it came from. The payload says *what* is being asked. It does not say who
is really asking, on whose authority, what has already happened, what the sender
expects back, or how the contents may be handled. A human reading an email
recovers most of that from the thread, the signature block and the relationship.
An agent has none of it.

MCP assembles context for a model from the tools and data on its own side of the
boundary. ACCP carries context **across** the boundary, so the receiving agent
can assemble its own. Same word, orthogonal axis.

### 6.1 The context object

Every member is OPTIONAL. An empty context is valid, and a `notify` between two
agents that already share state may legitimately need none. But an agent
receiving a `request` from a stranger with no context has only a payload and a
domain name, and will usually have to refuse or ask.

```json
{
  "principal": {
    "type": "organization",
    "id": "acme.example",
    "display_name": "Acme Ltd"
  },
  "delegation": {
    "depth": 2,
    "chain": ["person:ada@acme.example", "agent:buyer@acme.example"]
  },
  "summary": "Ada asked for 40 units of WIDGET-1 delivered to Kampala. This is the third supplier approached; the first two could not meet the date.",
  "expects": {
    "reply_by": "2026-09-01T00:00:00Z",
    "format": "structured",
    "schema": "https://acme.example/schemas/quote.json"
  },
  "constraints": {
    "confidential": true,
    "do_not_forward": true,
    "do_not_train": true,
    "retain_until": "2026-12-01T00:00:00Z"
  },
  "provenance": {
    "generated_by": "model",
    "human_reviewed": false
  }
}
```

**`principal`** — on whose behalf the agent is acting. The `From` address
identifies the *agent*; this identifies the party it answers to. An agent that
cannot tell whether it is dealing with Acme Ltd or with a program that merely
has an address at Acme cannot make a commercial decision.

**`delegation`** — the chain from the originating party to this sender, and its
depth. A request that reaches an agent four hops from the human who wanted it is
a different proposition from one hop, and receivers SHOULD be able to say so.

> **Disclosure hazard.** `chain` names internal parties. An agent polling six
> suppliers for a quote tells all six who inside the company initiated the
> request and what its internal agent topology looks like — to five parties who
> will not win the business, and possibly to a competitor. Senders SHOULD
> default to `depth` alone and include `chain` only where a receiver
> demonstrably needs it. Appendix C sketches what proving properties of the
> chain without disclosing it would take.
Endpoints SHOULD enforce a maximum delegation depth; this bounds request
laundering, where a chain of agents is used to launder an unauthorised ask into
one that looks legitimate. It is a distinct guard from the hop ceiling in §3.4:
hops bound how long a conversation runs, depth bounds how far an authority has
been passed along.

**`summary`** — the conversation so far, in prose, as the sender understands it.
This is the most useful member and the least obvious. A receiver may not hold
the earlier messages at all: it may have been added to the conversation partway
through, its retention window may have expired, or the thread may have crossed
an organisational boundary where nothing was shared. Reconstructing from
`References` only works when the receiver already has what those identifiers
point at. A summary always travels.

**`expects`** — the shape of the reply the sender is waiting on: a deadline, a
format, optionally a schema. Without it a receiver guesses, and two agents can
spend several round trips discovering they wanted different things.

**`constraints`** — handling rules that travel with the message: confidentiality,
forwarding, retention, whether the contents may be used as training data.

**`provenance`** — whether the message was composed by a model, and whether a
human reviewed it before it was sent.

### 6.2 Context is asserted, not proved

**Everything in the context object is a claim by the sender.** The only thing
authenticated on an ACCP message is the sending domain, via DKIM and DMARC
(§9.1). A `principal` naming Acme Ltd means "a sender authenticated as
acme.example says it acts for Acme Ltd" — nothing stronger.

Therefore:

- A receiver MUST NOT grant authority on the strength of `principal` or
  `delegation` alone. Where a decision needs real authorisation, it must come
  from out-of-band verification, a prior relationship, or a credential the
  protocol does not define.
- A receiver MUST NOT treat `constraints` as enforcement. They express what the
  sender asks of the recipient; nothing makes a peer honour them. They are worth
  carrying because a cooperating peer will, and because ignoring a stated
  constraint is then a deliberate act rather than an accident.
- `provenance` is self-reported, and an agent with a reason to misreport it can.

This is stated plainly because the alternative is worse: a context block that
looks like authorisation invites implementations to treat it as authorisation,
and that is a straightforward privilege-escalation path across a trust boundary.
Context is for *deciding well*, not for *deciding who may*.

### 6.3 What class of problem this is

Worth naming, because misnaming it leads to the wrong remedy.

**It is not a consensus problem.** A receiver decides alone: there is no quorum,
no shared state, and no set of peers that must reach the same verdict. Remove
every other agent and the problem is unchanged. Reaching for the Byzantine
Generals Problem (Lamport, Shostak and Pease, 1982) here leads to voting
endpoints or a shared ledger, which would be a poor fit for a federated
store-and-forward protocol that deliberately has no central party.

**It is a delegation and attribution problem**, of two well-studied kinds:

- **The confused deputy** (Hardy, 1988). An agent holding authority is induced
  to exercise it on behalf of a party that should not have it. This is precisely
  what happens if a receiver grants privilege on an asserted `principal`. The
  delegation ceiling in §6.1 bounds how long such a chain can get; it says
  nothing about whether any link in it is legitimate.
- **The "speaks for" relation** (Lampson, Abadi, Burrows and Wobber,
  *Authentication in Distributed Systems*, 1992). `principal` together with
  `delegation.chain` is a speaks-for chain expressed in JSON, without that
  work's formal semantics and without cryptography.

One aspect does touch Byzantine behaviour: nothing prevents a sender telling one
receiver it acts for Acme and another that it acts for Globex. Equivocation is
Byzantine in the strict sense — but it only constitutes a *distributed systems*
problem where the deceived parties must agree, and here they never do. It is
fraud, detectable after the fact, and not consensus.

The remedy therefore is not agreement but **attenuable signed credentials** —
SPKI/SDSI (RFC 2693), macaroons, or W3C Verifiable Credentials — in which the
principal signs an assertion that the agent speaks for it, the agent attenuates
and forwards it, and a receiver verifies against the principal's key without
consulting anyone. This is the direction §13.7 asks about, and its cost is key
distribution rather than quorum.

The one genuine echo of Lamport is directional: his signed-message variant
tolerates any number of faulty parties, because signatures remove the ability to
lie about what someone else said. The same move closes this gap. Note that ACCP
is not starting from the oral-message case — DKIM and DMARC already authenticate
the sending *domain* (§9.1). What is missing is authentication one level down,
of the principal and the chain within an authenticated domain.

### 6.4 Requirements

- **C-1** An endpoint MUST make the received context available to the agent
  unmodified.
- **C-2** An endpoint MUST NOT populate `principal`, `delegation` or
  `provenance` on an inbound message from its own inference. An absent member
  stays absent.
- **C-3** An endpoint SHOULD populate `delegation.depth` on outbound messages
  and MUST refuse to send past its configured maximum depth.
- **C-4** Context MUST survive external transport intact, as part of the
  `application/accp+json` part.
- **C-5** An endpoint MUST NOT log or persist a payload or context carrying
  `constraints.confidential` beyond what `constraints.retain_until` allows,
  where it is able to honour it.

## 7. Discovery

An agent that cannot find its counterpart is limited to addresses hardcoded when
it was built.

### 7.1 Agent card

An endpoint MAY publish a card for an agent, as `application/json`:

```json
{
  "accp_version": "0.2",
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

### 7.2 Resolution

Given an address, a client SHOULD resolve the card by requesting
`https://<domain>/.well-known/accp/agent?address=<addr-spec>`.

An endpoint MAY additionally offer a search interface. Search is explicitly not
part of the core: a queryable index of every agent address is also a harvesting
surface, and whether to run one is a policy decision, not a protocol one.

### 7.3 Capability tokens

`capabilities` is a list of dotted lowercase tokens (`invoice.parse`). They are
advisory: a sender uses them to choose a recipient, and a receiver MUST still
validate what actually arrives.

---

## 8. Errors

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

## 9. Trust and admission

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

### 9.1 Sender authentication

An endpoint MUST evaluate SPF, DKIM and DMARC on inbound messages and MUST make
the results available to the receiving agent.

Agent identity in ACCP is domain identity: an ACCP message is exactly as
trustworthy as the claim that it came from `acme.example`. This is a real limit.
It says nothing about which program at `acme.example` sent it, or whether that
program was behaving as its operator intended. §10 covers the consequences.

### 9.2 Message integrity

**Authentication is not integrity, and an endpoint MUST NOT infer one from the
other.**

Mail is modified in transit as a matter of routine, and mostly without malice:

- list servers append footers and rewrite `Subject` and `From`;
- security gateways rewrite URLs, strip attachments and prepend banners;
- scanners append notices;
- MTAs re-encode MIME parts, re-wrap lines, and downgrade 8-bit content.

DKIM signs a canonicalised header set and a body hash, so a *valid DKIM
signature* does attest that the signed content arrived intact — subject to the
canonicalisation chosen, and to the `l=` tag, which permits content to be
appended after the signed prefix.

DMARC does not carry that guarantee. **DMARC passes on SPF alignment alone**,
which authenticates the envelope sender while saying nothing whatever about the
body. A message can therefore be fully DMARC-aligned and still have had its
payload rewritten en route. An agent acting on a structured payload because
"DMARC passed" is acting on unverified data.

For an agent this matters more than it does for a person. A human reading a
mangled message notices. An agent parsing `{"quantity": 4000}` where the sender
wrote `{"quantity": 40}` does not.

#### The commitment scheme

The design borrows three habits from proof systems — commit to parts, bind the
commitment to its context, separate hash domains — while deliberately not
borrowing a Merkle tree, whose logarithmic proofs pay off over thousands of
leaves and a message has four. (This is the v2 construction, hardened after the
adversarial review in `integrity-review.md`. The v1 scheme it replaced had a
self-referential root check, an unbound sender, and no attachment coverage.)

A sender including an `application/accp+json` part MUST include:

```
ACCP-Content-Digest: alg=sha-256; root=<b64>; payload=<b64>; text=<b64>; html=<b64>; attachments=<b64>
```

- The committed set is fixed: `payload`, `text`, `html`, `attachments`. A leaf
  appears only for a part that is present, except `attachments`, whose leaf is
  always present (an empty leaf still detects an attachment added in transit).
- Each **leaf** is `SHA-256` over **length-prefixed** fields:
  `LEAF_LABEL, part-name, Message-ID, From, content`. Each field is an 8-byte
  big-endian length then its bytes, so no byte inside one field — a NUL
  included — can be read as a boundary (the v1 `||0x00||` delimiter was not
  injective). `content` is the **decoded UTF-8 bytes** of the part, so an
  intermediary re-encoding base64 or re-wrapping lines does not read as
  tampering. The `attachments` content is the ordered list of each attachment's
  length-prefixed filename, content-type, and content hash.
- The **root** is `SHA-256` over length-prefixed
  `ROOT_LABEL, Message-ID, From, Date, alg,` then each part-name and its leaf in
  fixed order. It binds the leaf set *and the envelope*, so a part cannot be
  dropped and a payload cannot be re-enveloped under a different sender.
- **Why bind `From` and `Date`:** without them a valid payload could be lifted
  into a message from a different sender and still verify (the confused-deputy
  shape at the transport layer). Binding the envelope makes each leaf worthless
  outside its own message *and* its own sender.
- **Why per part:** a list server appending a footer rewrites `text` and not
  `payload`. The receiver reports which parts changed; a changed `text` does not
  condemn an intact `payload`.
- **Why labelled and versioned** (`ACCP-leaf-v2`, `ACCP-root-v2`): domain
  separation, and a version so the construction can change without ambiguity.

#### Requirements

- **I-1** A sender including an `application/accp+json` part MUST publish
  `ACCP-Content-Digest` as above, and MUST NOT let a caller supply that header.
- **I-2** A sender SHOULD include `ACCP-Content-Digest` in its DKIM signed
  header set, and SHOULD oversign it so a second instance cannot be prepended.
  **See the limitation below — on a platform whose signer cannot cover a custom
  header (SES Easy DKIM among them), this SHOULD is unattainable and `verified`
  never carries the strong meaning.**
- **I-3** A receiver MUST verify every declared leaf and recompute the root from
  the **content-derived** leaves and the envelope — never from the header's own
  claimed leaves. It MUST report the payload as `verified`, `modified`,
  `unverified` (uncheckable — no Message-ID, unknown `alg`) or `digest_missing`
  (a 0.2 payload with no, or more than one, `ACCP-Content-Digest`), together
  with the list of parts that failed.
- **I-4** A receiver MUST reject a message carrying more than one
  `ACCP-Content-Digest` — reporting `digest_missing`, never merging the values.
  This closes the duplicate-header forge.
- **I-5** A receiver MUST NOT silently discard a `modified` or `digest_missing`
  message, and MUST NOT present it as intact. A message whose `text` failed but
  whose `payload` verified is reported exactly so; the agent decides knowingly.
- **I-6** A receiver MUST expose per-mechanism authentication results — SPF,
  DKIM and DMARC separately, plus which mechanism carried DMARC (`dmarc_method`)
  and whether the digest is DKIM-backed (`tamper_evident`). An agent acting on a
  payload SHOULD require `dkim: PASS`; `dmarc: PASS` can rest on SPF alone and
  then attests nothing about the body.
- **I-7** A receiver MAY additionally verify a legacy pre-0.2 `ACCP-Payload-Digest`,
  and MUST NOT emit one.

#### What the digest does and does not give you

Stated precisely, because the difference decides what may be relied on:

- Against **accidental modification** — the list footer, the gateway rewrite,
  the re-encoding — the digest is reliable whether or not DKIM covers it. This
  is the common case by a wide margin.
- Against **malicious modification**, the digest only helps when it is covered
  by a valid DKIM signature (I-2). An attacker able to rewrite the body of an
  unsigned message can rewrite the digest header to match.

So the digest converts silent corruption into a detected condition, and — where
DKIM covers it — tampering into a detected condition too. It is not an
end-to-end guarantee. A payload that must be tamper-evident regardless of
transport needs a signature over the envelope itself (JWS or S/MIME), which
carries the same key-distribution cost as §13.7 and is not required here.

The digest also covers the `context` bytes — `principal`, `delegation` and the
rest travel inside the `application/accp+json` part. A `verified` verdict
therefore proves the sender *stated* those claims intact; it never proves they
are true (§6.2). An intact lie is intact. A receiver MUST NOT treat a verified
payload as evidence for its context's authority claims.

#### Modification that is expected

Where a message legitimately passes through a rewriting intermediary — a
mailing list is the ordinary case — the `modified` verdict is correct and not an
attack. ARC (RFC 8617) exists to let a receiver evaluate such a chain. A
receiver MAY accept an ARC-vouched modification, but MUST still report the
payload as `modified`: something other than the sender composed what arrived,
and the agent is entitled to know that.

---

## 10. Security considerations

### 10.1 Inbound content is untrusted input to a model

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

### 10.2 Loops and amplification

§3.4 and §8 bound automated exchange. Endpoints MUST additionally enforce a
per-conversation rate ceiling; 30 messages per minute is a reasonable default.
An agent pair exchanging messages as fast as a datacentre allows will exhaust a
sending quota and damage a domain's reputation long before a human notices.

### 10.3 A compromised agent is an insider

It holds a valid credential and sends well-formed, authenticated messages.
Nothing in the envelope detects this. Endpoints MUST provide per-agent sending
limits and the ability to suspend an agent immediately.

### 10.4 Spam at agent scale

Automated senders can generate volume no human can. ACCP's admission policies
(§9) put the decision with the receiver rather than relying on content
filtering, which is why `verified` and not `open` is the default. Endpoints
issuing addresses on a shared domain SHOULD apply progressive sending limits to
new agents: reputation on that domain is a shared resource.

### 10.5 Confidentiality

ACCP inherits email's: hop-to-hop TLS where available, nothing end-to-end.
Payloads containing personal or sensitive data SHOULD be encrypted with S/MIME
or OpenPGP, which compose with this profile unchanged — the `application/accp+json`
part is encrypted along with the rest of the body.

### 10.6 Replay

Message integrity (§9.2) binds a payload to its Message-ID and sender, which
stops a valid (digest, payload) pair being *spliced* into a different message.
It does nothing against replay of a whole, intact message: a captured,
DKIM-signed `request` re-injected verbatim re-verifies perfectly, and email is
at-least-once by nature, so even honest infrastructure redelivers.

Replay is therefore in scope, and the defences are mandatory where a request
has side effects:

- A receiver MUST deduplicate on `(sender domain, Message-ID)` within its
  retention window and treat a repeat as a duplicate, not a new instruction
  (§10.6, and ACCP Core requires it — §11.1).
- A sender of a side-effecting `request` MUST set `ACCP-Idempotency-Key`, and
  SHOULD set `ACCP-Expires`. A receiver of such a request bearing neither
  SHOULD treat the redelivery risk as unbounded and refuse to act twice.

`ACCP-Expires` bounds the window in which a captured message is worth
replaying; `ACCP-Idempotency-Key` makes a duplicate a no-op even inside it.

---

## 11. Conformance

### 11.1 Core (required)

An implementation conforms to **ACCP Core** if it:

1. Sends messages that are valid RFC 5322 with all §3.1 headers.
2. Sets `ACCP-Hops` correctly and refuses to exceed its ceiling (§3.4).
3. Carries structured content as `application/accp+json` (§5.1) with a
   human-readable part alongside (§5.2).
4. Populates `In-Reply-To` and `References` on replies (§3.3).
5. Accepts unrecognised intents as `notify` (§4).
6. Implements all four inbox policies, defaulting to `verified` (§9).
7. Evaluates SPF, DKIM and DMARC on inbound and exposes the results (§9.1).
8. Never replies to `error` with `error` (§8).
9. Carries the context envelope of §5.1, passes received context to the agent
   unmodified, and never fabricates `principal`, `delegation` or `provenance`
   on inbound (§6.3).

Core requires no HTTP API. An implementation that only sends and receives SMTP
can conform.

### 11.2 Mailbox profile (optional)

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

### 11.3 Directory profile (optional)

Adds §7.2 resolution at `/.well-known/accp/agent`.

### 11.4 Memory profile (optional)

Adds durable, provenance-carrying knowledge for an agent (§12).

An implementation conforms to the **Memory profile** if:

1. Every stored fact carries the provenance of §12.4.
2. `trust` is derived at write time from provenance and cannot be set by the
   agent recording the fact (§12.3).
3. A fact reaches `attested` only under `verified` payload integrity **and**
   `dkim: PASS`.
4. An inference is capped at the weakest memory it cites.
5. Retraction tombstones by default, with deletion available separately (§12.6).

An implementation that stores agent memory without provenance does not conform,
and SHOULD NOT describe its memory as trusted.

---

## 12. Memory and provenance

### 12.1 The gap this closes

Everything in §9.2 protects a message between the moment it is sent and the
moment it is read. That protection ends there. An agent reads a verified
message, forms a belief, and writes the belief down; the digest, the DKIM
verdict and the sender's identity are not part of what it wrote. Six months
later the agent acts on "the refund window is 30 days" with no way to tell
whether that came from an attested message, a guess, or a line of text in an
email footer written by someone else entirely.

This is the same confused-deputy shape as §6.3, moved from the wire into the
store. It is arguably worse there, because the wire version is at least
re-checkable while the message is in hand, and the stored version is not
re-checkable at all once the provenance is gone.

The boundary that matters here is temporal rather than spatial. An agent
reading its own memory is receiving a message from a past instance of itself
that it cannot interrogate, cannot authenticate, and has no digest for. That
this happens inside one process, or even inside one agent, does not make it a
smaller problem.

### 12.2 Memory records

A conforming implementation that offers durable agent memory MUST store, with
each remembered fact:

| Field | Meaning |
| --- | --- |
| `key` | Stable name for the thing known. A later value for a key supersedes the earlier one. |
| `value` | The fact. |
| `summary` | One line readable in an audit without decoding `value`. |
| `trust` | Derived (§12.3). MUST NOT be accepted from the caller. |
| `provenance` | The chain back to the wire event (§12.4). |
| `expires_at` | Optional. Knowledge that should go stale rather than accrue. |
| `revoked_at` | Set by a retraction. The row is kept. |

### 12.3 The trust ladder

Trust MUST be derived from provenance at write time, and MUST NOT be settable
by the agent recording the fact. An agent that can label its own belief
`attested` has no integrity model at all — it has a field.

| Level | Condition |
| --- | --- |
| `attested` | From a message with `payload` integrity `verified` **and** `dkim: PASS`. |
| `authenticated` | Sender identity held (DMARC or DKIM pass) but content is not tamper-evident. |
| `asserted` | Someone said it and nothing checked it. |
| `derived` | Concluded from other memories. |

Both halves are required for `attested` for the reason given in §9.2: DMARC can
pass on SPF alignment alone with DKIM broken, so an authenticated sender says
nothing about an intact body; and a matching digest proves nothing if the
header carrying it was not itself covered by a signature.

**An inference MUST NOT be trusted more than the weakest memory it cites.** A
conforming implementation caps a `derived` memory at the weakest of its
sources. Without this rule an agent can launder two rumours into a fact by
concluding something from them, and the ladder becomes decorative.

### 12.4 Provenance

For `origin: message`, provenance MUST carry the message id, the RFC 5322
Message-ID, the `ACCP-Content-Digest` header value verbatim, the recorded
`payload` integrity verdict, the DKIM verdict, and the asserting party — the
context `principal` where one was present, else the `From` address. Carrying
the digest itself, rather than only the verdict, is what lets a later reader
re-derive the check instead of trusting a stored boolean.

For `origin: inference`, provenance MUST carry the ids of the memories the
conclusion was drawn from, and those memories MUST belong to the same agent.

### 12.5 Acting on memory

An implementation SHOULD gate autonomous, irreversible action on
`trust: attested`, unexpired and unrevoked. Everything below that level is
recall, not authority: an agent may reason with it, cite it, and reply about
it, but SHOULD NOT take an irreversible action on it without a human or a
stronger source.

This is the §6.2 rule — asserted is not proved — applied to the store rather
than to the wire, and it is where §6.2 was always going to be needed. Context
travels once; memory is consulted forever.

### 12.6 Retraction

A retraction SHOULD tombstone rather than delete. An agent that silently
forgot why it believed something is the failure this model exists to prevent,
and the tombstone is what lets an audit reconstruct what was believed and when
it stopped. Implementations MUST also offer real deletion for the cases where
the content itself must not persist; the two are different operations and
SHOULD NOT be conflated.

### 12.7 Bounded conversation

Durable memory makes long-running agent conversation practical, and thereby
makes unbounded conversation possible. §9.4's hop ceiling and per-thread rate
limit are the floor, not the whole answer. An implementation SHOULD ensure
every message either asserts something checkable or commits to something with
a deadline, so that a thread which is neither converging nor committing can be
detected and stopped rather than continuing indefinitely at cost.

## 13. Open questions

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
6. **How much context is too much.** Every member of §6.1 is optional, and a
   sender with an incentive to be persuasive can fill `summary` with whatever it
   likes. Should receivers cap its length, or is that the receiving model's
   problem?
7. **Verifiable principals.** §6.2 is emphatic that context is asserted rather
   than proved, which limits what it can be used for. A signed assertion — the
   sending domain vouching for a principal — would lift that limit, at the cost
   of a key distribution problem the protocol has so far avoided. Worth it?
   Appendix C considers the zero-knowledge form of the same question, where the
   interesting gain is not proof but non-disclosure.

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
ACCP-Version: 0.2
ACCP-Intent: request
ACCP-Conversation: cnv_01J8X2QK7ZP
ACCP-Hops: 1
ACCP-Capability: quote.request
ACCP-Idempotency-Key: quote-4711
ACCP-Content-Digest: alg=sha-256; root=<b64>; payload=<b64>; text=<b64>; attachments=<b64>
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset=UTF-8

Requesting a quote for 40 units of WIDGET-1, delivered to Kampala
by 5 September.

--b1
Content-Type: application/accp+json; charset=UTF-8
Content-Disposition: inline; filename="accp.json"

{
  "accp": "0.2",
  "context": {
    "principal": {
      "type": "organization",
      "id": "acme.example",
      "display_name": "Acme Ltd"
    },
    "delegation": {
      "depth": 2,
      "chain": ["person:ada@acme.example", "agent:buyer@acme.example"]
    },
    "summary": "Ada asked for 40 units of WIDGET-1 into Kampala by 5 September. Two earlier suppliers could not meet the date.",
    "expects": { "reply_by": "2026-09-01T00:00:00Z", "format": "structured" },
    "constraints": { "confidential": true, "do_not_train": true },
    "provenance": { "generated_by": "model", "human_reviewed": false }
  },
  "payload": {
    "sku": "WIDGET-1",
    "quantity": 40,
    "deliver_to": "Kampala, UG",
    "needed_by": "2026-09-05"
  }
}
--b1--
```

The seller's agent can now act. It knows it is quoting Acme rather than an
unattached program, that a human two steps back wanted this, that the date is
the binding constraint because two suppliers already failed it, when the answer
is needed, and that the request should not be forwarded or trained on. None of
that is in the payload, and none of it survives without being carried.

The seller's reply:

```
From: Seller <seller@widgets.example>
To: buyer@acme.example
Subject: Re: Quote request: WIDGET-1 x40
Message-ID: <01J8X2R4@widgets.example>
In-Reply-To: <01J8X2QK@acme.example>
References: <01J8X2QK@acme.example>
ACCP-Version: 0.2
ACCP-Intent: response
ACCP-Conversation: cnv_01J8X2QK7ZP
ACCP-Hops: 2
ACCP-Content-Digest: alg=sha-256; root=<b64>; payload=<b64>; text=<b64>; attachments=<b64>
Content-Type: multipart/alternative; boundary="b2"

--b2
Content-Type: text/plain; charset=UTF-8

40 units at 12,000 UGX each, total 480,000 UGX. Delivery 3 September.

--b2
Content-Type: application/accp+json; charset=UTF-8
Content-Disposition: inline; filename="accp.json"

{
  "accp": "0.2",
  "context": {
    "principal": { "type": "organization", "id": "widgets.example", "display_name": "Widgets Ltd" },
    "expects": { "format": "structured" }
  },
  "payload": {
    "unit_price": 12000,
    "currency": "UGX",
    "total": 480000,
    "delivery_date": "2026-09-03"
  }
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
  `ACCP-Idempotency-Key`, `ACCP-Expires`, `ACCP-Content-Digest` in the Provisional Message Header Field
  Names registry, per RFC 3864.
- **Well-known URI** `accp`, per RFC 8615.
- Registries for intents (§4) and error codes (§8), with a low barrier to entry
  — specification required rather than standards action.

None of this has been done. This document is a draft for discussion.

---

## Appendix C — Zero-knowledge extensions (non-normative)

Nothing in this appendix is required, and none of it is implemented. It exists
because the question "could zero-knowledge proofs help here" has a real answer
in two places and a clearly negative one in a third, and the negative case is
the one most likely to be got wrong.

### C.1 Where they do not help

**Not for message integrity (§9.2).** A hash plus a signature is the correct
tool and a proof system is strictly worse for it: more moving parts, a proving
step, and in some constructions a trusted setup, in exchange for nothing a
signature does not already give. A SNARK proving "I know a preimage of this
digest" is a more expensive way to publish the digest. If §9.2's limitation is
to be closed, it is closed by signing the envelope — JWS or S/MIME — not by
proving anything in zero knowledge.

**Not for succinctness.** Compressing an *n*-link delegation chain into one
constant-size proof is a real property of these systems, and worth nothing here:
§6.1 caps depth at a single digit, and verifying five signatures takes
microseconds. Succinctness earns its keep at thousands of links, not five.

**Not for bootstrapping trust.** This is the misconception worth stating
plainly. A proof establishes that a statement about a witness holds; it does not
establish who was entitled to make the statement. Someone must still issue the
credential asserting that Acme Ltd is Acme Ltd. Zero knowledge changes *what is
revealed when a credential is presented* — it does not remove the issuer, and it
does not answer §6.3's attribution problem on its own.

### C.2 Where they do help

Both cases are disclosure problems, not integrity problems.

**Selective disclosure of a principal.** An agent may need to prove a property
of the party it acts for without naming it: that its principal is an accredited
buyer, holds a trade licence in a jurisdiction, or is authorised up to a
spending limit — without disclosing which organisation, which licence, or the
exact limit. An agent polling several suppliers currently reveals its identity
to all of them, including the ones that will not win the work.

For attribute disclosure specifically, **BBS+ signatures are usually the better
instrument than a general-purpose SNARK**: an issuer signs a set of attributes
once, and the holder discloses any subset with an unlinkable proof. Lighter,
no circuit to write or audit, and a smaller trusted-computing base.

**Delegation-chain privacy.** The strongest fit, and it addresses a leak this
specification already has (§6.1). A proof could establish "this request descends
from a valid authority chain, rooted at acme.example, of depth at most 5" while
disclosing none of the intermediate parties. That is a statement about a
witness the sender holds and the receiver has no business seeing, which is
precisely the shape these systems are for.

**Predicate proofs over payloads.** In a negotiation, proving "my bid is below
your published ceiling" or "this invoice totals under 10,000" without revealing
the figure. Genuinely useful, and further off than the other two.

### C.3 Why email is an unusually good carrier

Worth noting because it cuts against the usual objection. Proving is expensive
— tens of milliseconds to seconds — which is disqualifying on a synchronous
request path where it lands directly in a user's latency budget. ACCP is
store-and-forward, and delivery already takes seconds to minutes. A proving step
disappears into that.

Proof size is likewise a non-issue in a medium that routinely carries megabyte
attachments: a Groth16 proof is a few hundred bytes, and even a transparent
STARK at tens or hundreds of kilobytes is unremarkable as a MIME part. The
constraints that make zero-knowledge awkward elsewhere mostly do not bind here.

### C.4 What such an extension would have to specify

Sketched so that anyone attempting it does not have to rediscover it:

- **A part or member to carry the proof** — `application/accp-proof+json`
  alongside the envelope, or a `proof` member within `context`.
- **Binding to this message.** A non-interactive proof detached from its context
  is replayable by anyone who observes it. The proof MUST commit to at least the
  `Message-ID` and the `root` of `ACCP-Content-Digest` as public inputs, so that a proof
  captured from one message cannot be attached to another. This is the
  requirement most likely to be missed, and missing it turns a privacy feature
  into an impersonation vector.
- **How a verifier obtains the verifying key and the issuer's key**, which is
  the same key-distribution problem as §13.7 in different clothing — moved, not
  removed.
- **A statement of what the proof does not cover.** A proof about a principal
  says nothing about payload integrity, and vice versa; §9.2's separation of
  authentication from integrity applies with equal force to proofs.
- **Failure semantics.** An unverifiable proof MUST be reported like a
  `modified` payload (§9.2, I-4): surfaced to the agent, never silently
  discarded and never presented as valid.

### C.5 Recommendation

Do not adopt this now. The two useful cases both depend on a credential-issuing
ecosystem that does not exist for this market, and a protocol whose adoption
requires both ends to run a proving system will not be adopted. The cheaper
version of the same benefit — sending `depth` without `chain` — is available
today and costs nothing.

Revisit if agent-to-agent commerce reaches the point where identity disclosure
during price discovery is a live commercial problem. That is the condition under
which the cost becomes worth paying, and it is a business condition rather than
a technical one.
