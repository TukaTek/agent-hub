import type { MiddlewareHandler } from "hono";

export const noSniff: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
};
