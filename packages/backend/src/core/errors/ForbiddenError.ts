import { AppError } from './AppError';

export class ForbiddenError extends AppError {
  constructor(message = 'Permesso negato') {
    super(message, 403, 'FORBIDDEN');
  }
}
