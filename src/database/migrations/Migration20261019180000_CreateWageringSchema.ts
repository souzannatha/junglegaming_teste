import { Migration } from '@mikro-orm/migrations';

export class Migration20261019180000_CreateWageringSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" varchar(64) not null,
        "player_id" varchar(128) not null,
        "currency" char(3) not null,
        "balance" numeric not null,
        "version" integer not null default 1,
        "created_at" timestamptz not null,
        "updated_at" timestamptz not null,
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_player_currency_uq" unique ("player_id", "currency"),
        constraint "wallets_id_currency_uq" unique ("id", "currency"),
        constraint "wallets_id_player_currency_uq"
          unique ("id", "player_id", "currency"),
        constraint "wallets_balance_nonnegative_ck" check ("balance" >= 0),
        constraint "wallets_balance_scale_ck" check ("balance" = round("balance", 2)),
        constraint "wallets_currency_ck" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wallets_version_positive_ck" check ("version" >= 1)
      );
      create index "wallets_player_id_idx" on "wallets" ("player_id");
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" varchar(64) not null,
        "provider_id" varchar(128) not null,
        "external_transaction_id" varchar(256) not null,
        "idempotency_key" varchar(256) not null,
        "payload_hash" varchar(128) not null,
        "wallet_id" varchar(64) not null,
        "player_id" varchar(128) not null,
        "round_id" varchar(128) not null,
        "game_id" varchar(128) not null,
        "kind" varchar(16) not null,
        "amount" numeric not null,
        "currency" char(3) not null,
        "reference_external_transaction_id" varchar(256) null,
        "reference_transaction_id" varchar(64) null,
        "status" varchar(24) not null,
        "failure_code" varchar(64) null,
        "created_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_provider_idempotency_uq"
          unique ("provider_id", "idempotency_key"),
        constraint "wager_transactions_provider_external_uq"
          unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_id_wallet_uq" unique ("id", "wallet_id"),
        constraint "wager_transactions_wallet_currency_fk"
          foreign key ("wallet_id", "currency")
          references "wallets" ("id", "currency") on update restrict on delete restrict,
        constraint "wager_transactions_wallet_player_currency_fk"
          foreign key ("wallet_id", "player_id", "currency")
          references "wallets" ("id", "player_id", "currency") on update restrict on delete restrict,
        constraint "wager_transactions_reference_fk"
          foreign key ("reference_transaction_id")
          references "wager_transactions" ("id") on update restrict on delete restrict,
        constraint "wager_transactions_kind_ck"
          check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_ck"
          check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_amount_positive_ck" check ("amount" > 0),
        constraint "wager_transactions_amount_scale_ck" check ("amount" = round("amount", 2)),
        constraint "wager_transactions_currency_ck" check ("currency" ~ '^[A-Z]{3}$'),
        constraint "wager_transactions_reference_required_ck"
          check ("kind" not in ('REFUND', 'ROLLBACK') or "reference_external_transaction_id" is not null),
        constraint "wager_transactions_opening_internal_ck"
          check ("kind" <> 'OPENING' or "provider_id" = 'internal'),
        constraint "wager_transactions_terminal_fields_ck"
          check (
            ("status" = 'PROCESSED' and "processed_at" is not null and "failure_code" is null)
            or ("status" in ('REJECTED', 'FAILED') and "failure_code" is not null)
            or ("status" in ('PENDING', 'PENDING_REFERENCE') and "processed_at" is null and "failure_code" is null)
          )
      );
      create index "wager_transactions_wallet_created_idx"
        on "wager_transactions" ("wallet_id", "created_at", "id");
      create index "wager_transactions_status_created_idx"
        on "wager_transactions" ("status", "created_at");
      create index "wager_transactions_provider_reference_idx"
        on "wager_transactions" ("provider_id", "reference_external_transaction_id");
      create index "wager_transactions_pending_reference_idx"
        on "wager_transactions" ("created_at", "id")
        where "status" = 'PENDING_REFERENCE';
      create unique index "wager_transactions_reference_reversal_uq"
        on "wager_transactions" ("provider_id", "reference_external_transaction_id", "kind")
        where "kind" in ('REFUND', 'ROLLBACK')
          and "reference_external_transaction_id" is not null
          and "status" not in ('REJECTED', 'FAILED');
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" varchar(64) not null,
        "wallet_id" varchar(64) not null,
        "transaction_id" varchar(64) not null,
        "direction" varchar(8) not null,
        "amount" numeric not null,
        "balance_before" numeric not null,
        "balance_after" numeric not null,
        "currency" char(3) not null,
        "wallet_version" integer not null,
        "created_at" timestamptz not null,
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_wallet_transaction_uq"
          unique ("wallet_id", "transaction_id"),
        constraint "wallet_ledger_wallet_version_uq"
          unique ("wallet_id", "wallet_version"),
        constraint "wallet_ledger_wallet_currency_fk"
          foreign key ("wallet_id", "currency")
          references "wallets" ("id", "currency") on update restrict on delete restrict,
        constraint "wallet_ledger_transaction_wallet_fk"
          foreign key ("transaction_id", "wallet_id")
          references "wager_transactions" ("id", "wallet_id") on update restrict on delete restrict,
        constraint "wallet_ledger_direction_ck" check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_amount_positive_ck" check ("amount" > 0),
        constraint "wallet_ledger_amount_scale_ck" check (
          "amount" = round("amount", 2)
          and "balance_before" = round("balance_before", 2)
          and "balance_after" = round("balance_after", 2)
        ),
        constraint "wallet_ledger_balance_nonnegative_ck"
          check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_wallet_version_ck" check ("wallet_version" >= 1),
        constraint "wallet_ledger_arithmetic_ck"
          check (
            ("direction" = 'CREDIT' and "balance_before" + "amount" = "balance_after")
            or ("direction" = 'DEBIT' and "balance_before" - "amount" = "balance_after")
          )
      );
      create index "wallet_ledger_wallet_cursor_idx"
        on "wallet_ledger_entries" ("wallet_id", "created_at" desc, "id" desc);
    `);

    this.addSql(`
      create table "inbox_messages" (
        "consumer_name" varchar(128) not null,
        "message_id" varchar(256) not null,
        "payload_hash" varchar(128) not null,
        "received_at" timestamptz not null,
        "processed_at" timestamptz null,
        constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id")
      );
      create index "inbox_messages_received_idx"
        on "inbox_messages" ("received_at");
    `);

    this.addSql(`
      create table "outbox_messages" (
        "id" varchar(64) not null,
        "event_id" varchar(64) not null,
        "aggregate_id" varchar(128) not null,
        "event_type" varchar(128) not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz null,
        "published_at" timestamptz null,
        constraint "outbox_messages_pkey" primary key ("id"),
        constraint "outbox_messages_event_id_uq" unique ("event_id"),
        constraint "outbox_messages_attempts_nonnegative_ck" check ("attempts" >= 0),
        constraint "outbox_messages_payload_object_ck" check (jsonb_typeof("payload") = 'object')
      );
      create index "outbox_messages_due_idx"
        on "outbox_messages" ("next_attempt_at", "occurred_at", "id")
        where "published_at" is null;
    `);

    this.addSql(`
      create function "guard_wallet_balance_update"()
      returns trigger language plpgsql as $$
      begin
        if new."id" <> old."id"
          or new."player_id" <> old."player_id"
          or new."currency" <> old."currency"
          or new."created_at" <> old."created_at" then
          raise exception 'Wallet identity fields are immutable';
        end if;

        if new."balance" is distinct from old."balance" then
          if new."version" <> old."version" + 1 then
            raise exception 'Wallet balance changes must increment version exactly once';
          end if;
          if new."updated_at" < old."updated_at" then
            raise exception 'Wallet updated_at cannot move backwards';
          end if;
        elsif new."version" <> old."version" then
          raise exception 'Wallet version can change only when balance changes';
        end if;

        return new;
      end;
      $$;

      create trigger "wallet_balance_update_guard"
        before update on "wallets"
        for each row execute function "guard_wallet_balance_update"();
    `);

    this.addSql(`
      create function "assert_wallet_has_matching_ledger"()
      returns trigger language plpgsql as $$
      declare
        new_row jsonb;
        target_wallet_id varchar(64);
        current_balance numeric;
        current_currency char(3);
        current_version integer;
        future_ledger_entries integer;
      begin
        new_row := to_jsonb(new);
        if tg_table_name = 'wallets' then
          target_wallet_id := new_row ->> 'id';
        else
          target_wallet_id := new_row ->> 'wallet_id';
        end if;

        select "balance", "currency", "version"
          into current_balance, current_currency, current_version
          from "wallets"
          where "id" = target_wallet_id;

        if not found then
          return null;
        end if;

        if current_balance = 0 and current_version = 1
          and not exists (
            select 1 from "wallet_ledger_entries"
            where "wallet_id" = target_wallet_id
          ) then
          return null;
        end if;

        select count(*)::integer into future_ledger_entries
          from "wallet_ledger_entries"
          where "wallet_id" = target_wallet_id
            and "wallet_version" > current_version;

        if future_ledger_entries <> 0 then
          raise exception 'Ledger entries cannot advance beyond the wallet version';
        end if;

        if not exists (
          select 1 from "wallet_ledger_entries"
          where "wallet_id" = target_wallet_id
            and "wallet_version" = current_version
            and "currency" = current_currency
            and "balance_after" = current_balance
        ) then
          raise exception 'Wallet balance/version must match a ledger entry at commit';
        end if;

        return null;
      end;
      $$;

      create constraint trigger "wallet_balance_ledger_consistency"
        after insert or update on "wallets"
        deferrable initially deferred
        for each row execute function "assert_wallet_has_matching_ledger"();

      create constraint trigger "ledger_wallet_balance_consistency"
        after insert on "wallet_ledger_entries"
        deferrable initially deferred
        for each row execute function "assert_wallet_has_matching_ledger"();
    `);

    this.addSql(`
      create function "assert_transaction_ledger_consistency"()
      returns trigger language plpgsql as $$
      declare
        new_row jsonb;
        target_transaction_id varchar(64);
        transaction_kind varchar(16);
        transaction_status varchar(24);
        transaction_amount numeric;
        transaction_currency char(3);
        transaction_wallet_id varchar(64);
        transaction_player_id varchar(128);
        transaction_round_id varchar(128);
        transaction_reference_id varchar(64);
        transaction_reference_external_id varchar(256);
        ledger_count integer;
        ledger_direction varchar(8);
        reference_kind varchar(16);
        reference_status varchar(24);
        reference_provider_id varchar(128);
        reference_external_id varchar(256);
        reference_player_id varchar(128);
        reference_wallet_id varchar(64);
        reference_round_id varchar(128);
        reference_currency char(3);
        reference_amount numeric;
      begin
        new_row := to_jsonb(new);
        if tg_table_name = 'wager_transactions' then
          target_transaction_id := new_row ->> 'id';
        else
          target_transaction_id := new_row ->> 'transaction_id';
        end if;

        select "kind", "status", "amount", "currency", "wallet_id",
          "player_id", "round_id", "reference_transaction_id",
          "reference_external_transaction_id"
          into transaction_kind, transaction_status, transaction_amount,
            transaction_currency, transaction_wallet_id, transaction_player_id,
            transaction_round_id, transaction_reference_id,
            transaction_reference_external_id
          from "wager_transactions"
          where "id" = target_transaction_id;

        if not found then
          return null;
        end if;

        if transaction_status = 'PROCESSED'
          and (transaction_kind in ('REFUND', 'ROLLBACK')
            or transaction_reference_external_id is not null) then
          if transaction_reference_id is null then
            raise exception 'Processed transaction reference must be resolved';
          end if;

          select "kind", "status", "provider_id", "external_transaction_id",
            "player_id", "wallet_id", "round_id", "currency", "amount"
            into reference_kind, reference_status, reference_provider_id,
              reference_external_id, reference_player_id, reference_wallet_id,
              reference_round_id, reference_currency, reference_amount
            from "wager_transactions"
            where "id" = transaction_reference_id;

          if reference_status <> 'PROCESSED'
            or reference_provider_id <> (
              select "provider_id" from "wager_transactions"
              where "id" = target_transaction_id
            )
            or reference_external_id <> transaction_reference_external_id then
            raise exception 'Reference must resolve to a processed transaction from the same provider';
          end if;

          if reference_player_id <> transaction_player_id
            or reference_wallet_id <> transaction_wallet_id
            or reference_round_id <> transaction_round_id
            or reference_currency <> transaction_currency then
            raise exception 'Reference transaction context must match';
          end if;

          if transaction_kind = 'WIN' and reference_kind <> 'BET' then
            raise exception 'WIN can reference only a BET';
          elsif transaction_kind = 'REFUND' and reference_kind <> 'BET' then
            raise exception 'REFUND can reference only a BET';
          elsif transaction_kind = 'ROLLBACK'
            and reference_kind not in ('BET', 'WIN', 'REFUND') then
            raise exception 'ROLLBACK reference kind is not reversible';
          end if;

          if transaction_kind in ('REFUND', 'ROLLBACK')
            and transaction_amount <> reference_amount then
            raise exception 'Reversal amount must equal reference amount';
          end if;
        end if;

        select count(*)::integer, min("direction")
          into ledger_count, ledger_direction
          from "wallet_ledger_entries"
          where "transaction_id" = target_transaction_id;

        if transaction_status = 'PROCESSED' then
          if transaction_kind = 'LOSS' and ledger_count <> 0 then
            raise exception 'LOSS transactions cannot have ledger entries';
          elsif transaction_kind <> 'LOSS' and ledger_count <> 1 then
            raise exception 'Processed financial transactions require exactly one ledger entry';
          end if;
        elsif ledger_count <> 0 then
          raise exception 'Only processed transactions may have ledger entries';
        end if;

        if ledger_count = 1 then
          if not exists (
            select 1 from "wallet_ledger_entries"
            where "transaction_id" = target_transaction_id
              and "wallet_id" = transaction_wallet_id
              and "amount" = transaction_amount
              and "currency" = transaction_currency
          ) then
            raise exception 'Ledger entry must match its transaction wallet, amount, and currency';
          end if;

          if transaction_kind in ('OPENING', 'WIN', 'REFUND')
            and ledger_direction <> 'CREDIT' then
            raise exception 'Transaction kind requires a CREDIT ledger entry';
          elsif transaction_kind = 'BET' and ledger_direction <> 'DEBIT' then
            raise exception 'BET requires a DEBIT ledger entry';
          elsif transaction_kind = 'ROLLBACK' then
            select "kind" into reference_kind
              from "wager_transactions"
              where "id" = (
                select "reference_transaction_id"
                from "wager_transactions"
                where "id" = target_transaction_id
              );

            if reference_kind is null then
              raise exception 'ROLLBACK requires a resolved reference transaction';
            elsif reference_kind = 'BET' and ledger_direction <> 'CREDIT' then
              raise exception 'ROLLBACK of BET requires a CREDIT ledger entry';
            elsif reference_kind in ('WIN', 'REFUND') and ledger_direction <> 'DEBIT' then
              raise exception 'ROLLBACK of WIN or REFUND requires a DEBIT ledger entry';
            elsif reference_kind not in ('BET', 'WIN', 'REFUND') then
              raise exception 'ROLLBACK reference kind is not reversible';
            end if;
          end if;
        end if;

        return null;
      end;
      $$;

      create constraint trigger "transaction_ledger_consistency"
        after insert or update on "wager_transactions"
        deferrable initially deferred
        for each row execute function "assert_transaction_ledger_consistency"();

      create constraint trigger "ledger_transaction_consistency"
        after insert on "wallet_ledger_entries"
        deferrable initially deferred
        for each row execute function "assert_transaction_ledger_consistency"();
    `);

    this.addSql(`
      create function "reject_ledger_mutation"()
      returns trigger language plpgsql as $$
      begin
        raise exception 'Wallet ledger entries are immutable';
      end;
      $$;

      create trigger "wallet_ledger_no_update"
        before update or delete on "wallet_ledger_entries"
        for each row execute function "reject_ledger_mutation"();

      create trigger "wallet_ledger_no_truncate"
        before truncate on "wallet_ledger_entries"
        for each statement execute function "reject_ledger_mutation"();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger if exists "wallet_ledger_no_truncate" on "wallet_ledger_entries";
      drop trigger if exists "wallet_ledger_no_update" on "wallet_ledger_entries";
      drop trigger if exists "transaction_ledger_consistency" on "wager_transactions";
      drop trigger if exists "ledger_transaction_consistency" on "wallet_ledger_entries";
      drop trigger if exists "wallet_balance_ledger_consistency" on "wallets";
      drop trigger if exists "ledger_wallet_balance_consistency" on "wallet_ledger_entries";
      drop trigger if exists "wallet_balance_update_guard" on "wallets";
      drop function if exists "reject_ledger_mutation"();
      drop function if exists "assert_transaction_ledger_consistency"();
      drop function if exists "assert_wallet_has_matching_ledger"();
      drop function if exists "guard_wallet_balance_update"();
      drop table if exists "outbox_messages";
      drop table if exists "inbox_messages";
      drop table if exists "wallet_ledger_entries";
      drop table if exists "wager_transactions";
      drop table if exists "wallets";
    `);
  }
}
