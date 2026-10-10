import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';

export const SCRAPING_QUEUE_NAME = 'facebook-scraping-queue';
export const SCRAPE_JOB_NAME = 'scrape-source';

export interface ScrapeJobData {
  sourceId: string;
}

@Injectable()
export class ScrapeQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScrapeQueueService.name);
  private queue?: Queue;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.queue = new Queue<ScrapeJobData>(SCRAPING_QUEUE_NAME, {
      connection: this.connection(),
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 1,
      },
    });
    await this.queue.waitUntilReady();
    this.logger.log(`File « ${SCRAPING_QUEUE_NAME} » prête`);
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    this.queue = undefined;
  }

  /**
   * Enfile un scraping pour une source. Le jobId déduplique : tant qu'un job
   * pour cette source est en attente ou en cours, le nouvel ajout est ignoré.
   */
  async addScrapeJob(sourceId: string, options?: { delay?: number }) {
    const job = await this.queue!.add(
      SCRAPE_JOB_NAME,
      { sourceId },
      {
        jobId: `scrape-${sourceId}`,
        ...(options?.delay ? { delay: options.delay } : {}),
      },
    );
    this.logger.debug(`Job ${job.id} enfilé pour la source ${sourceId}`);
    return job;
  }

  async getJobCounts() {
    if (!this.queue) return null;
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
  }

  get queueRef() {
    return this.queue;
  }

  static connection(url: string) {
    return new IORedis(url, { maxRetriesPerRequest: null });
  }

  private connection() {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    return ScrapeQueueService.connection(url);
  }
}

export type ScrapeJob = Job<ScrapeJobData>;
