// CashAddr (Bitcoin Cash address format), per the spec at
// https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function polymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c ^ 1n;
}

function prefixData(prefix: string): number[] {
  return [...prefix].map((ch) => ch.charCodeAt(0) & 0x1f).concat([0]);
}

function convertBits(data: Uint8Array | number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('Invalid cashaddr padding');
  }
  return out;
}

const SIZE_CODES: Record<number, number> = { 20: 0, 24: 1, 28: 2, 32: 3, 40: 4, 48: 5, 56: 6, 64: 7 };

export function cashaddrEncode(prefix: string, type: 'p2pkh' | 'p2sh', hash: Uint8Array): string {
  const version = ((type === 'p2pkh' ? 0 : 1) << 3) | SIZE_CODES[hash.length];
  const payload = convertBits(new Uint8Array([version, ...hash]), 8, 5, true);
  const checksumInput = [...prefixData(prefix), ...payload, 0, 0, 0, 0, 0, 0, 0, 0];
  const mod = polymod(checksumInput);
  const checksum: number[] = [];
  for (let i = 0; i < 8; i++) checksum.push(Number((mod >> BigInt(5 * (7 - i))) & 0x1fn));
  return `${prefix}:${[...payload, ...checksum].map((d) => CHARSET[d]).join('')}`;
}

export function cashaddrDecode(addr: string): { prefix: string; type: 'p2pkh' | 'p2sh'; hash: Uint8Array } {
  const lower = addr.toLowerCase();
  if (lower !== addr && addr.toUpperCase() !== addr) throw new Error('Mixed case cashaddr');
  const [prefix, data] = lower.includes(':') ? lower.split(':') : ['bitcoincash', lower];
  const values = [...data].map((c) => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error('Invalid cashaddr character');
    return i;
  });
  if (polymod([...prefixData(prefix), ...values]) !== 0n) throw new Error('Invalid cashaddr checksum');
  const bytes = convertBits(values.slice(0, -8), 5, 8, false);
  const version = bytes[0];
  const hash = new Uint8Array(bytes.slice(1));
  const typeBits = version >> 3;
  if (typeBits !== 0 && typeBits !== 1) throw new Error('Unsupported cashaddr type');
  return { prefix, type: typeBits === 0 ? 'p2pkh' : 'p2sh', hash };
}
