import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { ApiKeyUser } from '../common/decorators/api-key-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UserService } from './user.service';
import { AdminRoleDto, AdminSubscriptionDto, AiEnabledDto, PaymentPhoneDto, PushTokenDto, SubmitRequestDto } from './dto/user.dto';

@Controller('user')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get()
  me(@ApiKeyUser() user: User) {
    return this.users.profile(user);
  }

  @Post('push-token')
  saveToken(@ApiKeyUser() user: User, @Body() dto: PushTokenDto) {
    return this.users.savePushToken(user, dto);
  }

  @Post('ai-enabled')
  setAiEnabled(@ApiKeyUser() user: User, @Body() dto: AiEnabledDto) {
    return this.users.setAiEnabled(user, dto.enabled);
  }

  @Get('payment-phone')
  getPaymentPhone() {
    return this.users.getPaymentPhone();
  }

  @Post('subscription-requests')
  submitRequest(@ApiKeyUser() user: User, @Body() dto: SubmitRequestDto) {
    return this.users.submitSubscriptionRequest(user, dto);
  }

  @Get('subscription-requests/mine')
  myRequest(@ApiKeyUser() user: User) {
    return this.users.mySubscriptionRequest(user);
  }

  @Get('admin/subscriptions')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  adminSubscriptions() {
    return this.users.adminSubscriptions();
  }

  @Patch('admin/subscriptions/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  adminUpdateSubscription(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminSubscriptionDto,
  ) {
    return this.users.adminUpdateSubscription(id, dto);
  }

  @Patch('admin/roles/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  adminUpdateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminRoleDto,
  ) {
    return this.users.adminUpdateRole(id, dto.role);
  }

  @Get('admin/payment-phone')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  adminGetPaymentPhone() {
    return this.users.getPaymentPhone();
  }

  @Patch('admin/payment-phone')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  adminSetPaymentPhone(@Body() dto: PaymentPhoneDto) {
    return this.users.setPaymentPhone(dto);
  }

  @Delete('admin/subscription-requests/:id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  adminRejectRequest(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.rejectSubscriptionRequest(id);
  }
}
