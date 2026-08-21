import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors';

// express.json() solleva questo errore (non è un AppError) quando il body supera
// il limite di dimensione: senza questo controllo finirebbe nel branch 500 generico.
function isPayloadTooLargeError(err: unknown): err is Error & { type: string; limit?: number; length?: number } {
  return err instanceof Error && 'type' in err && (err as { type?: unknown }).type === 'entity.too.large';
}

// express.json() solleva questo errore per un body che non è JSON valido:
// è un errore del client (400), non un errore interno del server (500).
function isBodyParseError(err: unknown): err is Error & { type: string } {
  return err instanceof Error && 'type' in err && (err as { type?: unknown }).type === 'entity.parse.failed';
}

// Express riconosce questo middleware come "error handler" solo se ha 4 parametri:
// _next non viene usato, ma la sua presenza è richiesta dalla firma di Express.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? {},
      },
    });
    return;
  }

  if (isPayloadTooLargeError(err)) {
    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Il payload della richiesta supera il limite consentito.',
        details: { limit: err.limit, received: err.length },
      },
    });
    return;
  }

  if (isBodyParseError(err)) {
    res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Il corpo della richiesta non è un JSON valido.',
        details: {},
      },
    });
    return;
  }

  console.error(`[ERROR] ${req.method} ${req.originalUrl}`, err);

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Si è verificato un errore interno. Riprova più tardi.',
      details: {},
    },
  });
}
