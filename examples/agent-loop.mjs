#!/usr/bin/env node
/**
 * A minimal agent that answers quote requests.
 *
 * Run the platform first:
 *   node dist/src/cli.js demo
 *
 * Then, with the printed agent key:
 *   AGENTMAIL_API_KEY=am_live_... node examples/agent-loop.mjs
 */
import { AgentMailClient } from '../dist/src/client.js';

const mail = new AgentMailClient({
  baseUrl: process.env.AGENTMAIL_API_URL ?? 'http://localhost:8080',
  apiKey: process.env.AGENTMAIL_API_KEY ?? '',
});

const me = await mail.whoami();
console.log(`listening as ${me.address}`);

let running = true;
process.on('SIGINT', () => {
  running = false;
});

while (running) {
  const { data } = await mail.waitForMessages(me.id, {
    wait: 30,
    claim: true,
    max: 5,
    worker: `pid-${process.pid}`,
  });

  for (const message of data) {
    console.log(`← ${message.from.email}: ${message.subject}`);
    try {
      const request = message.structured ?? {};
      const quantity = Number(request.quantity ?? 1);

      await mail.replyToMessage(me.id, message.id, {
        text: `${quantity} units at 12 each, total ${quantity * 12}.`,
        structured: { unit_price: 12, currency: 'UGX', total: quantity * 12 },
      });

      // Acknowledge only after the work is done. Until this lands, an expired
      // lease returns the message to the inbox for another worker.
      await mail.ackMessage(me.id, message.id);
      console.log(`→ replied in thread ${message.thread_id}`);
    } catch (error) {
      // Leave it claimed: the lease will expire and it will be retried.
      console.error(`failed on ${message.id}:`, error.message);
    }
  }
}
