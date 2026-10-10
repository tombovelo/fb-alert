import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Source } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScrapeQueueService } from './scraping-queue.service';

const MAX_ENQUEUE_PER_TICK = 100;

export function isSourceDue(
  source: Pick<Source, 'lastScrapedAt' | 'checkIntervalMinutes'>,
  now: number = Date.now(),
): boolean {
  if (!source.lastScrapedAt) return true;
  return (
    now - source.lastScrapedAt.getTime() >=
    source.checkIntervalMinutes * 60_000
  );
}

@Injectable()
export class SourceSchedulerService {
  private readonly logger = new Logger(SourceSchedulerService.name);
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ScrapeQueueService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (this.config.get('QUEUE_SCHEDULER_ENABLED') === 'false') return;
    await this.enqueueDueSources();
  }

  /**
   * Extrait les sources ACTIVE dont lastScrapedAt dépasse
   * checkIntervalMinutes et les enfile dans facebook-scraping-queue.
   * Le jobId par source empêche les doublons dans la file.
   */
  async enqueueDueSources(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const sources = await this.prisma.source.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, lastScrapedAt: true, checkIntervalMinutes: true },
      });

      const now = Date.now();
      const due = sources.filter((source) => isSourceDue(source, now));

      let enqueued = 0;
      for (const source of due.slice(0, MAX_ENQUEUE_PER_TICK)) {
        try {
          await this.queue.addScrapeJob(source.id);
          enqueued += 1;
        } catch (err) {
          this.logger.warn(
            `Échec d'enfilage pour la source ${source.id}: ${(err as Error).message}`,
          );
        }
      }

      if (enqueued > 0) {
        this.logger.log(
          `${enqueued}/${due.length} source(s) due(s) enfilée(s)`,
        );
      }
      return enqueued;
    } finally {
      this.ticking = false;
    }
  }
}
