// Kept free of runtime dependencies (no zod) so renderer bundles can import it.

/** WebSocket close code sent to a publisher superseded by a newer one; it must not reconnect. */
export const PUBLISHER_REPLACED_CLOSE_CODE = 4001;
