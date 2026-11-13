import { expect, it } from 'vitest';
import { anonymousBucket, inRanges, parseCidr } from '../src/core/ip';

// www trusts only forwarded caller keys of this shape (ctcfinal src/lib/utils/caller-key.ts); anything else
// falls back to www's own limiter, so every bucket the Worker forwards must match it.
const WWW_FORWARDED_KEY = /^(?:k|ip):[A-Za-z0-9.:_-]{1,128}$/u;

it.each([
  ['192.0.2.15', 'ip:192.0.2.15'],
  ['2001:db8:1:2:3:4:5:6', 'ip:2001:db8:1:2::'],
  ['2001:0db8:0001:0002:ffff:ffff:ffff:ffff', 'ip:2001:db8:1:2::'],
  ['2001:db8:1:2::9', 'ip:2001:db8:1:2::'],
  ['2001:DB8:1:2::9', 'ip:2001:db8:1:2::'],
  ['2001:db8::1', 'ip:2001:db8:0:0::'],
  ['::1', 'ip:0:0:0:0::'],
  ['::ffff:192.0.2.15', 'ip:192.0.2.15'],
  ['::ffff:c000:20f', 'ip:192.0.2.15'],
  [null, 'ip:unknown'],
  ['not an address', 'ip:unknown'],
  ['192.0.2.256', 'ip:unknown'],
  ['2001:db8::1::2', 'ip:unknown'],
  ['fe80::1%eth0', 'ip:unknown'],
])('buckets %s as %s', (ip, bucket) => {
  expect(anonymousBucket(ip)).toBe(bucket);
  expect(bucket).toMatch(WWW_FORWARDED_KEY);
});

it('puts every address in one IPv6 /64 into one bucket and the next /64 into another', () => {
  expect(anonymousBucket('2001:db8:aa:bb::1')).toBe(anonymousBucket('2001:db8:aa:bb:ffff:ffff:ffff:fffe'));
  expect(anonymousBucket('2001:db8:aa:bb::1')).not.toBe(anonymousBucket('2001:db8:aa:bc::1'));
});

it('matches IPv4 and IPv6 addresses against CIDR ranges', () => {
  const ranges = ['160.79.104.0/21', '153.61.208.0/20', '2001:db8:100::/48'].map(text => parseCidr(text)!);
  expect(inRanges('160.79.104.0', ranges)).toBe(true);
  expect(inRanges('160.79.111.255', ranges)).toBe(true);
  expect(inRanges('160.79.112.0', ranges)).toBe(false);
  expect(inRanges('153.61.223.255', ranges)).toBe(true);
  expect(inRanges('::ffff:160.79.104.9', ranges)).toBe(true);
  expect(inRanges('2001:db8:100:ffff::1', ranges)).toBe(true);
  expect(inRanges('2001:db8:101::1', ranges)).toBe(false);
  expect(inRanges('192.0.2.1', ranges)).toBe(false);
  expect(inRanges('garbage', ranges)).toBe(false);
});

it.each(['160.79.104.0', '160.79.104.0/33', '2001:db8::/129', 'x/8', '160.79.104.0/-1', '160.79.104.0/8.5'])(
  'rejects the malformed range %s', text => { expect(parseCidr(text)).toBeNull(); },
);
