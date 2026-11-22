// Compressed request bodies（压缩请求体）— gzip in, capped on the way OUT.
//
// WHY THIS EXISTS: web/index.html gzips the /api/save-data body before it leaves the device. A
// handwriting notebook is long, highly repetitive JSON (coordinate arrays), so the win is large
// and it is paid for entirely on the client. The server therefore has to inflate it.
//
// THE SECURITY PROPERTY, STATED FIRST BECAUSE IT IS THE WHOLE REASON THIS IS A MODULE AND NOT
// THREE LINES: inflating attacker-controllable input is exactly where a size cap stops being a
// formality. DEFLATE's ratio is bounded only by the window — ~1000:1 in practice — so a few
// hundred KB that comfortably passes the wire cap expands to hundreds of MB. The cap therefore
// applies to the DECOMPRESSED bytes, and it is enforced DURING inflation: the stream is destroyed
// the moment the running total crosses the limit, so at most one zlib output chunk (~16KB) past
// the cap is ever held. A check made after inflating has already bought the memory it meant to
// refuse — "reject afterwards" is not a mitigation, it is the attack succeeding and then being
// reported.
//
// R3: `content-encoding: gzip` is written in exactly two places — the shell that sets it
// (web/index.html) and GZIP_ENCODING here, which is what lib/webutil.mjs readBody compares.
// R4: this is its own file because lib/webutil.mjs is at its 300-line budget (same reason
// lib/readjson.mjs exists).
import zlib from 'node:zlib';

export const GZIP_ENCODING = 'gzip';
// The two failure strings, matched ONLY by bodyErrorResponse (lib/webutil.mjs) — one string per
// failure, never a prose match.
export const GZIP_BAD = 'malformed gzip body';
export const GZIP_UNSUPPORTED = 'unsupported content-encoding';
// Marks the ONE zlib error that is not a client formatting mistake but a size rejection, so the
// caller can answer the SAME 413 (+ limit) a plain oversize body earns instead of a generic 400.
// A compressed bomb and a big honest notebook are the same refusal to the user.
export const GZIP_OVER_LIMIT_CODE = 'GZIP_OUTPUT_TOO_LARGE';

// null → the body is plain bytes; GZIP_ENCODING → inflate it. Anything else THROWS: quietly
// treating an encoding we do not implement as plain bytes produces a JSON parse error that names
// the wrong problem, and the client would retune its payload instead of its headers (R5).
export function bodyEncoding(req) {
  const raw = String((req && req.headers && req.headers['content-encoding']) || '').trim().toLowerCase();
  if (!raw || raw === 'identity') return null;
  if (raw === GZIP_ENCODING) return GZIP_ENCODING;
  throw new Error(GZIP_UNSUPPORTED);
}

// A gunzip stream that counts what it PRODUCES and destroys itself the instant the running total
// passes `limit`. `onChunk` only ever sees accepted output, so a caller that buffers what it is
// given can never hold more than the cap plus one zlib chunk — the bound does not depend on the
// caller remembering to check.
export function createCappedGunzip(limit, onChunk) {
  let out = 0;
  const gz = zlib.createGunzip();
  gz.on('data', (c) => {
    out += c.length;
    if (out > limit) {
      const e = new Error(GZIP_BAD);
      e.code = GZIP_OVER_LIMIT_CODE;
      gz.destroy(e);                    // ABORT mid-stream: no further chunk is inflated or kept
      return;
    }
    onChunk(c);
  });
  return gz;
}
