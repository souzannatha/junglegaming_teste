# Jungle Gaming — Distributed Wagering Processor

Serviço NestJS executado com Bun, PostgreSQL e MikroORM. O ambiente local usa Docker Compose e LocalStack para SQS.

## Requisitos

- Bun 1.x
- Docker com Docker Compose

## Configuração local

```sh
cp .env.example .env
bun install
docker compose up -d
bun run migration:up
bun run start:dev
```

A aplicação inicia em `http://localhost:3000`. PostgreSQL fica disponível na porta `5432` e o endpoint de SQS do LocalStack em `http://localhost:4566`.

O `.env.example` contém apenas valores de desenvolvimento. Configure `LOCALSTACK_AUTH_TOKEN` no `.env` caso sua instalação do LocalStack solicite um token; não compartilhe nem versione credenciais.

## Migrations

As migrations ficam em `src/migrations`, são versionadas e devem implementar `up` e `down`.

```sh
bun run migration:create
bun run migration:up
bun run migration:down
```

## Verificações

```sh
bun run build
bun run test
bun run test:e2e
bun run lint
```
