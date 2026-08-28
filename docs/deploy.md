# Deploying

The service is a single Node process with no required dependencies. It listens
on `PORT`, binds `0.0.0.0`, and answers `/health`.

```bash
npm ci --include=optional
npm run build
node dist/src/cli.js serve
```

The `Dockerfile` pins the build, so a deploy is reproducible rather than
configured in a console:

```bash
docker build -t agentmail .
docker run --rm -p 8080:8080 -e AGENTMAIL_SECRET="$(openssl rand -base64 32)" agentmail
```

It is a two-stage build. The runtime stage installs production dependencies only
— `--omit=dev --include=optional`, which drops TypeScript and keeps the AWS SDK
that the SES provider imports lazily — copies `dist/src` and the migrations, and
runs as the non-root `node` user. `PORT` is read from the environment, so a
platform that injects one works unchanged.

> **Not `railway.json`.** Railway's Config as Code is deprecated: existing config
> files keep working until 2026-12-01, and from 2026-08-28 a service that never
> used it cannot opt in. A `railway.json` added now would be silently ignored on
> such a service. A Dockerfile does the same job, is not deprecated, and is not
> specific to one host. Railway builds from it automatically when it is present.

---

## Environment variables

[`.env.example`](../.env.example) has the full set. Four matter before anyone
else can reach the service:

| Variable | Why it matters |
|---|---|
| `AGENTMAIL_SECRET` | Signs unsubscribe tokens and authenticates the ingest endpoints. **Unset means the published default, which is in this repository.** |
| `AGENTMAIL_STORE` | `memory` loses everything on restart |
| `AGENTMAIL_PROVIDER` | `memory` accepts messages and sends nothing |
| `AGENTMAIL_DOMAIN` | The domain hosted agent addresses are issued under |

### AGENTMAIL_SECRET

```bash
openssl rand -base64 32
```

Set it before the service is publicly reachable. Without it, `/ingest/inbound`
and `/ingest/events` **fail closed with 503** rather than accept a secret that
anyone who can read the repository already knows. Leaving it unset does not
expose the endpoints; it disables them.

Unsubscribe links keep working either way, because breaking a working
unsubscribe is a compliance problem (NFR-4.3) and the failure mode of a guessable
secret there — a forged unsubscribe — is much less severe than mail injected
into an arbitrary mailbox.

## Checking a deployment

`/health` reports what is wrong, not just that the process is up:

```json
{
  "status": "ok",
  "provider": "memory",
  "store": "memory",
  "queue_depth": {"transactional": 0, "campaign": 0},
  "dead_letters": 0,
  "warnings": [
    "AGENTMAIL_SECRET is unset; inbound and event ingest are disabled.",
    "Store is in-memory: all accounts, mailboxes and messages are lost on restart.",
    "Provider is in-memory: accepted messages are recorded but never sent."
  ]
}
```

An empty `warnings` array is the thing to aim for. The same warnings are written
to stderr at startup.

## What a public deployment needs

A deployment reachable from the internet is not finished until:

1. **`AGENTMAIL_SECRET` is set.** Otherwise ingest is disabled.
2. **The store is durable.** `AGENTMAIL_STORE=memory` means a restart — which a
   platform does routinely, on deploy, on scaling, on host maintenance — silently
   discards every account, agent, mailbox and message. The Postgres adapter is
   not built yet, so today this is a limit to design around, not to configure
   away.
3. **The provider sends.** See [`ses-setup.md`](ses-setup.md).
4. **`AGENTMAIL_DOMAIN` is a domain you control**, with DKIM and DMARC published
   for it. Every hosted agent address inherits its reputation.
5. **`AGENTMAIL_PUBLIC_URL` matches the real hostname**, or unsubscribe links
   point somewhere that does not resolve.

## Bootstrapping the first account

There is no sign-up flow (FR-1.1 is unimplemented), so the first account is
created in-process. `node dist/src/cli.js demo` does it and prints the keys —
convenient for evaluation, and not something to run on a deployment holding real
data, since it prints credentials to stdout and into your platform's logs.

## Scaling

The queue and the mailbox notifier are in-process today, so **run one instance**.
Two would each drain their own queue and neither would see the other's
long-polling agents. Multi-instance operation needs the Postgres store and SQS
queues; the ports exist for both.
