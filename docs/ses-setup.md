# Wiring up SES

What you set, what AWS has to have, and what the customer pastes into DNS.

Out of the box the platform runs on a memory provider that records what it
*would* have sent. Nothing leaves the process. This is what turns that into
real mail.

---

## 1. What you set

Copy [`.env.example`](../.env.example) to `.env` and fill in:

```bash
AGENTMAIL_PROVIDER=ses
AWS_REGION=eu-west-1                 # SES Tenants are region-scoped (C-2)
AWS_ACCOUNT_ID=123456789012          # aws sts get-caller-identity --query Account --output text
AGENTMAIL_DOMAIN=agentmail.example   # a domain you control
AGENTMAIL_SECRET=$(openssl rand -base64 32)
```

Install the SDK, which is an optional dependency:

```bash
npm install --include=optional
```

Credentials come from the AWS SDK's default provider chain. **Prefer an
instance role, ECS task role or IRSA and set no keys at all.** If you must use
static keys, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are read from the
environment — never commit them, and never put them in the repository.

`AWS_ACCOUNT_ID` is not decoration. SES does not return ARNs when it creates an
identity, and tenant association takes an ARN, so the platform constructs
`arn:aws:ses:<region>:<account>:identity/<domain>` itself. Get it wrong and
every association fails.

## 2. IAM policy

The smallest policy that lets the platform provision and send:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Send",
      "Effect": "Allow",
      "Action": ["ses:SendEmail"],
      "Resource": "*"
    },
    {
      "Sid": "Provision",
      "Effect": "Allow",
      "Action": [
        "ses:CreateTenant",
        "ses:DeleteTenant",
        "ses:CreateTenantResourceAssociation",
        "ses:CreateConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:CreateEmailIdentity",
        "ses:DeleteEmailIdentity",
        "ses:GetEmailIdentity",
        "ses:PutEmailIdentityMailFromAttributes"
      ],
      "Resource": "*"
    }
  ]
}
```

Narrow `Resource` to your own identity and configuration-set ARNs once the
naming is settled. `ses:SendEmail` is the only action on the hot path; the rest
run once per account or domain.

## 3. What the account gets, automatically

Creating an account calls `CreateTenant`. The tenant is the isolation boundary
in SRS §3.1 — every send passes `TenantName`, and SES refuses the send if the
identity, configuration set or template does not belong to that tenant. This is
what stops one customer's behaviour reaching another's delivery.

Adding a domain (`POST /v1/domains`) then does five things in order:

1. `CreateConfigurationSet` — with reputation metrics on and bounce/complaint
   suppression enabled.
2. `CreateEmailIdentity` — with `DkimSigningAttributes.NextSigningKeyLength =
   RSA_2048_BIT` (DR-1). **The response carries the three DKIM tokens.**
3. `PutEmailIdentityMailFromAttributes` — the custom MAIL FROM subdomain, with
   `BehaviorOnMxFailure = REJECT_MESSAGE` so a broken MX fails loudly instead of
   silently falling back to `amazonses.com` and breaking SPF alignment (DR-2).
4. `CreateTenantResourceAssociation` for the identity.
5. `CreateTenantResourceAssociation` for the configuration set.

The DKIM tokens in the DNS records the API returns are **the ones AWS
generated**. Before this was wired, the platform invented them locally, which
produced records that looked right and could never verify. If you see
`.dkim.agentmail.test` in a record, you are still on the local control plane.

## 4. What the customer pastes into DNS

`POST /v1/domains` returns the records; the customer publishes them:

| Type | Name | Value |
|---|---|---|
| CNAME | `<token1>._domainkey.acme.com` | `<token1>.dkim.amazonses.com` |
| CNAME | `<token2>._domainkey.acme.com` | `<token2>.dkim.amazonses.com` |
| CNAME | `<token3>._domainkey.acme.com` | `<token3>.dkim.amazonses.com` |
| MX | `mail.acme.com` | `10 feedback-smtp.<region>.amazonses.com` |
| TXT | `mail.acme.com` | `v=spf1 include:amazonses.com ~all` |
| TXT | `acme.com` | `v=spf1 include:amazonses.com ~all` |

Then `POST /v1/domains/{id}/verify` re-resolves every record **and** reads
`GetEmailIdentity`. A domain is only verified when DNS resolves *and* SES
reports `VerifiedForSendingStatus`. DNS propagating is not the same as SES
having noticed, and the response says so rather than letting you think you are
ready to send.

The same call runs the three diagnostics that quietly destroy delivery: a DMARC
policy at `quarantine` or `reject` with nothing aligned to satisfy it, more than
one SPF record, and a MAIL FROM subdomain with no MX.

## 5. Delivery events

Bounces, complaints and deliveries reach the platform through
`POST /ingest/events`, authenticated with `x-agentmail-ingest-secret`.

Create an SNS topic, point the configuration set's event destination at it, and
subscribe the topic to that endpoint over HTTPS:

```bash
aws sesv2 create-configuration-set-event-destination \
  --configuration-set-name cs-acme-com \
  --event-destination-name events \
  --event-destination '{
    "Enabled": true,
    "MatchingEventTypes": ["SEND","DELIVERY","BOUNCE","COMPLAINT","REJECT","RENDERING_FAILURE","DELIVERY_DELAY"],
    "SnsDestination": {"TopicArn": "arn:aws:sns:eu-west-1:123456789012:agentmail-events"}
  }'
```

Hard bounces and complaints suppress the recipient automatically; soft bounces
suppress on the third failure.

**Not built:** nothing translates SNS's envelope into the notification shape
`/ingest/events` expects. Today that endpoint takes the platform's own shape
(`provider_message_id`, `type`, `bounce_type`, `recipients`). An SNS adapter is
a small piece of work and is not in this repository.

## 6. Inbound

Receiving is what makes an agent reachable, and it needs SES receipt rules,
which are **not** provisioned here. You need to:

1. Publish an MX record for the agent domain pointing at
   `inbound-smtp.<region>.amazonses.com`.
2. Create a receipt rule set with a rule that stores the message in S3 and
   notifies SNS.
3. Run something that reads the S3 object and posts it to `/ingest/inbound` as
   `{"raw": "...", "recipients": [...], "verdicts": {...}}`.

Step 3 is typically a small Lambda. The platform end of it is finished and
tested — parsing, inbox policy, threading, delivery — but that Lambda is not in
this repository. Receipt rules are also only available in a subset of regions;
check before choosing one.

## 7. Before you send to a real person

- **Get out of the sandbox.** A new SES account can only send to verified
  addresses. Request production access, and raise the sending quota ahead of
  growth (C-1).
- **Keep the internal ceilings below AWS's.** New accounts start at 100
  messages/day here; SES suspends on aggregate bounce and complaint rates, and
  the platform should refuse before AWS does.
- **Check your own DMARC.** The platform warns customers about a strict policy
  with nothing aligned. Run the same check on `AGENTMAIL_DOMAIN`, because every
  hosted agent address inherits it.

## 8. Verifying it works

```bash
AGENTMAIL_PROVIDER=ses AWS_REGION=eu-west-1 AWS_ACCOUNT_ID=... node dist/src/cli.js serve
```

Then add a domain and confirm the DKIM values end in `.dkim.amazonses.com`. If
they end in your platform domain, `AGENTMAIL_PROVIDER` is not set to `ses` and
you are still on the local control plane.

The provisioning path is covered by tests against a fake control plane, which
prove the call sequence and that the issued tokens reach the DNS records. **It
has not been exercised against a live AWS account** — the ARN formats, enum
values and request shapes are verified against the SESv2 SDK's own type
definitions, not against the service.
