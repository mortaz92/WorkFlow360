import type { Request, Response, NextFunction } from 'express';
import { NotFoundError } from '../errors';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Rotta non trovata: ${req.method} ${req.originalUrl}`));
}
