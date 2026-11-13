/** An address as a number: 32 bits for IPv4, 128 for IPv6. IPv4-mapped IPv6 addresses read as IPv4. */
export interface Address { version: 4 | 6; value: bigint }
export interface Cidr { version: 4 | 6; network: bigint; bits: number }

const WIDTH = { 4: 32, 6: 128 } as const;

const parseIpv4 = (text: string): bigint | null => {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return null;
  return parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n);
};

const parseIpv6 = (text: string): bigint | null => {
  // A dotted IPv4 tail (::ffff:192.0.2.1) is two hextets written another way.
  let tail: bigint | null = null;
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.', lastColon)) {
    tail = parseIpv4(text.slice(lastColon + 1));
    if (tail === null) return null;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const split = (half: string) => half === '' ? [] : half.split(':');
  const head = split(halves[0]!); const rest = halves.length === 2 ? split(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!groups.every(group => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  const value = groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
  return tail === null ? value : (value & ~0xffffffffn) | tail;
};

const parseAddress = (text: string): Address | null => {
  if (!text.includes(':')) {
    const value = parseIpv4(text);
    return value === null ? null : { version: 4, value };
  }
  const value = parseIpv6(text);
  if (value === null) return null;
  // ::ffff:0:0/96: the top 96 bits are 0...0ffff.
  return value >> 32n === 0xffffn
    ? { version: 4, value: value & 0xffffffffn } : { version: 6, value };
};

const formatIpv4 = (value: bigint) => [24n, 16n, 8n, 0n].map(shift => String((value >> shift) & 0xffn)).join('.');

/**
 * The anonymous rate-limit bucket: the IPv4 address, or the IPv6 /64 written as its network address.
 * One IPv6 customer usually holds a whole /64, so a per-address bucket would give them 2^64 allowances.
 * The /64 is written without a slash because www trusts only `ip:` keys of [A-Za-z0-9.:_-].
 */
export const anonymousBucket = (ip: string | null): string => {
  const address = ip === null ? null : parseAddress(ip);
  if (!address) return 'ip:unknown';
  if (address.version === 4) return `ip:${formatIpv4(address.value)}`;
  const hextets = [112n, 96n, 80n, 64n].map(shift => ((address.value >> shift) & 0xffffn).toString(16));
  return `ip:${hextets.join(':')}::`;
};

/** Parse `address/bits`; null for anything malformed, so a bad entry can never widen a range. */
export const parseCidr = (text: string): Cidr | null => {
  const [base, bitsText, extra] = text.split('/');
  if (extra !== undefined || bitsText === undefined || !/^\d{1,3}$/.test(bitsText)) return null;
  const address = parseAddress(base!);
  // A range is written in its own family: an IPv4-mapped IPv6 network is not accepted as an IPv4 range.
  const written = base!.includes(':') ? 6 : 4;
  if (!address || address.version !== written) return null;
  const bits = Number(bitsText);
  if (bits > WIDTH[address.version]) return null;
  return { version: address.version, network: address.value >> BigInt(WIDTH[address.version] - bits), bits };
};

export const inRanges = (ip: string, ranges: readonly Cidr[]): boolean => {
  const address = parseAddress(ip);
  if (!address) return false;
  return ranges.some(range => range.version === address.version
    && address.value >> BigInt(WIDTH[range.version] - range.bits) === range.network);
};
