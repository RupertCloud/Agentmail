# ACCP message-integrity — adversarial review log

A record of trying to break the `ACCP-Content-Digest` message-integrity scheme
(spec §9.2) until we could not break it ourselves. Kept in the repo because a
security claim is worth exactly as much as the attacks it survived, and a reader
deciding whether to rely on `payload_integrity: verified` deserves to see them.

**Status: round 2 complete — v2 was itself broken, v3 is the current scheme.**
All three red-team passes plus the author attack closed the original 16 defects
in v2. A follow-up adversarial pass **against v2** then found two more, both
introduced *by the v2 fix itself*, one of them a working forge. Those are fixed
in v3. 81 tests pass, with a dedicated test per attack.

> **The lesson, recorded because it keeps repeating.** After v1 I wrote "fixed"
> and moved on; v1 was thoroughly broken. After v2 I wrote "fixed" again — and
> v2 contained a forge as severe as the one it replaced (V1 below), created by
> the fix. A patch to a security construction is a new construction, and earns
> no more trust than the original until it has been attacked on its own terms.
> "Confirmed secure" is not a state this document will ever claim.

Headline was: **16 confirmed defects — 10 in code, 6 in the spec/guidance**,
including one **critical in-transit payload forge**. The v1 scheme's two
advertised guarantees (the root binds the leaf set; each leaf binds the
Message-ID) were both undelivered, and on this platform `verified` could never
mean tamper-evidence because SES Easy DKIM cannot sign the header.

**What the fix changed (v2):** the root is recomputed from *content*, never from
the header's own leaves; every leaf and the root bind the envelope (From, Date)
as well as the Message-ID; fields are length-prefixed so the pre-image is
injective; attachments are committed; a duplicate `ACCP-Content-Digest` is
refused as `digest_missing`; a stripped digest is `digest_missing`, not the
softer `unverified`; an empty Message-ID or unknown `alg` is `unverified`; the
sender refuses a caller-supplied digest header and no longer trims prose
asymmetrically; the receiver exposes `tamper_evident` and `dmarc_method`; a
replayed Message-ID is flagged; and the spec now states the DKIM dependency, the
`dkim: PASS` rule, the replay threat (§10.6), and fixes Appendix A and C.4.

The one limitation that **cannot** be closed in code is unchanged: against an
active attacker, `verified` is tamper-evidence only under a DKIM signature
covering the header (`tamper_evident: true`). On SES Easy DKIM that is
unreachable, so the guidance is now explicit — require `dkim: PASS`, and read a
bare `verified` as "a self-consistent hash arrived".

> **A note on method.** The critical forge (C0) was reported by the
> implementation red-teamer and my *first* attempt to reproduce it independently
> **failed** — a folded-header bug in my test fixture spliced the attacker's
> header into the middle of the honest one, so the honest value won and the
> verdict came back `modified`. I nearly recorded the finding as unreproducible.
> Fixing my own harness and re-running confirmed the forge exactly as reported.
> A red-team claim is a lead; the verification is the work, and the verification
> has to be right too.

---

## What is being attacked

The scheme, as built:

- Each message part (`payload`, `text`, `html`) gets a **leaf**:
  `SHA-256("ACCP-part-v1" ‖ 0x00 ‖ part-name ‖ 0x00 ‖ Message-ID ‖ 0x00 ‖ content)`
  over the decoded UTF-8 bytes of that part.
- A **root** binds the leaf set:
  `SHA-256("ACCP-root-v1" ‖ 0x00 ‖ Message-ID ‖ 0x00 ‖ "payload=<leaf>;text=<leaf>;html=<leaf>;")`.
- Carried in one header: `ACCP-Content-Digest: alg=sha-256; root=<b64>; payload=<b64>; text=<b64>; html=<b64>`.
- A receiver recomputes each leaf from the received content, reports the payload
  as `verified` / `modified` / `unverified` plus the list of parts that changed,
  and exposes SPF/DKIM/DMARC separately.

The claims under test (verdict in brackets, filled in after review):

1. A receiver can tell whether the payload it acts on is what the sender wrote.
   **[FALSE — C0 forges a `verified` verdict on a tampered payload.]**
2. A benign rewrite of one part (a list footer on `text`) does not condemn
   another part (`payload`). **[Partly — but C6 false-condemns honest prose,
   and C1 means the reverse binding is unenforced.]**
3. A (digest, payload) pair cannot be replayed onto a different message.
   **[FALSE for id-less messages (C4); and a whole intact message replays
   freely (S3).]**
4. Against a malicious active attacker, integrity holds **only** when DKIM signs
   the header (§9.2 states this limitation explicitly). **[True, and worse than
   stated — on this platform SES Easy DKIM cannot sign the header at all (S1),
   so the condition is never met.]**

---

## Findings

Confirmed by the author plus two independent red-team passes (construction,
threat-model). Every row re-verified against the code before acceptance. The
implementation pass is still running; its findings will be appended.

Two findings — the self-referential root and the empty-Message-ID binding — were
reported *independently* by the author and both red-teamers, which is the kind of
convergence that makes them worth trusting.

### Round 2 — defects introduced by the v2 fix (found attacking v2)

| # | Severity | Status | Summary |
|---|----------|--------|---------|
| **V1** | **Critical** | **Fixed in v3, forge reproduced** | **Folded-continuation field injection.** The C0 fix counted duplicate header *lines*. RFC 5322 folding lets an attacker append `; payload=<forged>; root=<forged>` as a *continuation* of the genuine header — one line, so the counter reads 1 — and `parseContentDigest` was last-field-wins. A tampered `{"quantity": 4000}` returned `verified`, `modifiedParts: []`. Fixed by refusing a header with any repeated field key outright, which closes the class regardless of how the duplicate arrives. |
| **V2** | High | Fixed in v3 | **Attachment-set forgery by delimiter collision.** `attachmentsContent` joined `filename.contentType.hash` with `.` and `|`, and `contentType` comes from an attacker-controllable MIME header. Putting the separator structure inside one content type makes *one* crafted attachment byte-identical to *two* honest ones, so the set is substitutable under a matching digest. Fixed by length-prefixing every component (count, name, type, hash). |

Because the commitment bytes changed for security reasons, the construction
labels moved to `ACCP-leaf-v3` / `ACCP-root-v3`: two implementations must never
both claim `v2` while hashing differently.

### Round 1 — code defects (v1)

| # | Severity | Status | Summary |
|---|----------|--------|---------|
| **C0** | **Critical** | **Confirmed, forge reproduced** | **In-transit payload forge.** A MITM swaps the payload body and appends a second `ACCP-Content-Digest` committing to the forgery. `parseHeaders` joins duplicate headers with `, `; `parseContentDigest` is last-field-wins, so the attacker's digest wins. A tampered `{"quantity": 4000}` arrives `verified`, `modifiedParts: []`. Runs with `dkim: FAIL` — the exact adversary the scheme targets. |
| C1 | High | Confirmed ×3 | The root check is a tautology — `contentRoot(messageId, declared.leaves)` and `declared.root` both come from the header. The content-derived `recomputed` leaves are computed and never read. The root enforces nothing. |
| C2 | High | Confirmed | Silent part-drop / prose-swap. The leaf loop `continue`s on an absent leaf, so an attacker who drops a committed part (and its header field, recomputing the root — trivial per C1) gets `verified`, `modifiedParts: []`. The mandatory human-readable part can vanish with no signal. |
| C3 | High | Confirmed | Stripping the digest header yields `unverified`, which the agent-facing text frames as "no digest to check" — softer than `modified`. A receiver cannot distinguish "never committed" from "commitment stripped", and I-1 is unenforced on ingest. |
| C4 | Medium | Confirmed ×3 | A message with no `Message-ID` binds every leaf and the root to the empty string, so the anti-replay binding collapses for id-less messages. |
| C5 | Low–Med | Confirmed | The leaf pre-image `LABEL‖0x00‖part‖0x00‖messageId‖0x00‖content` is not injective: `\0` may appear in both `messageId` and `content`, so `(X, "Y\0Z")` and `(X\0Y, "Z")` collide. Gated by MTAs stripping NUL from headers, but a design defect — fields must be length-prefixed. |
| C6 | Medium | Confirmed | Trim asymmetry. The sender digests untrimmed `text`/`html`; the parser stores them `.trim()`ed. Any prose with a trailing newline — near-universal — false-reports `modified`, training agents to ignore the signal; and surrounding-whitespace tampering is invisible **even under a signed digest**. |
| C7 | Medium | Confirmed | Caller-supplied reserved `ACCP-*` headers are emitted verbatim (the sender-side companion to C0's receive-side forge). |
| C8 | Medium | Confirmed | Attachments are never committed — `COMMITTED_PARTS` is `payload`/`text`/`html` only. A MITM can add, replace or drop an attachment with `verified` unchanged, even when the payload says "see attached invoice". |
| C9 | Low–Med | Confirmed | `alg` is never verified — `checkIntegrity` never reads `declared.alg`, and `partDigest` is hard-wired to SHA-256. A header claiming `alg=bogus-md4` is accepted and reported `verified`. No downgrade protection. |
| C10 | Medium | Confirmed | The envelope is not bound. `From`/`To`/`Subject`/date are outside the commitment, so a valid payload can be re-enveloped under a spoofed sender/subject and still read `verified`. |

### Specification / guidance defects

| # | Severity | Status | Summary |
|---|----------|--------|---------|
| S1 | High | Confirmed | `agents.md` defines `verified` as "byte-for-byte what the sender wrote", unconditionally. Against an active attacker that is only true under a DKIM signature covering the header — and **SES Easy DKIM, which this platform uses, signs a fixed header set and cannot cover `ACCP-Content-Digest`**, so I-2 is unimplementable here and `verified` never carries the strong meaning. No field even exposes DKIM header coverage. |
| S2 | High | Confirmed | No stated decision rule. `verified` + `dmarc: PASS` is attacker-writable when DMARC passes on SPF alone. Neither doc says "for a payload you act on, require `dkim: PASS`." |
| S3 | High | Confirmed | Wholesale replay is unhandled in the Core profile (zero dedup requirements), and §9.2's Message-ID rationale claims to fix "replay" when it fixes only *splicing*. Email is at-least-once, so even non-adversarial redelivery double-acts. `ACCP-Expires` / `ACCP-Idempotency-Key` are optional-inside-optional. |
| S4 | High | Confirmed | Appendix A — the flagship worked example — carries `application/accp+json` parts and **no `ACCP-Content-Digest`**, violating its own I-1 and normalizing unverified traffic. `unverified` is framed as a benign sender choice rather than a possible stripped header. |
| S5 | Medium | Confirmed | The digest covers the `context` bytes (principal, delegation) along with the payload. Neither §9.2 nor the `agents.md` table says "`verified` ≠ context is true", inviting an intact-lie trust ladder — the confused deputy §6.3 warns about. |
| S6 | Medium | Confirmed | Appendix C.4 binds zero-knowledge proofs to `ACCP-Payload-Digest` — the legacy header I-6 says a receiver MUST NOT emit — and repeats the splice-vs-replay conflation. |

Attacks attempted and defeated are listed under [What held](#what-held).

---

### F1 — The root check verifies the header against itself *(High)*

`src/inbound/ingest.ts`, `checkIntegrity`:

```js
if (contentRoot(messageId, declared.leaves) !== declared.root) {
  if (!modifiedParts.includes('root')) modifiedParts.push('root');
}
```

`declared.leaves` and `declared.root` both come from the **header**
(`parseContentDigest`). So this recomputes the root from the header's own
claimed leaves and compares it to the header's own claimed root. It is an
internal-consistency check on the header, and says nothing whatever about the
content.

Demonstrated:

```
contentRoot(id, declared.leaves) === declared.root  →  true  (always, regardless of content)
```

The root — the one element borrowed directly from Merkle trees — therefore does
no work. This is a pointed irony, because the spec explicitly boasts about *not*
copying a Merkle tree while keeping the one part of it (the root) that, as
wired, is inert.

**Consequence.** The `root` entry in `modified_parts` can never fire on a
content change, so the root contributes nothing to the payload verdict. The
per-leaf checks still catch payload modification (F1 does not break claim 1),
but the binding the root was added to provide — that parts were not
substituted, reordered or dropped — is not actually enforced by this check.

**Candidate fix (to reconcile with agent findings before applying).** Either:

- **(A) Delete the root.** The header lists every leaf and DKIM signs the whole
  field, so per-leaf comparison already detects modification and stripping (a
  stripped body part leaves its declared leaf with no content to match → the
  part reports `modified`). A Merkle root earns its place only when leaves are
  *withheld* to enable membership proofs; here none are. This is the honest
  endpoint of the spec's own "we didn't copy a tree" argument.
- **(B) Make the root content-derived.** Recompute leaves from content, rebuild
  the root from those, compare to `declared.root`. This makes the check
  meaningful but fully redundant with the per-leaf checks — belt-and-suspenders,
  and absent DKIM an attacker recomputes root and leaves together anyway.

Leaning toward (A): a security field that does nothing is worse than its
absence, because it invites false confidence.

---

### F2 — Duplicate-header injection via caller-supplied headers *(Medium)*

`buildRawMessage` emits caller-supplied `headers` verbatim, then appends the
computed `ACCP-Content-Digest`. A caller (or, on the receive side, a MITM
injecting a second header) produces two `ACCP-Content-Digest` lines:

```
ACCP-Content-Digest: alg=sha-256; root=FAKE; payload=FAKE      ← injected
ACCP-Content-Digest: alg=sha-256; root=<real>; payload=<real>  ← computed
```

`parseHeaders` joins duplicate header names with `, `, and `parseContentDigest`
splits on `;`/`=` taking the **first** occurrence of each field — so
`root=FAKE` and `payload=FAKE` win over the real values.

**Consequence.** A MITM who can read the payload can inject a duplicate header
whose leaves match the (possibly altered) payload, forcing `verified`; or inject
garbage to force `modified` (confusion / denial of the signal). Absent DKIM this
is subsumed by the general "attacker rewrites an unsigned digest" limitation,
but the *duplicate-header* vector also interacts badly with DKIM, whose
multiple-header canonicalization rules differ from this parser's "first wins."

**Candidate fix.** (1) The builder MUST strip/reject reserved `ACCP-*` names
from caller-supplied `headers`. (2) The verifier MUST treat *more than one*
`ACCP-Content-Digest` header as `unverified`/`modified`, never silently
concatenate — a duplicated security-critical header is a red flag, not input to
merge.

---

### F3 — Id-less messages lose replay binding *(Medium)*

Every leaf and the root hash the `Message-ID` to bind the commitment to its
message (the anti-replay property, claim 3). When `parsed.messageId` is absent
or empty, every hash binds to the empty string:

```
buildContentDigest("", {payload})  and  buildContentDigest("", {payload})   →  identical leaves
```

**Consequence.** An attacker who strips the `Message-ID` from a captured message
can replay its (digest, payload) pair onto another id-less message and it
verifies. RFC 5322 requires a `Message-ID` and the builder always emits one, but
nothing on the *receive* path requires it.

**Candidate fix.** A receiver MUST treat a payload-bearing message with no
`Message-ID` as `unverified` (the commitment cannot be bound, so it cannot be
trusted), and the spec MUST state that the Message-ID binding is load-bearing,
not decorative.

---

## What held

Attacks tried and defeated, recorded so they are not re-litigated:

- **base64 padding in the header.** Leaf/root values contain `=` padding.
  `parseContentDigest` splits each field on its *first* `=`, so `payload=abc123=`
  parses key `payload`, value `abc123=`. Round-trips correctly.
- **`;` injection through a base64 value.** The base64 alphabet is
  `A–Za–z0–9+/=` — no `;` — so a leaf value cannot break the `;`-delimited field
  split, and only the hash of content ever appears in the header.
- **Legacy-digest downgrade (I-6).** Both red-teamers confirmed independently
  that `HEADER_PAYLOAD_DIGEST` is declared but **never verified anywhere** — the
  constant is unused. There is no legacy verification path to downgrade *into*,
  so "present both headers to force the weaker digest" does not work. (The gap is
  C3, header-strip → `unverified`, not legacy confusion.)
- **Cross-slot leaf substitution.** Moving the `html` leaf into the `payload`
  slot is blocked — `partDigest` mixes the part name into the hash, so slots are
  not interchangeable. This is the one guarantee domain separation actually
  delivers as built.

---

## The reconciled fix plan

To apply in one pass once the implementation red-team lands. Grouped by whether a
change is code or wording.

**Code**

0. **Kill the duplicate-header forge (C0, C7).** Treat more than one
   `ACCP-Content-Digest` on ingest as `digest_missing`, never merge duplicate
   values into one. Strip caller-supplied reserved `ACCP-*` from outbound
   `headers`. This is the critical fix and lands first.
1. **Make the root do work (C1, C2).** Recompute the root from the
   *content-derived* leaves over a **fixed, full part set** (`payload`, `text`,
   `html` always), so a committed-then-dropped part fails the root instead of
   being skipped. Report the payload verdict from the root plus per-leaf
   diagnosis. This is the change the dead `recomputed` variable was reaching for.
2. **Distinguish a stripped digest (C3).** A 0.2 message carrying an
   `application/accp+json` part with no `ACCP-Content-Digest` gets a distinct
   `digest_missing` verdict, surfaced to the agent as "treat like `modified`",
   not the neutral `unverified`.
3. **Require a Message-ID for a verdict (C4).** An empty/absent `Message-ID` on a
   payload-bearing message is `unverified` — the commitment cannot be bound, so
   it cannot be trusted.
4. **Length-prefix the hash fields (C5).** Replace `\0`-delimited concatenation
   with length-prefixed fields so the pre-image is injective regardless of
   content bytes.
5. **Digest prose over the bytes the receiver compares (C6).** Stop trimming on
   one side only — commit and verify over the same normalization.
6. **Reject duplicate and reserved headers (C7).** Strip caller-supplied
   `ACCP-*` from outbound `headers`; treat more than one `ACCP-Content-Digest`
   inbound as `digest_missing`, never merge.
7. **Expose what `verified` rests on (S1, S2).** Add `tamper_evident` (digest
   covered by a valid DKIM body hash) and `dmarc_method` (`spf`/`dkim`/`both`) to
   the receive-side data, so an agent can implement the real rule with fields
   rather than inference.
8. **Commit the attachments (C8).** Add an `attachments` leaf over the ordered
   set of attachment filename+content-type+content hashes, so a swapped or
   dropped attachment fails verification.
9. **Verify `alg`, and bind the envelope (C9, C10).** Reject an unrecognised
   `alg`; fold `From` and `Date` into the commitment so a re-enveloped payload
   does not read `verified`.

**Wording**

8. **Reword `verified` (S1, S2, S5).** In `agents.md` and §9.2: `verified` means
   the digest matched; it is tamper-evidence only under DKIM body coverage; for a
   payload you act on, require `dkim: PASS` (DMARC-via-SPF attests nothing); and
   `verified` covers the context bytes but still proves nothing about the
   principal claim — an intact lie is intact.
9. **Put replay in the threat model (S3).** A Core dedup requirement on
   `(sender domain, Message-ID)`; a MUST that side-effecting `request`s set
   `ACCP-Idempotency-Key`; a §10 entry naming replay.
10. **Fix Appendix A (S4)** to carry the digest its own I-1 mandates, and reword
    the `unverified` guidance as a possible stripped header, not a benign choice.
11. **Fix Appendix C.4 (S6)** to bind proofs to the `root` of
    `ACCP-Content-Digest`, not the forbidden legacy `ACCP-Payload-Digest`.

## Verdict

The `ACCP-Content-Digest` scheme as shipped in commit `96d2256` is **not fit to
be relied on.** Against an active attacker it provides a critical forge (C0), no
set-binding (C1/C2), a soft downgrade on stripping (C3), no replay defence
(S3), and no coverage of attachments or envelope (C8/C10); against honest mail
it false-flags a trailing newline (C6). And on this platform specifically,
`verified` can never mean tamper-evidence, because SES Easy DKIM cannot sign the
header the guarantee depends on (S1).

The design ideas remain sound — commit per part, bind to context, separate hash
domains — but the implementation delivered almost none of them, and the spec
oversold what a bare digest can promise. The reconciled fix plan above is the
work; until it lands, the honest verdict for an agent is that
`payload_integrity: verified` means only "a self-consistent hash arrived", which
against the adversary this protocol names is worth nothing.

This document is the record of getting there. Every finding was executed against
built code; the attacks that failed are listed so they are not re-run; and the
one finding the author first failed to reproduce is called out, because a review
that hides its own missteps is not one you should trust either.
