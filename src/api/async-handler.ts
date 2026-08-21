import type { Request, Response, NextFunction } from 'express';

/**
 * Wraps an async Express handler so a rejected promise is forwarded to
 * `next(err)` (and therefore to the JSON error-handling middleware in
 * server.ts) instead of becoming an unhandled rejection. Express 5 added
 * automatic forwarding for this exact case, but in practice a Key Value
 * connection failure a couple of `await`s deep (state.ts's lazily-connecting
 * singleton) was still surfacing as Express's default HTML error page in
 * manual testing here -- wrapping explicitly removes any doubt rather than
 * relying on that framework behavior.
 */
export function asyncHandler<Req extends Request = Request>(
  handler: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Req, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
