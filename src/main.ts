import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { httpMetricsMiddleware } from './observability/http-metrics.js';
import { MetricsService } from './observability/metrics.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(httpMetricsMiddleware(app.get(MetricsService)));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
