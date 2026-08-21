import { AppError } from './AppError';

/**
 * Errore 409 Conflict: la richiesta è valida ma collide con lo stato attuale del
 * sistema (es. limite massimo di utenti per azienda già raggiunto). Il client può
 * risolvere il conflitto (es. rimuovendo un utente) e riprovare.
 */
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}
