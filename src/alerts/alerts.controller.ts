import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { User } from '@prisma/client';
import { ApiKeyUser } from '../common/decorators/api-key-user.decorator';
import { AlertsService } from './alerts.service';
import { AlertsQueryDto } from './dto/alerts.query';

@Controller('alertes')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list(@ApiKeyUser() user: User, @Query() query: AlertsQueryDto) {
    return this.alerts.list(user, query);
  }

  @Get(':id')
  detail(@ApiKeyUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.alerts.detail(user, id);
  }
}
