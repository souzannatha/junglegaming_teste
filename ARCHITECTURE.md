# Arquitetura e decisões operacionais

## Consistência financeira

- O PostgreSQL é a fonte de verdade para idempotência e invariantes financeiras. As alterações de carteira são executadas em uma transação de banco de dados e bloqueiam a linha da carteira com `FOR UPDATE`; restrições de unicidade e triggers deferred protegem as mesmas invariantes entre instâncias da aplicação.
- Os valores monetários são strings decimais na entrada HTTP/SQS, valores exatos `NUMERIC` no PostgreSQL e unidades monetárias mínimas `bigint` no domínio. Eles nunca são convertidos para números de ponto flutuante do JavaScript.
- Cada alteração de saldo, transação de wagering, lançamento imutável no ledger e evento de integração é confirmado atomicamente. Uma operação de negócio rejeitada é persistida com seu código de falha estável e não altera o saldo nem o ledger.
- A idempotência da requisição é definida pelo provedor e pela chave. O hash do payload canônico detecta a reutilização da chave com dados de negócio diferentes; em uma repetição válida, o snapshot do resultado original é retornado.
- A reconciliação do ledger reconstrói o saldo e a versão a partir dos lançamentos enquanto mantém o bloqueio da carteira. Uma divergência é registrada e retornada como inconsistência; o endpoint não corrige os dados financeiros automaticamente.

## Garantias de mensageria

- Produtores devem usar um `MessageGroupId` estável por carteira para preservar a ordem dos comandos daquela carteira na fila FIFO. O `MessageDeduplicationId` deve identificar uma tentativa de envio; a inbox do PostgreSQL e a idempotência do wagering continuam sendo as proteções duráveis contra duplicatas.
- O consumidor de comandos e a DLQ usam filas FIFO. As filas do LocalStack são provisionadas automaticamente; filas gerenciadas externamente podem ser configuradas por meio de suas URLs. A política de redrive da fila de origem encaminha à DLQ as mensagens que falharem repetidamente.
- O consumidor registra `(consumer_name, message_id)` em `inbox_messages` na mesma transação PostgreSQL do wagering, ledger e outbox. A mensagem SQS só é excluída após o commit. Se o processo parar antes da confirmação, o timeout de visibilidade disponibiliza a mensagem novamente, e a inbox impede um segundo efeito financeiro.
- Erros de contrato e conflitos da requisição são permanentes e a mensagem é copiada para a DLQ antes da confirmação. Falhas de banco de dados, SQS e erros inesperados são transitórios: a mensagem não é confirmada e pode ser tentada novamente. Rejeições de negócio persistidas (como saldo insuficiente) são resultados finais do domínio e são confirmadas.
- A entrega da outbox é **at-least-once** (pelo menos uma vez). Uma falha do processo após o SQS aceitar um evento, mas antes de o PostgreSQL registrar a confirmação, pode causar uma duplicata; consumidores downstream devem deduplicar pelo `eventId`.
- `enableShutdownHooks()` encaminha o SIGTERM para os hooks de ciclo de vida do NestJS. Os workers param de buscar mensagens e aguardam a conclusão do trabalho em andamento; configure o timeout de visibilidade do SQS para ser maior que a duração esperada de um comando.

## Observabilidade e saúde

- `GET /health/live` informa que o processo está respondendo e não depende de serviços externos.
- `GET /health/ready` verifica o PostgreSQL e informa o estado dos workers habilitados. Um worker desativado por configuração é reportado como desativado e não impede a prontidão; um worker habilitado que ainda esteja iniciando ou esteja indisponível retorna HTTP 503.
- `GET /metrics` expõe métricas no formato de texto do Prometheus: totais, duração e quantidade de requisições HTTP em andamento; resultados de publicação da outbox; tentativas de resolução de referências; resultados de mensagens SQS; e resultados de reconciliação.
- As métricas ficam em memória e são locais a cada processo. Faça o scrape de cada instância da aplicação separadamente e agregue os dados na plataforma de monitoramento; os contadores são reiniciados quando o processo reinicia. Os labels usam modelos de rota e valores de resultado limitados, nunca IDs de carteira, jogador ou provedor.
- Os logs HTTP e dos workers são estruturados em JSON e não incluem corpos de requisição, valores monetários, credenciais nem payloads de mensagens. Os logs de reconciliação identificam a carteira e as versões, mas não registram valores financeiros.

## Autenticação e implantação

Autenticação e autorização não fazem parte do escopo deste teste técnico. Não exponha o serviço HTTP publicamente sem adicionar um provedor de identidade, autorização por provedor, TLS e gerenciamento operacional de segredos. Restrinja as permissões de banco de dados e SQS às necessidades do serviço e forneça as credenciais da AWS pela cadeia padrão de credenciais do SDK, nunca por arquivos versionados.

As credenciais padrão do Compose e o endpoint do LocalStack servem apenas para desenvolvimento local. Em produção, provisione filas FIFO e DLQs com infraestrutura como código, use backups e monitoramento gerenciados para o PostgreSQL, defina limites explícitos para workers, tentativas e visibilidade, e configure alertas para falhas de prontidão, crescimento da DLQ, idade da outbox, divergências de reconciliação e aumento na taxa de novas tentativas.

## Validação

Execute `bun run build`, `bun run lint`, `bun run test`, `bun run test:e2e` e `bun run typecheck`. Os testes end-to-end exigem que as migrations do PostgreSQL tenham sido aplicadas e que o SQS do LocalStack esteja disponível. Eles cobrem invariantes financeiras entre instâncias separadas da aplicação, tentativas e encaminhamento à DLQ no SQS, deduplicação da inbox após reinício da aplicação e reconciliação do saldo com o ledger.
