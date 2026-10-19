import { defineEntity, p } from '@mikro-orm/postgresql';

const WalletSchema = defineEntity({
  name: 'WalletEntity',
  tableName: 'wallets',
  properties: {
    id: p.string().length(64).primary(),
    playerId: p.string().length(128).fieldName('player_id'),
    currency: p.string().length(3),
    balance: p.decimal('string').columnType('numeric'),
    version: p.integer().default(1),
    createdAt: p.datetime().fieldName('created_at'),
    updatedAt: p.datetime().fieldName('updated_at'),
  },
  uniques: [
    {
      properties: ['playerId', 'currency'],
      name: 'wallets_player_currency_uq',
    },
    { properties: ['id', 'currency'], name: 'wallets_id_currency_uq' },
    {
      properties: ['id', 'playerId', 'currency'],
      name: 'wallets_id_player_currency_uq',
    },
  ],
  indexes: [{ properties: ['playerId'], name: 'wallets_player_id_idx' }],
});

export class WalletEntity extends WalletSchema.class {}
WalletSchema.setClass(WalletEntity);
