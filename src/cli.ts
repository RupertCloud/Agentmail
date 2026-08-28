#!/usr/bin/env node
import { configWarnings } from './deployment.js';
import { createServer } from './http/server.js';
import { Platform } from './platform.js';

const command = process.argv[2] ?? 'serve';

async function serve(seedDemo: boolean): Promise<void> {
  const platform = new Platform();
  platform.start();

  if (seedDemo) await seed(platform);

  const server = createServer(platform);
  server.listen(platform.config.port, platform.config.host, () => {
    process.stdout.write(
      `agentmail listening on http://${platform.config.host}:${platform.config.port}\n` +
        `  store:    ${platform.config.store}\n` +
        `  provider: ${platform.provider.name}\n` +
        `  agents:   *@<account>.${platform.config.agentDomain}\n`,
    );
    for (const warning of configWarnings(platform.config, platform.provider.name)) {
      process.stderr.write(`  WARNING: ${warning}\n`);
    }
  });

  const shutdown = () => {
    server.close(() => {
      void platform.close().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Seeds an account with two agents that can talk to each other immediately. */
async function seed(platform: Platform): Promise<void> {
  const { account } = await platform.accounts.createAccount({
    name: 'Demo',
    slug: 'demo',
    ownerEmail: 'owner@demo.test',
  });
  const admin = await platform.accounts.createApiKey(account.id, 'demo-admin', 'full');

  const lines = [`account: ${account.slug} (${account.id})`, `admin key: ${admin.secret}`];

  for (const [slug, description, capabilities] of [
    ['researcher', 'Answers research questions and cites sources.', ['research.query']],
    ['scheduler', 'Finds meeting times and books them.', ['calendar.schedule']],
  ] as const) {
    const agent = await platform.agents.create(account, {
      slug,
      displayName: slug,
      description,
      capabilities: [...capabilities],
      inboxPolicy: 'open',
      discoverable: true,
    });
    const key = await platform.accounts.createApiKey(account.id, `${slug}-key`, 'agent', {
      agentId: agent.id,
    });
    lines.push(`agent ${agent.address} -> ${agent.id}`, `  key: ${key.secret}`);
  }

  process.stdout.write(`${lines.join('\n')}\n\n`);
}

switch (command) {
  case 'serve':
    await serve(false);
    break;
  case 'demo':
    await serve(true);
    break;
  default:
    process.stderr.write(
      'usage: agentmail <command>\n\n' +
        '  serve   start the API and background workers\n' +
        '  demo    same, with a seeded account and two agents printed to stdout\n',
    );
    process.exit(1);
}
