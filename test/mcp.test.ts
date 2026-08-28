import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AgentMailClient } from '../src/client.js';
import { AgentMailMcpServer } from '../src/mcp/server.js';
import { newHarness, seedAccount, seedAgent, startServer } from './helpers.js';

/** Drives the MCP server over its stdio framing, one request at a time. */
class McpHarness {
  private readonly input = new PassThrough();
  private readonly output = new PassThrough();
  private readonly pending = new Map<number, (value: any) => void>();
  private nextId = 1;
  private buffer = '';

  constructor(server: AgentMailMcpServer) {
    void server.serve(this.input, this.output);
    this.output.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) {
          const message = JSON.parse(line);
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
        }
        index = this.buffer.indexOf('\n');
      }
    });
  }

  call(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    const promise = new Promise<any>((resolve) => this.pending.set(id, resolve));
    this.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const response = await this.call('tools/call', { name, arguments: args });
    return response.result;
  }

  close(): void {
    this.input.end();
  }
}

test('the MCP server exposes a mailbox as tools and round-trips a conversation', async (t) => {
  const { platform, provider } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { agent: buyer, apiKey: buyerKey } = await seedAgent(platform, account, 'buyer');
  const { agent: seller, apiKey: sellerKey } = await seedAgent(platform, account, 'seller', {
    discoverable: true,
    capabilities: ['quote.request'],
    description: 'Quotes widgets',
  });
  const server = await startServer(platform);

  const buyerMcp = new McpHarness(
    new AgentMailMcpServer(new AgentMailClient({ baseUrl: server.baseUrl, apiKey: buyerKey })),
  );
  const sellerMcp = new McpHarness(
    new AgentMailMcpServer(new AgentMailClient({ baseUrl: server.baseUrl, apiKey: sellerKey })),
  );

  t.after(async () => {
    buyerMcp.close();
    sellerMcp.close();
    await server.close();
    await platform.close();
  });

  const initialized = await buyerMcp.call('initialize', {});
  assert.equal(initialized.result.serverInfo.name, 'agentmail');
  assert.ok(initialized.result.protocolVersion);

  const tools = await buyerMcp.call('tools/list', {});
  const names = tools.result.tools.map((tool: { name: string }) => tool.name);
  for (const expected of ['whoami', 'wait_for_message', 'send_message', 'reply_to_message', 'ack_message']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }

  // whoami binds the server to its own agent id.
  const me = await buyerMcp.tool('whoami');
  assert.equal(me.structuredContent.address, buyer.address);
  await sellerMcp.tool('whoami');

  const found = await buyerMcp.tool('find_agents', { capability: 'quote.request' });
  assert.equal(found.structuredContent.data[0].address, seller.address);

  const waiting = sellerMcp.tool('wait_for_message', { timeout_seconds: 5, claim: true });

  const sent = await buyerMcp.tool('send_message', {
    to: [seller.address],
    subject: 'Quote request',
    structured: { sku: 'WIDGET-1', quantity: 40 },
  });
  assert.equal(sent.structuredContent.transport, 'internal');

  const arrived = await waiting;
  const inbound = arrived.structuredContent.data[0];
  assert.deepEqual(inbound.structured, { sku: 'WIDGET-1', quantity: 40 });

  const replied = await sellerMcp.tool('reply_to_message', {
    message_id: inbound.id,
    structured: { unit_price: 12 },
    text: '12 each.',
  });
  assert.equal(replied.structuredContent.thread_id, inbound.thread_id);

  const acked = await sellerMcp.tool('ack_message', { message_id: inbound.id });
  assert.equal(acked.structuredContent.mailbox_state, 'acked');

  const buyerInbox = await buyerMcp.tool('list_messages', {});
  assert.equal(buyerInbox.structuredContent.data.length, 1);
  assert.deepEqual(buyerInbox.structuredContent.data[0].structured, { unit_price: 12 });

  assert.equal(provider.sent.length, 0);
});

test('MCP tool errors come back as tool results, not transport failures', async (t) => {
  const { platform } = newHarness();
  const { account } = await seedAccount(platform, 'acme');
  const { apiKey } = await seedAgent(platform, account, 'solo');
  const server = await startServer(platform);
  const mcp = new McpHarness(
    new AgentMailMcpServer(new AgentMailClient({ baseUrl: server.baseUrl, apiKey })),
  );
  t.after(async () => {
    mcp.close();
    await server.close();
    await platform.close();
  });

  await mcp.tool('whoami');
  const result = await mcp.tool('read_message', { message_id: 'msg_does_not_exist' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/i);

  const unknown = await mcp.call('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.match(unknown.error.message, /Unknown tool/);
});
