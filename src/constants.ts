// Wire constants shared by the client and server halves.
//
// Its own module so that importing one half never drags in the other: the
// client entry re-exports this, and `sdk/next` reads it directly rather than
// importing from the client bundle to get one string.

/** The header the server reads the session token from. */
export const BANKROLL_TOKEN_HEADER = 'x-bankroll-token';
