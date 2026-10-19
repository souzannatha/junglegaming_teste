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

As migrations ficam em `src/database/migrations`, são versionadas e devem implementar `up` e `down`.

```sh
bun run migration:create
bun run migration:up
bun run migration:down
```

## Regras do domínio

- Wallet aceita saldo inicial não negativo, inicia na versão `1` e incrementa a versão somente quando um débito ou crédito válido altera o saldo. Uma movimentação retorna seu lançamento balanceado no ledger.
- Transações iniciam em `PENDING`. Podem ir para `PENDING_REFERENCE` quando declaram uma referência ainda ausente, voltar para `PENDING` após a resolução, ou terminar em `PROCESSED`, `REJECTED` ou `FAILED`. Os estados terminais não admitem novas transições.
- `OPENING` só pode ser criado pela factory interna; não é aceito na factory de transações de provedor.
- `LOSS` não afeta o saldo nem gera direção de ledger. `BET` é débito, `WIN` e `REFUND` são crédito. `ROLLBACK` inverte o sentido de `BET`, `WIN` ou `REFUND`.
- Referências verificam provedor, jogador, wallet, moeda, rodada, estado processado e tipo permitido. `REFUND`/`ROLLBACK` exigem o mesmo valor da referência e não permitem repetição do mesmo tipo de reversão.

Códigos estáveis de rejeição definidos no domínio: `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_TYPE_NOT_ALLOWED`, `REFERENCE_CONTEXT_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH` e `REFERENCE_ALREADY_REVERSED`.

## Verificações

```sh
bun run build
bun run test
bun run test:e2e
bun run lint
```
