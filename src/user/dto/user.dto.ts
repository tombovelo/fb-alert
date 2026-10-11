import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PushTokenDto {
  @IsString()
  @MinLength(10)
  @MaxLength(300)
  token!: string;
}

export class AiEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

export class AdminSubscriptionDto {
  @IsIn(['TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED'])
  subscriptionStatus!: string;

  /** Durée en mois (champ libre), uniquement avec ACTIVE. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  durationMonths?: number;
}

export class AdminRoleDto {
  @IsIn(['ADMIN', 'USER'])
  role!: 'ADMIN' | 'USER';
}

export class PaymentPhoneDto {
  @IsString()
  @MinLength(5)
  @MaxLength(30)
  phone!: string;
}

export class SubmitRequestDto {
  @IsInt()
  @Min(1)
  @Max(60)
  months!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  paymentReference!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(30)
  senderPhone!: string;
}
