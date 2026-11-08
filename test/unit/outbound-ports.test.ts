import { describe, expect, it } from 'vitest';
import { outboundPortAllowed, parseOutboundPortAllowlist } from '../../src/auth/ports.js';

describe('outbound port policy (v1.0.1, F-19)', () => {
  it('allows 443 (explicit or implied) and nothing else by default', () => {
    expect(outboundPortAllowed(new URL('https://example.org/x'))).toBe(true);
    expect(outboundPortAllowed(new URL('https://example.org:443/x'))).toBe(true);
    for (const port of [80, 22, 8443, 6379, 1]) {
      expect(outboundPortAllowed(new URL(`https://example.org:${port}/x`)), String(port)).toBe(false);
    }
  });

  it('allows exactly the listed host:port pairs', () => {
    const list = parseOutboundPortAllowlist(' Images.Example.org:8443 , [2001:DB8::1]:9443,10.0.0.1:8000 ');
    expect(outboundPortAllowed(new URL('https://images.example.org:8443/a'), list)).toBe(true);
    expect(outboundPortAllowed(new URL('https://IMAGES.example.org:8443/a'), list)).toBe(true);
    expect(outboundPortAllowed(new URL('https://[2001:db8::1]:9443/a'), list)).toBe(true);
    // Another port on the same host, or the same port on another host (a subdomain included), is refused.
    expect(outboundPortAllowed(new URL('https://images.example.org:8444/a'), list)).toBe(false);
    expect(outboundPortAllowed(new URL('https://cdn.images.example.org:8443/a'), list)).toBe(false);
    expect(outboundPortAllowed(new URL('https://example.org:8443/a'), list)).toBe(false);
    // The URL parser's IPv4 normalisation applies to both sides (0x0a.0.0.1 is 10.0.0.1).
    expect(outboundPortAllowed(new URL('https://0x0a.0.0.1:8000/a'), list)).toBe(true);
  });

  it('is empty when unset or blank, and refuses malformed entries by name', () => {
    expect(parseOutboundPortAllowlist(undefined).size).toBe(0);
    expect(parseOutboundPortAllowlist('').size).toBe(0);
    expect(parseOutboundPortAllowlist(' , ').size).toBe(0);
    for (const bad of [
      'example.org',
      '*.example.org:8443',
      'https://example.org:8443',
      'example.org:8443/path',
      'example.org:0',
      'example.org:65536',
      'user@example.org:8443',
      ':8443',
      '2001:db8::1:8443',
    ]) {
      expect(() => parseOutboundPortAllowlist(bad), bad).toThrow(/OUTBOUND_EXTRA_PORTS_ALLOWLIST/);
    }
  });
});
