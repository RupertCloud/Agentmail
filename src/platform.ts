import { DEFAULT_SECRET, loadConfig, type Config } from './config.js';
import { AccountService } from './domain/accounts.js';
import { AgentService } from './domain/agents.js';
import { CampaignService } from './domain/campaigns.js';
import { DeliveryService } from './domain/delivery.js';
import { SystemDnsResolver, type DnsResolver } from './domain/dns.js';
import { DomainService } from './domain/domains.js';
import { EventService } from './domain/events.js';
import { ListService } from './domain/lists.js';
import { MailboxService } from './domain/mailbox.js';
import { MemoryService } from './domain/memory.js';
import { MailboxNotifier } from './domain/notifier.js';
import { SendService, type DeliveryJob } from './domain/sending.js';
import { SuppressionService } from './domain/suppression.js';
import { TemplateService } from './domain/templates.js';
import { WebhookService, type Fetcher } from './domain/webhooks.js';
import { InboundService } from './inbound/ingest.js';
import { AwsControlPlane, LocalControlPlane, type SesControlPlane } from './providers/control-plane.js';
import { MemoryProvider } from './providers/memory.js';
import { SesProvider } from './providers/ses.js';
import type { EmailProvider } from './providers/types.js';
import { MemoryQueue } from './queue/memory.js';
import { PriorityWorker } from './queue/worker.js';
import { MemoryStore } from './store/memory.js';
import type { Store } from './store/types.js';

export interface PlatformOptions {
  config?: Partial<Config>;
  store?: Store;
  provider?: EmailProvider;
  controlPlane?: SesControlPlane;
  dns?: DnsResolver;
  fetcher?: Fetcher;
}

/**
 * Composition root. Everything is constructed here and nothing reaches for a
 * global, so a test can swap the store, the provider, DNS or the HTTP client
 * and exercise the whole platform in process.
 */
export class Platform {
  readonly config: Config;
  readonly store: Store;
  readonly provider: EmailProvider;
  readonly controlPlane: SesControlPlane;

  readonly notifier: MailboxNotifier;
  readonly events: EventService;
  readonly accounts: AccountService;
  readonly agents: AgentService;
  readonly domains: DomainService;
  readonly suppression: SuppressionService;
  readonly templates: TemplateService;
  readonly lists: ListService;
  readonly campaigns: CampaignService;
  readonly webhooks: WebhookService;
  readonly sending: SendService;
  readonly delivery: DeliveryService;
  readonly inbound: InboundService;
  readonly mailbox: MailboxService;
  readonly memory: MemoryService;

  readonly queues: { transactional: MemoryQueue<DeliveryJob>; campaign: MemoryQueue<DeliveryJob> };
  readonly worker: PriorityWorker<DeliveryJob>;

  private leaseSweeper: NodeJS.Timeout | null = null;

  constructor(options: PlatformOptions = {}) {
    const config = { ...loadConfig(), ...options.config };
    // Recomputed after the merge: a caller supplying a secret directly must not
    // inherit the environment's verdict on whether one was configured.
    config.secretIsDefault = config.secret === DEFAULT_SECRET;
    this.config = config;
    this.store = options.store ?? new MemoryStore();
    this.provider =
      options.provider ??
      (this.config.provider === 'ses' ? new SesProvider(this.config.awsRegion) : new MemoryProvider());
    this.controlPlane =
      options.controlPlane ??
      (this.config.provider === 'ses'
        ? new AwsControlPlane(this.config.awsRegion, this.config.awsAccountId)
        : new LocalControlPlane(this.config.platformDomain));

    this.notifier = new MailboxNotifier();
    this.events = new EventService(this.store);
    this.webhooks = new WebhookService(this.store, { fetcher: options.fetcher });
    this.events.addSink(this.webhooks);

    this.accounts = new AccountService(this.store, this.config, this.controlPlane);
    this.agents = new AgentService(this.store, this.config);
    this.domains = new DomainService(
      this.store,
      this.config,
      options.dns ?? new SystemDnsResolver(),
      this.controlPlane,
    );
    this.suppression = new SuppressionService(this.store);
    this.templates = new TemplateService(this.store);
    this.lists = new ListService(this.store);

    this.queues = {
      transactional: new MemoryQueue<DeliveryJob>('transactional'),
      campaign: new MemoryQueue<DeliveryJob>('campaign'),
    };

    this.sending = new SendService(
      this.store,
      this.config,
      this.agents,
      this.suppression,
      this.events,
      this.notifier,
      this.queues,
    );
    this.delivery = new DeliveryService(
      this.store,
      this.config,
      this.provider,
      this.events,
      this.suppression,
    );
    this.inbound = new InboundService(this.store, this.config, this.agents, this.events, this.notifier);
    this.mailbox = new MailboxService(this.store, this.config, this.events, this.notifier);
    this.memory = new MemoryService(this.store);
    this.campaigns = new CampaignService(
      this.store,
      this.config,
      this.lists,
      this.suppression,
      this.sending,
    );

    // Transactional first, always: a broadcast never delays a password reset.
    this.worker = new PriorityWorker<DeliveryJob>(
      [this.queues.transactional, this.queues.campaign],
      (job) => this.delivery.handle(job.body),
      {
        maxAttempts: this.config.maxSendAttempts,
        backoffBaseSeconds: 2,
        onDeadLetter: async (job, reason) => {
          await this.delivery.fail((job.body as DeliveryJob).messageId, reason);
        },
      },
    );
  }

  /** Starts background work: the send worker, webhook retries, lease sweeps. */
  start(): void {
    this.worker.start();
    this.webhooks.worker.start();
    if (!this.leaseSweeper) {
      this.leaseSweeper = setInterval(() => {
        void this.sweepLeases();
      }, 5_000);
      this.leaseSweeper.unref?.();
    }
  }

  stop(): void {
    this.worker.stop();
    this.webhooks.worker.stop();
    if (this.leaseSweeper) {
      clearInterval(this.leaseSweeper);
      this.leaseSweeper = null;
    }
  }

  /** Processes everything queued right now. Used by tests and CLI flushes. */
  async drain(): Promise<number> {
    const sent = await this.worker.drain();
    await this.webhooks.worker.drain();
    return sent;
  }

  private async sweepLeases(): Promise<void> {
    await this.mailbox.reclaimExpired();
  }

  async close(): Promise<void> {
    this.stop();
    await this.store.close();
  }
}
