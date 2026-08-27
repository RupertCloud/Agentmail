import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AgentMailClient, AgentMailError } from '../client.js';

const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, agentId: string) => Promise<unknown>;
}

function stringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value == null) {
    if (required) throw new Error(`\`${name}\` is required.`);
    return '';
  }
  return String(value);
}

/**
 * MCP server exposing one agent's mailbox as tools.
 *
 * The credential it is given is an agent-scoped API key, so the surface it can
 * reach is exactly one mailbox: an agent handed this server cannot read another
 * agent's mail or send as anyone else, whatever it is prompted to do.
 */
export class AgentMailMcpServer {
  private readonly tools: ToolDefinition[];
  private agentId = 'me';

  constructor(private readonly client: AgentMailClient) {
    this.tools = this.defineTools();
  }

  async serve(input: Readable, output: Writable): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line);
      } catch {
        this.write(output, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      const response = await this.dispatch(request);
      if (response) this.write(output, response);
    }
  }

  private write(output: Writable, payload: unknown): void {
    output.write(`${JSON.stringify(payload)}\n`);
  }

  private async dispatch(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    // Notifications carry no id and take no response.
    const isNotification = request.id === undefined;

    try {
      const result = await this.handleMethod(request.method, request.params ?? {});
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: request.id ?? null, result };
    } catch (error) {
      if (isNotification) return null;
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof AgentMailError ? -32000 : -32603;
      return { jsonrpc: '2.0', id: request.id ?? null, error: { code, message } };
    }
  }

  private async handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agentmail', version: '0.1.0' },
          instructions:
            'Mailbox tools for this agent. Poll with wait_for_message, act on what arrives, ' +
            'then ack_message so the work is not redelivered. Reply with reply_to_message so ' +
            'the conversation stays threaded.',
        };
      case 'notifications/initialized':
        return {};
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        };
      case 'tools/call': {
        const name = String(params.name ?? '');
        const tool = this.tools.find((candidate) => candidate.name === name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        const args = (params.arguments as Record<string, unknown>) ?? {};
        try {
          const result = await tool.handler(args, this.agentId);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result && typeof result === 'object' ? result : { result },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text', text: message }], isError: true };
        }
      }
      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  private defineTools(): ToolDefinition[] {
    const object = (properties: Record<string, unknown>, required: string[] = []) => ({
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    });

    return [
      {
        name: 'whoami',
        title: 'Identify this mailbox',
        description: 'Returns this agent\'s address, capabilities and inbox policy.',
        inputSchema: object({}),
        handler: async () => {
          const me = (await this.client.whoami()) as Record<string, unknown>;
          if (typeof me.id === 'string') this.agentId = me.id;
          return me;
        },
      },
      {
        name: 'wait_for_message',
        title: 'Wait for new mail',
        description:
          'Blocks until a message arrives in this mailbox or the timeout expires. Set claim to ' +
          'take a lease on what arrives so another worker will not pick up the same message.',
        inputSchema: object({
          timeout_seconds: { type: 'number', description: 'How long to wait, 0-60. Defaults to 25.' },
          claim: { type: 'boolean', description: 'Take a lease on what arrives. Defaults to true.' },
          max: { type: 'number', description: 'Maximum messages to return. Defaults to 1.' },
        }),
        handler: async (args, agentId) =>
          this.client.waitForMessages(agentId, {
            wait: Number(args.timeout_seconds ?? 25),
            claim: args.claim !== false,
            max: Number(args.max ?? 1),
          }),
      },
      {
        name: 'list_messages',
        title: 'List mailbox messages',
        description: 'Lists messages in this mailbox, newest first, optionally filtered by state or thread.',
        inputSchema: object({
          state: { type: 'string', enum: ['unread', 'claimed', 'acked', 'archived'] },
          thread_id: { type: 'string' },
          limit: { type: 'number' },
        }),
        handler: async (args, agentId) =>
          this.client.listMessages(agentId, {
            state: args.state ? String(args.state) : undefined,
            thread_id: args.thread_id ? String(args.thread_id) : undefined,
            limit: args.limit ? Number(args.limit) : undefined,
          }),
      },
      {
        name: 'read_message',
        title: 'Read a message',
        description: 'Returns one message in full, including its structured JSON payload if it carries one.',
        inputSchema: object({ message_id: { type: 'string' } }, ['message_id']),
        handler: async (args, agentId) => this.client.readMessage(agentId, stringArg(args, 'message_id')),
      },
      {
        name: 'read_thread',
        title: 'Read a conversation',
        description: 'Returns every message in a thread, oldest first, so the full exchange can be reasoned about.',
        inputSchema: object({ thread_id: { type: 'string' } }, ['thread_id']),
        handler: async (args, agentId) => this.client.readThread(agentId, stringArg(args, 'thread_id')),
      },
      {
        name: 'ack_message',
        title: 'Acknowledge a message',
        description:
          'Marks a claimed message as handled. Until this is called the lease will expire and the ' +
          'message will be redelivered to another worker.',
        inputSchema: object({ message_id: { type: 'string' } }, ['message_id']),
        handler: async (args, agentId) => this.client.ackMessage(agentId, stringArg(args, 'message_id')),
      },
      {
        name: 'release_message',
        title: 'Release a claimed message',
        description: 'Hands a claimed message back to the inbox without processing it.',
        inputSchema: object({ message_id: { type: 'string' } }, ['message_id']),
        handler: async (args, agentId) => this.client.releaseMessage(agentId, stringArg(args, 'message_id')),
      },
      {
        name: 'send_message',
        title: 'Send a message',
        description:
          'Sends mail as this agent. Recipients hosted on AgentMail are delivered internally in ' +
          'milliseconds; anything else goes out over normal email.',
        inputSchema: object(
          {
            to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
            subject: { type: 'string' },
            text: { type: 'string', description: 'Plain-text body for a human reader.' },
            html: { type: 'string' },
            structured: { type: 'object', description: 'Machine-readable payload for an agent recipient.' },
            in_reply_to: { type: 'string', description: 'Message-ID being answered, to stay in thread.' },
          },
          ['to'],
        ),
        handler: async (args) =>
          this.client.send({
            to: (args.to as string[]) ?? [],
            subject: args.subject ? String(args.subject) : undefined,
            text: args.text ? String(args.text) : undefined,
            html: args.html ? String(args.html) : undefined,
            structured: args.structured,
            in_reply_to: args.in_reply_to ? String(args.in_reply_to) : undefined,
          }),
      },
      {
        name: 'reply_to_message',
        title: 'Reply in thread',
        description: 'Replies to a message in this mailbox, preserving threading headers automatically.',
        inputSchema: object(
          {
            message_id: { type: 'string' },
            text: { type: 'string' },
            html: { type: 'string' },
            structured: { type: 'object' },
            subject: { type: 'string' },
          },
          ['message_id'],
        ),
        handler: async (args, agentId) =>
          this.client.replyToMessage(agentId, stringArg(args, 'message_id'), {
            text: args.text,
            html: args.html,
            structured: args.structured,
            subject: args.subject,
          }),
      },
      {
        name: 'find_agents',
        title: 'Find other agents',
        description:
          'Searches the public agent directory by name, description or capability, so this agent can ' +
          'discover who to talk to.',
        inputSchema: object({
          query: { type: 'string' },
          capability: { type: 'string' },
          limit: { type: 'number' },
        }),
        handler: async (args) =>
          this.client.findAgents({
            q: args.query ? String(args.query) : undefined,
            capability: args.capability ? String(args.capability) : undefined,
            limit: args.limit ? Number(args.limit) : undefined,
          }),
      },
    ];
  }
}
