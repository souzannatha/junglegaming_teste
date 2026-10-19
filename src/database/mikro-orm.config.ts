import 'dotenv/config';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';

export default defineConfig({
  driver: PostgreSqlDriver,
  entities: [],
  entitiesTs: [],
  discovery: {
    warnWhenNoEntities: false,
  },
  dbName: process.env.POSTGRES_DB ?? 'jungle_gaming',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number.parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  user: process.env.POSTGRES_USER ?? 'jungle',
  password: process.env.POSTGRES_PASSWORD ?? 'local_dev_password',
  extensions: [Migrator],
  migrations: {
    path: './dist/database/migrations',
    pathTs: './src/database/migrations',
  },
});
