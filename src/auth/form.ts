import type { FastifyInstance } from 'fastify';

/**
 * `application/x-www-form-urlencoded` support (RFC 6749 §4.1.3 token requests, consent and login
 * forms). Parsed into a `FormBody`, which keeps every value so that repeated parameters can be
 * rejected (RFC 6749 §3.1: "Request and response parameters MUST NOT be included more than once"),
 * while still allowing parameters the RFCs let repeat, such as RFC 8707 `resource`.
 */
export class FormBody {
  constructor(private readonly params: URLSearchParams) {}

  static parse(raw: string): FormBody {
    return new FormBody(new URLSearchParams(raw));
  }

  /** The single value of `name`, or undefined. Empty values count as absent (RFC 6749 §3.1). */
  get(name: string): string | undefined {
    const v = this.params.get(name);
    return v === null || v === '' ? undefined : v;
  }

  getAll(name: string): string[] {
    return this.params.getAll(name).filter((v) => v !== '');
  }

  /** Names that appear more than once, excluding `repeatable` ones. */
  duplicates(repeatable: readonly string[] = []): string[] {
    const seen = new Set<string>();
    const dup = new Set<string>();
    for (const [k] of this.params) {
      if (seen.has(k) && !repeatable.includes(k)) dup.add(k);
      seen.add(k);
    }
    return [...dup];
  }
}

/** Registers the form parser (body limit 16 KiB) on `app`. JSON parsing stays Fastify's default. */
export function registerFormParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 16 * 1024 },
    (_req, body, done) => {
      done(null, FormBody.parse(body as string));
    },
  );
}
