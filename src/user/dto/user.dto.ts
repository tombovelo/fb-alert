import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';

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
