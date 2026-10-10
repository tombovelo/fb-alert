import { Module } from '@nestjs/common';
import { AnalyzerService } from './analyzer.service';
import { AiService } from './ai.service';

@Module({
  providers: [AiService, AnalyzerService],
  exports: [AnalyzerService, AiService],
})
export class AnalyzerModule {}
