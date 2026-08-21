import { AppError } from './AppError';

export class NotFoundError extends AppError {
  constructor(message = 'Risorsa non trovata') {
    super(message, 404, 'RESOURCE_NOT_FOUND');
  }
}
