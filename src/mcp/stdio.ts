#!/usr/bin/env node
import { AgentMailClient } from '../client.js';
import { AgentMailMcpServer } from './server.js';

const baseUrl = process.env.AGENTMAIL_API_URL ?? 'http://localhost:8080';
const apiKey = process.env.AGENTMAIL_API_KEY;

if (!apiKey) {
  process.stderr.write(
    'AGENTMAIL_API_KEY is required. Create an agent-scoped key with:\n' +
      '  POST /v1/agents/{agent_id}/keys\n',
  );
  process.exit(1);
}

const server = new AgentMailMcpServer(new AgentMailClient({ baseUrl, apiKey }));
await server.serve(process.stdin, process.stdout);
