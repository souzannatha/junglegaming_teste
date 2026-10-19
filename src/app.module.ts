import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './database/mikro-orm.config.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { APP_FILTER } from '@nestjs/core';
import { DomainExceptionFilter } from './api/domain-exception.filter.js';
import {
  ProviderWageringTransactionsController,
  WalletsController,
  WageringTransactionsController,
} from './api/wallets.controller.js';
import { WageringService } from './application/wagering/wagering.service.js';
import { OutboxPublisher } from './infrastructure/outbox/outbox-publisher.service.js';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [
    AppController,
    WalletsController,
    WageringTransactionsController,
    ProviderWageringTransactionsController,
  ],
  providers: [
    AppService,
    WageringService,
    OutboxPublisher,
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
