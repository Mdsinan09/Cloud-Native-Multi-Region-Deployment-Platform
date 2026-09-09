/**
 * Middleware to preserve raw body for HMAC validation
 */
import { Request, Response, NextFunction } from 'express';

export function rawBodyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // If rawBody was already captured by express.json verify function
  if ((req as any).rawBody !== undefined) {
    return next();
  }

  // Otherwise, read incoming stream if body has not been parsed
  if (req.body !== undefined && typeof req.body === 'object') {
    (req as any).rawBody = JSON.stringify(req.body);
    return next();
  }

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
