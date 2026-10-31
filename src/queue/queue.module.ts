import { Module } from '@nestjs/common';
import { AnalyzerModule } from '../analyzer/analyzer.module';
import { NamesModule } from '../names/names.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ScraperModule } from '../scraper/scraper.module';
import { ScrapeQueueService } from './scraping-queue.service';
import { ScrapingWorkerService } from './scraping-worker.service';
import { SourceSchedulerService } from './source-scheduler.service';
import { RetentionService } from './retention.service';

@Module({
  imports: [ScraperModule, NamesModule, NotificationsModule, AnalyzerModule],
  providers: [
    ScrapeQueueService,
    SourceSchedulerService,
    ScrapingWorkerService,
    RetentionService,
  ],
  exports: [ScrapeQueueService],
})
export class QueueModule {}
