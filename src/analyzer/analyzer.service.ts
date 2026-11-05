import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Source, UserMonitor } from '@prisma/client';
import IORedis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { ScrapedPost } from '../scraper/scraper.types';
import { AiAnalysis, AiService, detectPrice, looksLikePhone } from './ai.service';
import { matchesKeywords } from './keyword-filter';

export const SEEN_KEY_PREFIX = 'fb:seen:';
export const SEEN_TTL_DAYS_DEFAULT = 30;
export const AI_CACHE_KEY_PREFIX = 'fb:ai:';
export const AI_CACHE_TTL_DAYS_DEFAULT = 7;

export interface AnalysisStats {
  total: number;
  alreadySeen: number;
  filtered: number;
  aiCalls: number;
  aiCacheHits: number;
  matched: number;
  retryQueued: number;

}

type MonitorForAnalysis = UserMonitor & { user: { aiEnabled: boolean } };

const BACKFILL_DAYS = 30;
const BACKFILL_BATCH_SIZE = 200;

@Injectable()
export class AnalyzerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnalyzerService.name);
  private readonly backfills = new Map<string, Promise<void>>();
  private readonly backfillGeneration = new Map<string, number>();
  private redis?: IORedis;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) { }

  onModuleInit() {
    const url = this.config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.redis = new IORedis(url, { maxRetriesPerRequest: 3 });
    this.redis.on('error', (err: Error) =>
      this.logger.warn(`Redis dédoublonnage: ${err.message}`),
    );
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
    this.redis = undefined;
  }

  get redisRef(): IORedis | undefined {
    return this.redis;
  }

  private get seenTtlSeconds(): number {
    const days = Number(this.config.get('REDIS_SEEN_TTL_DAYS') ?? SEEN_TTL_DAYS_DEFAULT);
    return Math.max(60, Math.round(days * 86_400));
  }

  private get aiCacheTtlSeconds(): number {
    const days = Number(
      this.config.get('REDIS_AI_CACHE_TTL_DAYS') ?? AI_CACHE_TTL_DAYS_DEFAULT,
    );
    return Math.max(60, Math.round(days * 86_400));
  }

  /**
   * Clé de cache de la réponse IA : dépend uniquement du texte du post et des
   * critères envoyés au prompt (pas de l'utilisateur), donc partageable entre
   * deux monitors aux critères strictement identiques.
   */
  private aiCacheKey(
    text: string,
    criteria: {
      keywords: string[];
      characteristics?: string[];
      locations?: string[];
      negativeKeywords: string[];
      minPrice: number | null;
      maxPrice: number | null;
    },
  ): string {
    const normalizeList = (list: string[]) =>
      [...list].map((k) => k.trim()).filter((k) => k !== '').sort();
    const payload = JSON.stringify({
      text,
      keywords: normalizeList(criteria.keywords),
      characteristics: normalizeList(criteria.characteristics ?? []),
      locations: normalizeList(criteria.locations ?? []),
      negativeKeywords: normalizeList(criteria.negativeKeywords),
      minPrice: criteria.minPrice ?? null,
      maxPrice: criteria.maxPrice ?? null,
    });
    return `${AI_CACHE_KEY_PREFIX}${createHash('sha1').update(payload).digest('hex')}`;
  }

  /** Lecture du cache IA : toute erreur Redis est ignorée (appel IA en secours). */
  private async readAiCache(key: string): Promise<AiAnalysis | null> {
    try {
      const raw = await this.redis?.get(key);
      return raw ? (JSON.parse(raw) as AiAnalysis) : null;
    } catch {
      return null;
    }
  }

  private async writeAiCache(key: string, analysis: AiAnalysis): Promise<void> {
    try {
      await this.redis?.set(key, JSON.stringify(analysis), 'EX', this.aiCacheTtlSeconds);
    } catch (err) {
      this.logger.warn(`Cache IA non écrit: ${(err as Error).message}`);
    }
  }

  async analyzeSourcePosts(source: Source, posts: ScrapedPost[]): Promise<AnalysisStats> {
    const monitors = await this.prisma.userMonitor.findMany({
      where: { sourceId: source.id, isActive: true },
      include: { user: { select: { aiEnabled: true } } },
    });

    const stats: AnalysisStats = {
      total: posts.length,
      alreadySeen: 0,
      filtered: 0,
      aiCalls: 0,
      aiCacheHits: 0,
      matched: 0,
      retryQueued: 0,
    };

    for (const post of posts) {
      // A. Dédoublonnage : post déjà traité (Redis, TTL 30 j) -> abandon.
      const firstSeen = await this.redis!.set(
        `${SEEN_KEY_PREFIX}${post.facebookPostId}`,
        '1',
        'EX',
        this.seenTtlSeconds,
        'NX',
      );
      if (firstSeen !== 'OK') {
        stats.alreadySeen += 1;
        continue;
      }

      const processed = await this.prisma.processedPost.findUnique({
        where: { facebookPostId: post.facebookPostId },
      });

      let aiErrors = 0;
      for (const monitor of monitors) {
        // B. Filtre local : Cherche/Lieu = au moins un mot ; Caractéristiques =
        // au moins `characteristicsMin` mots.
        if (
          !matchesKeywords(
            post.text,
            {
              keywords: monitor.keywords,
              characteristics: monitor.characteristics,
              characteristicsMin: monitor.characteristicsMin,
              locations: monitor.locations,
            },
            monitor.negativeKeywords,
          )
        ) {
          stats.filtered += 1;
          continue;
        }

        // C. Analyse sémantique (IA si activée) + enregistrement du match.
        try {
          const matched = await this.processCandidate(
            post.text,
            processed?.id ?? null,
            monitor,
            stats,
          );
          if (matched) stats.matched += 1;
        } catch (err) {
          aiErrors += 1;
          this.logger.warn(
            `IA en échec sur ${post.facebookPostId}: ${(err as Error).message}`,
          );
        }
      }

      // Échec IA (ex. 503 persistant) : on retire la marque "vu" pour que le
      // post soit ré-analysé au prochain scraping (upsert MatchedPost idempotent).
      if (aiErrors > 0) {
        stats.retryQueued += 1;
        await this.redis!.del(`${SEEN_KEY_PREFIX}${post.facebookPostId}`);
        this.logger.warn(
          `${post.facebookPostId}: ${aiErrors} échec(s) IA, ré-analyse au prochain passage`,
        );
      }
    }

    if (posts.length > 0) {
      this.logger.log(
        `${source.url}: ${stats.alreadySeen} déjà vu(s), ${stats.filtered} rejet(s) filtre, ` +
        `${stats.aiCalls} appel(s) IA (${stats.aiCacheHits} depuis le cache), ` +
        `${stats.matched} match(s)` +
        (stats.retryQueued > 0 ? `, ${stats.retryQueued} à réanalyser` : ''),
      );
    }

    return stats;
  }

  /**
   * Analyse un texte pour un monitor et enregistre le résultat (PostAnalysis,
   * MatchedPost). Retourne true si une alerte est créée ou mise à jour.
   * Lève une erreur si l'IA est activée et échoue.
   */
  private async processCandidate(
    text: string,
    processedId: string | null,
    monitor: MonitorForAnalysis,
    stats: AnalysisStats,
  ): Promise<boolean> {
    let analysis: AiAnalysis;
    if (monitor.user.aiEnabled) {
      const criteria = {
        keywords: monitor.keywords,
        characteristics: monitor.characteristics,
        locations: monitor.locations,
        negativeKeywords: monitor.negativeKeywords,
        minPrice: monitor.minPrice,
        maxPrice: monitor.maxPrice,
      };
      const cacheKey = this.aiCacheKey(text, criteria);
      const cached = await this.readAiCache(cacheKey);
      if (cached) {
        analysis = { ...cached };
        stats.aiCacheHits += 1;
      } else {
        analysis = await this.ai.analyze(text, criteria);
        stats.aiCalls += 1;
        // Réponse brute stockée (avant fusion de prix, propre à ce post).
        await this.writeAiCache(cacheKey, analysis);
      }
      // Prix final : le plus grand nombre détecté (IA ou regex locale),
      // les numéros de téléphone sont écartés.
      const iaPrice =
        analysis.extractedPrice !== null && !looksLikePhone(analysis.extractedPrice)
          ? analysis.extractedPrice
          : null;
      const localPrice = detectPrice(text);
      analysis.extractedPrice =
        iaPrice !== null && localPrice !== null
          ? Math.max(iaPrice, localPrice)
          : (iaPrice ?? localPrice);
    } else {
      // Interrupteur IA désactivé : le filtre mots-clés suffit, prix extrait
      // localement, sans résumé ni confiance.
      analysis = {
        isMatch: true,
        extractedPrice: detectPrice(text),
        summary: null,
        confidence: null,
      };
    }

    // Résultat complet de l'IA (match ou non) conservé par monitor.
    if (processedId) {
      await this.prisma.postAnalysis.upsert({
        where: {
          processedPostId_userMonitorId: {
            processedPostId: processedId,
            userMonitorId: monitor.id,
          },
        },
        update: {
          isMatch: analysis.isMatch,
          extractedPrice: analysis.extractedPrice,
          summary: analysis.summary,
          confidence: analysis.confidence,
        },
        create: {
          processedPostId: processedId,
          userMonitorId: monitor.id,
          isMatch: analysis.isMatch,
          extractedPrice: analysis.extractedPrice,
          summary: analysis.summary,
          confidence: analysis.confidence,
        },
      });
    }

    if (!analysis.isMatch) return false;
    if (!this.priceInRange(analysis.extractedPrice, monitor.minPrice, monitor.maxPrice)) {
      return false;
    }
    if (!processedId) return false;

    // Enregistrement du match.
    await this.prisma.matchedPost.upsert({
      where: {
        processedPostId_userMonitorId: {
          processedPostId: processedId,
          userMonitorId: monitor.id,
        },
      },
      update: { confidence: analysis.confidence },
      create: {
        processedPostId: processedId,
        userMonitorId: monitor.id,
        confidence: analysis.confidence,
      },
    });
    await this.prisma.processedPost.update({
      where: { id: processedId },
      data: {
        ...(analysis.summary !== null ? { aiSummary: analysis.summary } : {}),
        ...(analysis.extractedPrice !== null
          ? { extractedPrice: analysis.extractedPrice }
          : {}),
      },
    });
    return true;
  }

  /**
   * Programme le rattrapage d'un monitor en arrière-plan. Les demandes
   * successives pour le même monitor sont sérialisées (jamais deux à la fois).
   */
  scheduleBackfill(monitorId: string): void {
    const generation = (this.backfillGeneration.get(monitorId) ?? 0) + 1;
    this.backfillGeneration.set(monitorId, generation);
    const previous = this.backfills.get(monitorId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.backfillMonitor(monitorId, generation))
      .catch((err: Error) =>
        this.logger.warn(`Rattrapage ${monitorId} échoué: ${err.message}`),
      )
      .finally(() => {
        if (this.backfills.get(monitorId) === next) {
          this.backfills.delete(monitorId);
        }
      });
    this.backfills.set(monitorId, next);
  }

  /**
   * Analyse les publications déjà stockées (30 derniers jours) de la source
   * d'un monitor, avec le même traitement que le scraping normal. Une demande
   * plus récente pour le même monitor annule celle-ci (critères changés).
   */
  async backfillMonitor(monitorId: string, generation: number): Promise<void> {
    const monitor = await this.prisma.userMonitor.findUnique({
      where: { id: monitorId },
      include: { user: { select: { aiEnabled: true } } },
    });
    if (!monitor || !monitor.isActive) return;
    if (this.backfillGeneration.get(monitorId) !== generation) return;

    const cutoff = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000);
    const stats: AnalysisStats = {
      total: 0,
      alreadySeen: 0,
      filtered: 0,
      aiCalls: 0,
      aiCacheHits: 0,
      matched: 0,
      retryQueued: 0,
    };
    let cursor: string | undefined;

    for (;;) {
      const posts = await this.prisma.processedPost.findMany({
        where: {
          sourceId: monitor.sourceId,
          createdAt: { gte: cutoff },
          ...(cursor ? { id: { lt: cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        select: { id: true, rawContent: true, facebookPostId: true },
        take: BACKFILL_BATCH_SIZE,
      });
      if (posts.length === 0) break;

      for (const post of posts) {
        if (this.backfillGeneration.get(monitorId) !== generation) return;
        stats.total += 1;
        if (
          !matchesKeywords(
            post.rawContent,
            {
              keywords: monitor.keywords,
              characteristics: monitor.characteristics,
              characteristicsMin: monitor.characteristicsMin,
              locations: monitor.locations,
            },
            monitor.negativeKeywords,
          )
        ) {
          stats.filtered += 1;
          continue;
        }
        try {
          const matched = await this.processCandidate(
            post.rawContent,
            post.id,
            monitor,
            stats,
          );
          if (matched) stats.matched += 1;
        } catch (err) {
          this.logger.warn(
            `Rattrapage ${monitorId} sur ${post.facebookPostId}: ${(err as Error).message}`,
          );
        }
      }

      cursor = posts[posts.length - 1].id;
      if (posts.length < BACKFILL_BATCH_SIZE) break;
    }

    this.logger.log(
      `Rattrapage ${monitorId}: ${stats.total} publication(s) vérifiée(s), ` +
      `${stats.filtered} rejet(s) filtre, ${stats.aiCalls} appel(s) IA ` +
      `(${stats.aiCacheHits} cache), ${stats.matched} alerte(s).`,
    );
  }

  private priceInRange(
    price: number | null,
    minPrice: number | null | undefined,
    maxPrice: number | null | undefined,
  ): boolean {
    // Fourchette définie (min seul, max seul ou les deux) : un prix doit être
    // détecté ET respecter la borne — post sans prix = rejeté (condition ET).
    const rangeDefined = minPrice != null || maxPrice != null;
    if (rangeDefined && price === null) return false;
    if (price === null) return true;
    if (minPrice != null && price < minPrice) return false;
    if (maxPrice != null && price > maxPrice) return false;
    return true;
  }
}
