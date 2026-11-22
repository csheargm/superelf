// The REAL lines the Claude CLI prints when it cannot sign in, verbatim, for every test that
// drives the watchdog (R3: one copy). Measured 2026-11-10: the stream-json `result` text with a
// wrong CLAUDE_CODE_OAUTH_TOKEN, and the Keychain expiry seen on the node the same day.
export const REAL_401_RESULT = 'Failed to authenticate. API Error: 401 Invalid bearer token';
export const REAL_401_REVOKED = 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.';
