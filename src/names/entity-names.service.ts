import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { entityUrlFromPost } from '../common/facebook-url';
import { PrismaService } from '../prisma/prisma.service';
import { ScraperService } from '../scraper/scraper.service';

/** Nombre maximal de navigations par lot de résolution. */
const BATCH_LIMIT = 10;
/** Plafond de navigations par appel de `sync` (évite une passe trop longue). */
const MAX_PER_CALL = 30;
/** Réessai d'une entité sans nom au bout de ce délai. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Cache des noms réels (groupe, page, profil) rencontrés dans les
 * publications : chaque URL d'entité est naviguée une seule fois, le nom est
 * ensuite servi depuis la table FacebookEntityName.
 */
@Injectable()
export class EntityNamesService implements OnModuleInit {
  private readonly logger = new Logger(EntityNamesService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scraper: ScraperService,
  ) {}

  onModuleInit() {
    void this.sync();
  }

  /**
   * Résout (au plus BATCH_LIMIT par appel) les entités manquantes.
   * `postUrls` permet de ne traiter que les nouvelles publications.
   */
  async sync(postUrls?: (string | null)[]): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const urls = postUrls ?? await this.knownPostUrls();
      const candidates = [
        ...new Set(
          urls
            .map((url) => entityUrlFromPost(url))
            .filter((url): url is string => Boolean(url)),
        ),
      ];
      if (candidates.length === 0) return 0;

      const known = await this.prisma.facebookEntityName.findMany({
        where: { url: { in: candidates } },
        select: { url: true, name: true, resolvedAt: true },
      });
      const byUrl = new Map(known.map((entry) => [entry.url, entry]));
      const retryCutoff = Date.now() - RETRY_AFTER_MS;
      const missing = candidates.filter((url) => {
        const entry = byUrl.get(url);
        if (!entry) return true;
        return entry.name === '' && entry.resolvedAt.getTime() < retryCutoff;
      });

      let resolved = 0;
      let processed = 0;
      while (processed < missing.length && processed < MAX_PER_CALL) {
        const batch = missing.slice(processed, processed + BATCH_LIMIT);
        processed += batch.length;

        for (const url of batch) {
          const name = await this.scraper.fetchEntityName(url);
          await this.prisma.facebookEntityName.upsert({
            where: { url },
            create: { url, name: name ?? '' },
            update: { name: name ?? '', resolvedAt: new Date() },
          });
          if (name) resolved += 1;
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      if (resolved > 0) {
        this.logger.log(`${resolved} nom(s) d'entité résolu(s)`);
      }
      return resolved;
    } catch (err) {
      this.logger.warn(`Résolution des noms impossible: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** URLs des publications dont la source n'a pas de nom (le fil). */
  private async knownPostUrls(): Promise<(string | null)[]> {
    const posts = await this.prisma.processedPost.findMany({
      where: { url: { not: null }, source: { name: null } },
      select: { url: true },
      orderBy: { createdAt: 'desc' },
      take: 400,
    });
    return posts.map((post) => post.url);
  }
}
