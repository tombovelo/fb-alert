import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { ApiKeyUser } from '../common/decorators/api-key-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { MonitorsService } from './monitors.service';
import {
  CreateMonitorDto,
  SuggestSourcesQueryDto,
  UpdateMonitorDto,
} from './dto/monitors.dto';

@Controller('monitors')
export class MonitorsController {
  constructor(private readonly monitors: MonitorsService) {}

  @Get()
  list(@ApiKeyUser() user: User) {
    return this.monitors.list(user);
  }

  @Get('sources/suggest')
  suggestSources(
    @ApiKeyUser() user: User,
    @Query() query: SuggestSourcesQueryDto,
  ) {
    return this.monitors.suggestSources(user, query.q);
  }

  @Get('admin/overview')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  adminOverview() {
    return this.monitors.adminOverview();
  }

  @Delete('admin/sources/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  adminDeleteSource(@Param('id', ParseUUIDPipe) id: string) {
    return this.monitors.adminDeleteSource(id);
  }

  @Post()
  create(@ApiKeyUser() user: User, @Body() dto: CreateMonitorDto) {
    return this.monitors.create(user, dto);
  }

  @Patch(':id')
  update(
    @ApiKeyUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMonitorDto,
  ) {
    return this.monitors.update(user, id, dto);
  }

  @Post(':id/reactivate')
  reactivate(
    @ApiKeyUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.monitors.reactivate(user, id);
  }

  @Delete(':id')
  remove(@ApiKeyUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.monitors.remove(user, id);
  }
}
