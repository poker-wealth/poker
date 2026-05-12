import type { Request } from 'express';

/** Narrow a single-value path param to string. Express 5 types these as
 * `string | string[]` because of array params, but we only use `:id`-style
 * captures which are always strings. */
export function pathParam(req: Request, key: string): string {
  const v = req.params[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`pathParam: expected non-empty string for ${key}`);
  }
  return v;
}
