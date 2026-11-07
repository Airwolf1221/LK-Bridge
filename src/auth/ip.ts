import { BlockList, isIP } from 'node:net';

/**
 * Address policy for outbound fetches of Client ID Metadata Documents (SSRF protection).
 * Only globally routable unicast addresses are allowed: private, loopback, link-local, CGNAT,
 * multicast, documentation, benchmarking and reserved ranges are refused, for IPv4 and IPv6,
 * including IPv4 addresses embedded in IPv6 (mapped, compatible, NAT64, 6to4, Teredo).
 */

// Separate lists: a single BlockList matches IPv4 addresses against IPv4-mapped IPv6 rules too.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (includes cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
] as const) {
  blocked4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated)
  ['::ffff:0:0', 96], // IPv4-mapped (checked separately as IPv4 too)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, benchmarking...)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment routing SIDs
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked6.addSubnet(net, prefix, 'ipv6');
}

/** True only for globally routable unicast addresses. Non-IP strings are not public. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(bare);
  if (family === 4) return !blocked4.check(bare, 'ipv4');
  if (family === 6) {
    // Embedded IPv4 forms (mapped, compatible, NAT64) fall in blocked subnets; refuse them all.
    if (bare.includes('.') || blocked6.check(bare, 'ipv6')) return false;
    // Global unicast is 2000::/3; everything else is reserved or special-purpose.
    const first = parseInt(bare.split(':')[0] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}
