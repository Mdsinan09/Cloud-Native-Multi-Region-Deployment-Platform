/**
 * Middleware to preserve raw body for HMAC validation
 * Must be applied BEFORE express.json() on webhook routes
 */
import { Request, Response, NextFunction } from 'express';

export function rawBodyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  let data = '';
  req.setEncoding('utf8');

  req.on('data', (chunk: string) => {
    data += chunk;
  });

  req.on('end', () => {
    (req as Request & { rawBody?: string }).rawBody = data;
    next();
  });
}
