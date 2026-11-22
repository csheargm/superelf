// Minimal dependency-free QR encoder (byte mode, EC level L, versions 1-6,
// fixed mask 0) — enough for the ~120-char health-setup payload (ingest URL +
// member token) with NO external service or CDN, per the privacy rules in
// docs/design/ios-health-ingestion.md. Verified against the OS QR decoder in
// test tooling; qrMatrix() returns null when the text exceeds v6 capacity so
// the caller can fall back to copyable text (never a broken code).
// Spec: ISO/IEC 18004. Kept deliberately small — grow versions only if needed.

// Per version (index 1-6), EC level L: [total codewords, ec codewords/block, blocks].
const VERSIONS = [null, [26, 7, 1], [44, 10, 1], [70, 15, 1], [100, 20, 1], [134, 26, 1], [172, 18, 2]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]]; // alignment centers

// ── GF(256) Reed-Solomon (poly 0x11d) ─────────────────────────────────────────
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= gmul(g[j], EXP[i]); next[j + 1] ^= g[j]; }
    g = next;
  }
  return g.reverse(); // highest-degree first
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const rem = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ rem.shift(); rem.push(0);
    for (let i = 0; i < ecLen; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

// ── Bit assembly: byte mode + terminator + pads, split into blocks, interleave ─
function buildCodewords(bytes, version) {
  const [total, ecPer, blocks] = VERSIONS[version];
  const dataLen = total - ecPer * blocks;
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4); push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataLen * 8 - bits.length));              // terminator
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  for (let p = 0xEC; data.length < dataLen;) { data.push(p); p = p === 0xEC ? 0x11 : 0xEC; }
  const per = Math.floor(dataLen / blocks);                     // v1-6/L blocks are equal-sized
  const dBlocks = [], eBlocks = [];
  for (let b = 0; b < blocks; b++) { const d = data.slice(b * per, (b + 1) * per); dBlocks.push(d); eBlocks.push(rsEncode(d, ecPer)); }
  const out = [];
  for (let i = 0; i < per; i++) for (const d of dBlocks) out.push(d[i]);
  for (let i = 0; i < ecPer; i++) for (const e of eBlocks) out.push(e[i]);
  return out;
}

// ── Matrix ────────────────────────────────────────────────────────────────────
function placeFixed(M, F, size, version) {
  const set = (r, c, v) => { M[r][c] = v; F[r][c] = 1; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { if (!F[6][i]) set(6, i, i % 2 === 0 ? 1 : 0); if (!F[i][6]) set(i, 6, i % 2 === 0 ? 1 : 0); }
  for (const r0 of ALIGN[version]) for (const c0 of ALIGN[version]) {
    if (F[r0][c0]) continue;                                    // skip patterns overlapping finders
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++)
      set(r0 + r, c0 + c, (Math.max(Math.abs(r), Math.abs(c)) !== 1) ? 1 : 0);
  }
  set(size - 8, 8, 1);                                          // fixed dark module
  for (let i = 0; i < 9; i++) { if (!F[8][i]) F[8][i] = 1; if (!F[i][8]) F[i][8] = 1; }   // reserve format areas
  for (let i = 0; i < 8; i++) { F[8][size - 1 - i] = 1; F[size - 1 - i][8] = 1; }
}

// BCH(15,5) format info for (EC level L = 0b01, mask) — computed, not guessed.
function formatBits(mask) {
  const blen = (x) => 32 - Math.clz32(x);
  const data = (0b01 << 3) | mask;
  let d = data << 10;
  while (blen(d) >= 11) d ^= 0x537 << (blen(d) - 11);
  return ((data << 10) | d) ^ 0x5412;
}

// Format-info placement, bit i = LSB of the BCH sequence. Each line writes half
// of ISO 18004's copy-1 AND half of copy-2, merged by bit index (same layout as
// the reference/Nayuki encoder writes per copy): line 1 = column 8 (rows 0-8
// carry copy-1 bits 0-7 skipping the timing row, bottom rows size-7..size-1
// carry copy-2 bits 8-14); line 2 = row 8 (right columns carry copy-2 bits 0-7,
// left columns 7,5..0 carry copy-1 bits 8-14 skipping the timing column).
// An R13 review claimed this index order is reversed — settled EMPIRICALLY in
// test/qr.test.mjs: the OS decoder (CIDetector) round-trips v1/v5/v6 exactly,
// and the reversed-order variant does not decode at all.
function placeFormat(M, size, mask) {
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const v = (bits >> i) & 1;
    if (i < 6) M[i][8] = v; else if (i < 8) M[i + 1][8] = v; else M[size - 15 + i][8] = v;
    if (i < 8) M[8][size - i - 1] = v; else if (i < 9) M[8][15 - i] = v; else M[8][15 - i - 1] = v;
  }
}

function placeData(M, F, size, codewords) {
  let bit = 7, idx = 0, up = true;
  const next = () => { const v = idx < codewords.length ? (codewords[idx] >> bit) & 1 : 0; if (--bit < 0) { bit = 7; idx++; } return v; };
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                                       // timing column is skipped whole
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (F[row][c]) continue;
        const v = next();
        M[row][c] = ((row + c) % 2 === 0) ? v ^ 1 : v;          // mask 0
      }
    }
    up = !up;
  }
}

// Encode UTF-8 text → { size, rows: Uint8Array[] } (1 = dark), or null if the
// text does not fit version 6 / EC L (caller falls back to copyable text).
export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let version = 0;
  for (let v = 1; v < VERSIONS.length; v++) {
    const [total, ecPer, blocks] = VERSIONS[v];
    if (bytes.length + 2 <= total - ecPer * blocks) { version = v; break; }  // +2 = mode + length overhead
  }
  if (!version) return null;
  const size = 17 + 4 * version;
  const M = Array.from({ length: size }, () => new Uint8Array(size));
  const F = Array.from({ length: size }, () => new Uint8Array(size));
  placeFixed(M, F, size, version);
  placeData(M, F, size, buildCodewords(bytes, version));
  placeFormat(M, size, 0);
  return { size, rows: M };
}
