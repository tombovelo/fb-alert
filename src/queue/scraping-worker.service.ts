import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel, Source } from '@prisma/client';
import { Job, Worker } from 'bullmq';
import { AnalyzerService } from '../analyzer/analyzer.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EntityNamesService } from '../names/entity-names.service';
import { ScraperService } from '../scraper/scraper.service';
import {
  SCRAPING_QUEUE_NAME,
  ScrapeJobData,
  ScrapeQueueService,
} from './scraping-queue.service';

const CONSECUTIVE_ERROR_THRESHOLD = 3;

@Injectable()
export class ScrapingWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScrapingWorkerService.name);
  private worker?: Worker<ScrapeJobData>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly scraper: ScraperService,
    private readonly notifications: NotificationsService,
    private readonly analyzer: AnalyzerService,
    private readonly entityNames: EntityNamesService,
  ) {}

  async onModuleInit() {
    const concurrency = Number(this.config.get('FB_QUEUE_CONCURRENCY') ?? 2);

    this.worker = new Worker<ScrapeJobData>(
      SCRAPING_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: ScrapeQueueService.connection(
          this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
        ),
        concurrency,
      },
    );

    this.worker.on('completed', (job) =>
      this.logger.debug(`Job ${job.id} terminé`),
    );
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`Job ${job?.id} échoué: ${err.message}`),
    );
    this.worker.on('error', (err) =>
      this.logger.error(`Erreur worker: ${err.message}`),
    );

    await this.worker.waitUntilReady();
    this.logger.log(`Worker prêt (concurrence: ${concurrency})`);
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => undefined);
    this.worker = undefined;
  }

  private async process(job: Job<ScrapeJobData>): Promise<unknown> {
    const source = await this.prisma.source.findUnique({
      where: { id: job.data.sourceId },
    });

    if (!source) {
      this.logger.warn(`Source ${job.data.sourceId} introuvable, job ignoré`);
      return { skipped: 'missing_source' };
    }
    if (source.status !== 'ACTIVE') {
      return { skipped: source.status };
    }

    try {
      const keywords =
        source.type === 'MARKETPLACE'
          ? await this.activeKeywords(source.id)
          : [];
      const result = await this.scraper.scrapeSource(
        { url: source.url, type: source.type },
        { keywords },
      );

      // Fraîcheur : sans date de publication on garde ; daté de plus de 24 h on
      // n'enregistre pas (ni sauvegarde, ni analyse Module 3).
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const posts = result.posts.filter(
        (post) => !post.publishedAt || post.publishedAt.getTime() >= cutoff,
      );
      const tooOld = result.posts.length - posts.length;

      let saved = 0;
      for (const post of posts) {
        await this.prisma.processedPost.upsert({
          where: { facebookPostId: post.facebookPostId },
          update: {
            rawContent: post.text,
            publishedAt: post.publishedAt,
            extractedPrice: post.price,
            url: post.url,
            author: post.author,
            title: post.title,
            imageUrl: post.imageUrl,
            origin: post.origin,
          },
          create: {
            facebookPostId: post.facebookPostId,
            sourceId: source.id,
            url: post.url,
            author: post.author,
            title: post.title,
            imageUrl: post.imageUrl,
            origin: post.origin,
            rawContent: post.text,
            publishedAt: post.publishedAt,
            extractedPrice: post.price,
          },
        });
        saved += 1;
      }

      const pageName = result.pageName?.trim()
        ? result.pageName.trim().slice(0, 80)
        : null;
      await this.prisma.source.update({
        where: { id: source.id },
        data: {
          lastScrapedAt: new Date(),
          lastScrapeOrigin: result.origin,
          lastScrapeDurationMs: result.durationMs,
          consecutiveErrors: 0,
          ...(pageName && pageName !== source.name ? { name: pageName } : {}),
        },
      });

      this.logger.log(
        `${source.url}: ${posts.length} post(s) (${result.origin}, ${result.durationMs} ms)` +
          (tooOld > 0 ? `, ${tooOld} ignoré(s) (>24 h)` : ''),
      );

      // Module 3 : dédoublonnage Redis -> filtre mots-clés -> Gemini -> MatchedPost.
      try {
        await this.analyzer.analyzeSourcePosts(source, posts);
      } catch (err) {
        this.logger.error(
          `Analyse (Module 3) échouée pour ${source.url}: ${(err as Error).message}`,
        );
      }

      // Noms des groupes/pages du fil : en arrière-plan, sans retarder le job.
      void this.entityNames.sync();

      return { posts: posts.length, saved };
    } catch (err) {
      return this.handleFailure(source, err as Error);
    }
  }

  /**
   * Mots-clés uniques des moniteurs actifs d'une source. Marketplace s'en
   * sert pour déclencher une recherche Facebook par mot-clé à chaque cycle.
   */
  private async activeKeywords(sourceId: string): Promise<string[]> {
    const monitors = await this.prisma.userMonitor.findMany({
      where: { sourceId, isActive: true },
      select: { keywords: true },
    });
    return [
      ...new Set(
        monitors
          .flatMap((monitor) => monitor.keywords)
          .map((keyword) => keyword.trim())
          .filter((keyword) => keyword !== ''),
      ),
    ];
  }

  /**
   * Incrémente consecutiveErrors ; après 3 échecs consécutifs la source passe
   * en ERROR (elle sort donc de la planification) et l'administrateur est
   * notifié. lastScrapedAt est mis à jour pour respecter l'intervalle.
   */
  private async handleFailure(source: Source, error: Error) {
    const updated = await this.prisma.source.update({
      where: { id: source.id },
      data: {
        lastScrapedAt: new Date(),
        consecutiveErrors: { increment: 1 },
      },
    });

    this.logger.warn(
      `Échec sur ${source.url} (${updated.consecutiveErrors}/${CONSECUTIVE_ERROR_THRESHOLD}): ${error.message}`,
    );

    if (updated.consecutiveErrors >= CONSECUTIVE_ERROR_THRESHOLD) {
      await this.prisma.source.update({
        where: { id: source.id },
        data: { status: 'ERROR' },
      });
      await this.notifyAdmin(updated);
      this.logger.error(
        `Source ${source.url} marquée ERROR après ${updated.consecutiveErrors} échecs`,
      );
    }

    throw error;
  }

  private async notifyAdmin(source: Source) {
    const admin = await this.prisma.user.findFirst({
      where: { role: 'ADMIN' },
    });
    if (!admin) {
      this.logger.warn('Aucun administrateur à notifier');
      return;
    }

    try {
      await this.notifications.sendAlert({
        userId: admin.id,
        title: 'Source Facebook en erreur',
        body: `La source ${source.url} a échoué ${source.consecutiveErrors} fois de suite et a été suspendue.`,
        channels: ['WEB' as NotificationChannel],
      });
    } catch (err) {
      this.logger.error(
        `Échec de notification admin: ${(err as Error).message}`,
      );
    }
  }
}
