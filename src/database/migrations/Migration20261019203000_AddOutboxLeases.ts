import { Migration } from '@mikro-orm/migrations';

export class Migration20261019203000_AddOutboxLeases extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "outbox_messages"
        add column "lease_token" varchar(64) null,
        add column "lease_until" timestamptz null,
        add column "last_error" varchar(128) null,
        add constraint "outbox_messages_lease_pair_ck"
          check (("lease_token" is null) = ("lease_until" is null));

      create index "outbox_messages_claim_idx"
        on "outbox_messages" ("lease_until", "next_attempt_at", "occurred_at", "id")
        where "published_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index if exists "outbox_messages_claim_idx";
      alter table "outbox_messages"
        drop constraint if exists "outbox_messages_lease_pair_ck",
        drop column if exists "last_error",
        drop column if exists "lease_until",
        drop column if exists "lease_token";
    `);
  }
}
