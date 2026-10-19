import { Migration } from '@mikro-orm/migrations';

export class Migration20261019193000_AddWagerResultSnapshot extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "result_balance" numeric null,
        add column "result_wallet_version" integer null,
        add constraint "wager_transactions_result_balance_ck"
          check ("result_balance" is null or (
            "result_balance" >= 0 and "result_balance" = round("result_balance", 2)
          )),
        add constraint "wager_transactions_result_version_ck"
          check ("result_wallet_version" is null or "result_wallet_version" >= 1);

      create function "guard_wager_result_snapshot_update"()
      returns trigger language plpgsql as $$
      begin
        if old."status" in ('PROCESSED', 'REJECTED', 'FAILED')
          and old."result_balance" is not null
          and (
            new."result_balance" is distinct from old."result_balance"
            or new."result_wallet_version" is distinct from old."result_wallet_version"
          ) then
          raise exception 'Wager result snapshots are immutable';
        end if;
        return new;
      end;
      $$;

      create trigger "wager_result_snapshot_immutable"
        before update on "wager_transactions"
        for each row execute function "guard_wager_result_snapshot_update"();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger if exists "wager_result_snapshot_immutable" on "wager_transactions";
      drop function if exists "guard_wager_result_snapshot_update"();
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_result_version_ck",
        drop constraint if exists "wager_transactions_result_balance_ck",
        drop column if exists "result_wallet_version",
        drop column if exists "result_balance";
    `);
  }
}
