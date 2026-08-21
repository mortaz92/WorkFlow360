import { AppError } from './AppError';

export class UnauthorizedError extends AppError {
  constructor(message = 'Autenticazione richiesta') {
    super(message, 401, 'UNAUTHORIZED');
  }
}
