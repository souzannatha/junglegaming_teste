import { Migration } from '@mikro-orm/migrations';

export class Migration20261019200000_AddReferenceRetryPolicy extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "wager_transactions"
        add column "reference_attempts" integer not null default 0,
        add column "next_reference_attempt_at" timestamptz null,
        add constraint "wager_transactions_reference_attempts_ck"
          check ("reference_attempts" >= 0);

      create index "wager_transactions_reference_retry_due_idx"
        on "wager_transactions" ("next_reference_attempt_at", "created_at", "id")
        where "status" = 'PENDING_REFERENCE'
          and "next_reference_attempt_at" is not null;

      update "wager_transactions"
      set "next_reference_attempt_at" = "created_at"
      where "status" = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index if exists "wager_transactions_reference_retry_due_idx";
      alter table "wager_transactions"
        drop constraint if exists "wager_transactions_reference_attempts_ck",
        drop column if exists "next_reference_attempt_at",
        drop column if exists "reference_attempts";
    `);
  }
}
