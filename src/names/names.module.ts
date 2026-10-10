import { Module } from '@nestjs/common';
import { ScraperModule } from '../scraper/scraper.module';
import { EntityNamesService } from './entity-names.service';

@Module({
  imports: [ScraperModule],
  providers: [EntityNamesService],
  exports: [EntityNamesService],
})
export class NamesModule {}
