import { Module } from '@nestjs/common';
import { AnalyzerModule } from '../analyzer/analyzer.module';
import { QueueModule } from '../queue/queue.module';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';

@Module({
  imports: [QueueModule, AnalyzerModule],
  controllers: [MonitorsController],
  providers: [MonitorsService],
  exports: [MonitorsService],
})
export class MonitorsModule {}
