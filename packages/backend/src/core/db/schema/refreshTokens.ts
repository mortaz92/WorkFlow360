import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

// Si salva solo l'hash del refresh token, mai il token in chiaro (stessa logica
// di una password): un dump del DB non deve permettere di impersonare un utente.
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // cascade: cancellare uno user deve invalidare/rimuovere ogni suo refresh token.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('refresh_tokens_user_id_idx').on(table.userId),
    // Ogni refresh e ogni logout cercano per hash con "revoked_at IS NULL": indice
    // composto per rendere quella lookup index-only invece di una scansione.
    tokenHashIdx: index('refresh_tokens_token_hash_idx').on(table.tokenHash, table.revokedAt),
  }),
);
