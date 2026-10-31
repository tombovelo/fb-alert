import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/** Nombre de lignes supprimées par paquet (évite un DELETE massif). */
const BATCH_SIZE = 2_000;
/** Rétention par défaut : 30 jours. */
const DEFAULT_RETENTION_DAYS = 30;

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Chaque nuit à 1 h, heure de Madagascar. */
  @Cron('0 1 * * *', { timeZone: 'Indian/Antananarivo' })
  async cleanupCron() {
    if (this.config.get('RETENTION_ENABLED') === 'false') return;
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.cleanup();
      if (result.posts > 0 || result.notifications > 0) {
        this.logger.log(
          `Nettoyage : ${result.posts} publication(s) et ${result.notifications} notification(s) de plus de ${result.days} jours supprimées.`,
        );
      }
    } catch (err) {
      this.logger.error(`Échec du nettoyage automatique : ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** Supprime les publications (et notifications) plus vieilles que la rétention. */
  async cleanup(): Promise<{ posts: number; notifications: number; days: number }> {
    const days = this.retentionDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const posts = await this.deleteOldPosts(cutoff);
    const notifications = await this.deleteOldNotifications(cutoff);

    return { posts, notifications, days };
  }

  private retentionDays(): number {
    const raw = Number.parseInt(this.config.get('POST_RETENTION_DAYS') ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
  }

  /**
   * Supprime par paquets. Les alertes, analyses IA et favoris liés partent
   * automatiquement (cascade en base).
   */
  private async deleteOldPosts(cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await this.prisma.processedPost.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });
      if (rows.length === 0) break;

      const deleted = await this.prisma.processedPost.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      total += deleted.count;
      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }

  /** Les notifications n'ont pas de bouton de suppression : on les purge aussi. */
  private async deleteOldNotifications(cutoff: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await this.prisma.notification.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });
      if (rows.length === 0) break;

      const deleted = await this.prisma.notification.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      total += deleted.count;
      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }
}
