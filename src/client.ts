/**
 * Thin HTTP client for the AgentMail API. Used by the MCP server and shipped
 * as the reference SDK an agent embeds directly.
 */

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class AgentMailError extends Error {
  constructor(readonly status: number, readonly type: string, message: string) {
    super(message);
    this.name = 'AgentMailError';
  }
}

export interface SendMessageInput {
  to: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  structured?: unknown;
  cc?: string | string[];
  reply_to?: string | string[];
  in_reply_to?: string;
  from?: string;
  tags?: Record<string, string>;
  scheduled_at?: string;
}

export class AgentMailClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 204) return {} as T;
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = (parsed as { error?: { type?: string; message?: string } }).error;
      throw new AgentMailError(
        response.status,
        error?.type ?? 'error',
        error?.message ?? `Request failed with ${response.status}`,
      );
    }
    return parsed as T;
  }

  /* mailbox */

  whoami() {
    return this.request('GET', '/v1/agents/me');
  }

  listMessages(agentId: string, params: { state?: string; thread_id?: string; limit?: number } = {}) {
    return this.request<{ data: Array<Record<string, unknown>> }>('GET', `/v1/agents/${agentId}/messages`, undefined, params);
  }

  readMessage(agentId: string, messageId: string) {
    return this.request('GET', `/v1/agents/${agentId}/messages/${messageId}`);
  }

  claimMessages(agentId: string, params: { max?: number; lease_seconds?: number; worker?: string } = {}) {
    return this.request<{ data: Array<Record<string, unknown>> }>('POST', `/v1/agents/${agentId}/messages/claim`, params);
  }

  waitForMessages(
    agentId: string,
    params: { wait?: number; claim?: boolean; max?: number; worker?: string } = {},
  ) {
    return this.request<{ data: Array<Record<string, unknown>> }>(
      'GET',
      `/v1/agents/${agentId}/messages/wait`,
      undefined,
      params,
    );
  }

  ackMessage(agentId: string, messageId: string) {
    return this.request('POST', `/v1/agents/${agentId}/messages/${messageId}/ack`);
  }

  releaseMessage(agentId: string, messageId: string) {
    return this.request('POST', `/v1/agents/${agentId}/messages/${messageId}/release`);
  }

  replyToMessage(agentId: string, messageId: string, body: Record<string, unknown>) {
    return this.request('POST', `/v1/agents/${agentId}/messages/${messageId}/reply`, body);
  }

  readThread(agentId: string, threadId: string) {
    return this.request<{ data: Array<Record<string, unknown>> }>('GET', `/v1/agents/${agentId}/threads/${threadId}`);
  }

  /* sending and discovery */

  send(input: SendMessageInput) {
    return this.request('POST', '/v1/emails', input);
  }

  findAgents(params: { q?: string; capability?: string; limit?: number } = {}) {
    return this.request<{ data: Array<Record<string, unknown>> }>('GET', '/v1/directory', undefined, params);
  }

  usage() {
    return this.request('GET', '/v1/account/usage');
  }
}
