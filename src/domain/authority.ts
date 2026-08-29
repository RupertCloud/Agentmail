import type { AccpContext, Agent, AuthorityAssessment, Message } from '../types.js';
import { domainOf } from '../util/email.js';

/**
 * Fields a sender must never be able to set, because they are the receiver's
 * findings about that sender. `context` is otherwise passed through unmodified
 * (§6.4 C-1), but a sender that could pre-populate its own verdict would make
 * the verdict meaningless — the same reason `buildRawMessage` refuses a
 * caller-supplied content digest.
 */
export const RESERVED_CONTEXT_FIELDS = ['authority', 'integrity', 'verified', 'trust'] as const;

/** Removes reserved fields from inbound context. Returns a copy. */
export function stripReservedContext(context: unknown): AccpContext | null {
  if (!context || typeof context !== 'object') return null;
  const copy: Record<string, unknown> = { ...(context as Record<string, unknown>) };
  for (const field of RESERVED_CONTEXT_FIELDS) delete copy[field];
  return copy as AccpContext;
}

/**
 * The domain a principal id resolves to. Principals appear as bare domains
 * (`acme.test`), addresses (`buyer@acme.test`) and prefixed chain entries
 * (`person:ada@acme.test`), so all three are handled.
 */
export function principalDomain(id: string | undefined | null): string | null {
  if (!id) return null;
  const bare = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const trimmed = bare.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes('@')) return domainOf(trimmed) || null;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(trimmed) ? trimmed : null;
}

/** True when `claimed` is the authenticated domain or a subdomain of it. */
function alignsWith(claimed: string, authenticated: string): boolean {
  return claimed === authenticated ||
    claimed.endsWith(`.${authenticated}`) ||
    authenticated.endsWith(`.${claimed}`);
}

/**
 * Assesses what actually backs a message's `context.principal` claim.
 *
 * ACCP §6.2 says context is asserted rather than proved, and stops there. That
 * leaves a receiver with a claim and no record of how much to make of it — the
 * confused-deputy shape of §6.3, since acting on an unbacked "I speak for Acme"
 * is precisely acting on an authority nobody checked.
 *
 * There is exactly one piece of evidence available without a key-distribution
 * scheme: DKIM tells us which domain signed the message, so a principal naming
 * that same domain is one the signing domain is willing to be seen asserting.
 * That is domain-level `speaks for` and nothing stronger. A principal naming a
 * *different* domain is a bare claim: the domain being spoken for never signed
 * anything, and no amount of confidence in the sender changes that.
 *
 * So this does not prove authority. It records the distinction, which is the
 * part §6.2 was missing.
 */
export function assessAuthority(
  context: AccpContext | null | undefined,
  authResults: Message['authResults'],
  fromEmail: string,
  agent: Pick<Agent, 'maxDelegationDepth'>,
): AuthorityAssessment {
  const claimed = context?.principal?.id ?? null;
  const chain = context?.delegation?.chain ?? [];
  const declaredDepth = context?.delegation?.depth ?? null;

  // Depth is self-reported, so the only check available is internal: a chain
  // longer than the depth it declares is understating how far the authority
  // has travelled, which is the direction an attacker would understate in.
  const delegationConsistent = declaredDepth == null || chain.length === 0
    ? true
    : declaredDepth >= chain.length;
  const effectiveDepth = Math.max(declaredDepth ?? 0, chain.length);
  const depthExceeded = effectiveDepth > agent.maxDelegationDepth;

  const base = {
    claimed,
    claimedDomain: principalDomain(claimed),
    authenticatedDomain: null as string | null,
    delegationDepth: declaredDepth,
    delegationConsistent,
    depthExceeded,
  };

  if (!claimed) {
    return { ...base, verdict: 'none', reason: 'No principal was claimed.' };
  }

  const dkim = (authResults?.dkim ?? '').toLowerCase();
  if (dkim !== 'pass') {
    return {
      ...base,
      verdict: 'unauthenticated',
      reason:
        `A principal (${claimed}) is claimed, but DKIM did not pass, so there is no ` +
        'authenticated domain to align it against.',
    };
  }

  const authenticated = domainOf(fromEmail) || null;
  const claimedDomain = base.claimedDomain;
  if (!authenticated || !claimedDomain) {
    return {
      ...base,
      authenticatedDomain: authenticated,
      verdict: 'unaligned',
      reason: `The principal (${claimed}) does not resolve to a domain that can be aligned.`,
    };
  }

  if (alignsWith(claimedDomain, authenticated)) {
    return {
      ...base,
      authenticatedDomain: authenticated,
      verdict: 'aligned',
      reason:
        `The signing domain (${authenticated}) is the domain claimed, so it vouches for ` +
        'the principal at domain level. This is not proof the named party authorised anything.',
    };
  }

  return {
    ...base,
    authenticatedDomain: authenticated,
    verdict: 'unaligned',
    reason:
      `${authenticated} signed this message but claims to speak for ${claimedDomain}, ` +
      'which signed nothing. Treat the principal as unbacked.',
  };
}

/**
 * Whether a message's principal claim is strong enough to act on as authority.
 *
 * Deliberately strict, and deliberately conjunctive with payload integrity:
 * knowing who is speaking is worthless if the instruction they are carrying was
 * rewritten in transit, and an intact instruction is worthless if the authority
 * behind it is a claim nobody checked.
 */
export function mayActAsPrincipal(message: Message): boolean {
  const authority = message.authority;
  if (!authority || authority.verdict !== 'aligned') return false;
  if (authority.depthExceeded || !authority.delegationConsistent) return false;
  if (message.payloadIntegrity !== 'verified') return false;
  return (message.authResults?.dkim ?? '').toLowerCase() === 'pass';
}
