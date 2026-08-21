import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

// Si salva solo l'hash del token, mai il valore in chiaro — stessa logica di
// refreshTokens.ts (un dump del DB non deve permettere di impersonare un utente).
// `usedAt` e non `revokedAt`: un token di reset è monouso, "già speso" è un concetto
// diverso da "revocato" — non serve un motivo di revoca, solo se è già stato consumato.
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // cascade: cancellare uno user deve rimuovere anche i suoi token di reset pendenti.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('password_reset_tokens_user_id_idx').on(table.userId),
    // Ogni reset cerca per hash con "used_at IS NULL": indice composto per rendere
    // quella lookup index-only, stesso idioma di refreshTokens.tokenHashIdx.
    tokenHashIdx: index('password_reset_tokens_token_hash_idx').on(table.tokenHash, table.usedAt),
  }),
);
