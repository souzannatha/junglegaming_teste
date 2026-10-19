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

O schema financeiro usa `NUMERIC` do PostgreSQL sem converter valores para ponto flutuante; no MikroORM, colunas decimais são hidratadas como `string`. As migrations criam `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`. Constraints e índices cobrem unicidade de wallet por jogador/moeda, idempotência por provider/key, referências, valores não negativos e escala de duas casas. Triggers deferred validam consistência entre saldo, versão, ledger e transações ao commit; triggers impedem alteração, exclusão ou truncamento de lançamentos.

## Regras do domínio

- Wallet aceita saldo inicial não negativo, inicia na versão `1` e incrementa a versão somente quando um débito ou crédito válido altera o saldo. Uma movimentação retorna seu lançamento balanceado no ledger.
- Transações iniciam em `PENDING`. Podem ir para `PENDING_REFERENCE` quando declaram uma referência ainda ausente, voltar para `PENDING` após a resolução, ou terminar em `PROCESSED`, `REJECTED` ou `FAILED`. Os estados terminais não admitem novas transições.
- `OPENING` só pode ser criado pela factory interna; não é aceito na factory de transações de provedor.
- `LOSS` não afeta o saldo nem gera direção de ledger. `BET` é débito, `WIN` e `REFUND` são crédito. `ROLLBACK` inverte o sentido de `BET`, `WIN` ou `REFUND`.
- Referências verificam provedor, jogador, wallet, moeda, rodada, estado processado e tipo permitido. `REFUND`/`ROLLBACK` exigem o mesmo valor da referência e não permitem repetição do mesmo tipo de reversão.

Códigos estáveis de rejeição definidos no domínio: `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_TYPE_NOT_ALLOWED`, `REFERENCE_CONTEXT_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH` e `REFERENCE_ALREADY_REVERSED`.

## API HTTP

Todos os valores monetários são enviados como strings decimais com duas casas e moeda explícita. Por exemplo: `"money": {"amount": "12.50", "currency": "BRL"}`. Valores em JSON numérico não são aceitos.

- `POST /wallets` cria uma carteira a partir de `{ "playerId": "...", "initialBalance": { "amount": "100.00", "currency": "BRL" } }`. Um saldo inicial positivo cria atomicamente a transação interna `OPENING` e o lançamento correspondente.
- `GET /wallets/:walletId` consulta o saldo e a versão atuais.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50` lista lançamentos em ordem decrescente com cursor opaco; o limite permitido é de 1 a 100.
- `POST /wagering/transactions` exige o header `Idempotency-Key`. O corpo contém `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e, para transações referenciadas, `referenceExternalTransactionId`.
- `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` consultam transações.
- `POST /wallets/:walletId/reconciliation` compara saldo/versão armazenados com os valores reconstruídos do ledger.

O processamento bloqueia a carteira dentro de uma transação PostgreSQL e confirma saldo, versão, transação, ledger e outbox atomicamente. Repetições idempotentes retornam o snapshot de saldo e versão registrados na operação original; uma mesma chave com payload diferente resulta em `409`. Transações processadas retornam `200`, referências ainda ausentes retornam `202`, rejeições de negócio persistidas retornam `422`, e entradas inválidas retornam `400`. A API gera ou propaga um `X-Correlation-Id` validado nos eventos de outbox.

## Referências fora de ordem

Uma transação que declara uma referência ainda ausente é persistida em `PENDING_REFERENCE`, mantendo o snapshot original de resposta e criando um evento de outbox. O worker periódico consulta tentativas vencidas no PostgreSQL, bloqueia a carteira e a transação em uma transação única, e reavalia a referência antes de qualquer débito/crédito. A operação financeira, o ledger, o estado terminal, o snapshot e o evento de resultado são gravados atomicamente; tentativas concorrentes ou réplicas do serviço revalidam o estado após adquirir os mesmos locks.

Falhas temporárias são reagendadas com backoff exponencial limitado a 60 segundos. Ao exceder `WAGER_REFERENCE_MAX_ATTEMPTS`, a transação passa a `REJECTED` com `REFERENCE_NOT_FOUND` ou `REFERENCE_NOT_PROCESSED`; esse estado e o evento `WagerTransactionRejected` registram a quantidade de tentativas e o motivo de esgotamento. Violações definitivas de referência são rejeitadas assim que a referência pode ser avaliada. O evento `WagerTransactionReferenceRetryScheduled` registra cada reagendamento. As configurações padrão são 5 tentativas, 500 ms de backoff inicial e polling a cada 250 ms; configure `WAGER_REFERENCE_MAX_ATTEMPTS` (1–100), `WAGER_REFERENCE_BACKOFF_MS` e `WAGER_REFERENCE_POLL_MS` (10–60000 ms) no ambiente.

## Verificações

```sh
bun run build
bun run test
bun run test:e2e
bun run lint
```
