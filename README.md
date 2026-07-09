# @joinbankroll/sdk

Typed client for **Build on Bankroll** apps — a thin wrapper over the `window.bankroll` bridge the Bankroll app injects, plus server-side verification of the Bankroll identity token.

```
npm install @joinbankroll/sdk
```

Two entry points:

- `@joinbankroll/sdk` — browser client. Zero dependencies, SSR-safe.
- `@joinbankroll/sdk/server` — Node ≥ 20 token verification (uses [jose](https://github.com/panva/jose)). Never imports the client.

## Quickstart

### 1. Detect the host

Your app runs in three places: a plain browser, an outdated Bankroll app, and a current Bankroll host. Branch once:

```ts
import { bankroll } from '@joinbankroll/sdk'

switch (bankroll.status()) {
  case 'unavailable':     /* show "Get the Bankroll app" */ break
  case 'update_required': /* show "Update the Bankroll app" */ break
  case 'ready':           /* identity() and pay() will work */ break
}
```

`status()` is synchronous and safe anywhere, including SSR (always `'unavailable'` on the server).

### 2. Identity

`identity()` resolves a short-lived Bankroll-signed JWT scoped to your origin. The first call may show the user a consent sheet. Tokens are cached and re-minted automatically before expiry; concurrent calls share one mint.

```ts
import { bankroll, withBankrollToken, BANKROLL_TOKEN_HEADER } from '@joinbankroll/sdk'

// simplest: decorate fetch once, use it everywhere
const appFetch = withBankrollToken(fetch)
await appFetch('/api/session', { method: 'POST' })

// or attach manually
const token = await bankroll.identity()
await fetch('/api/session', { headers: { [BANKROLL_TOKEN_HEADER]: token } })
```

`withBankrollToken` sends requests bare when not in a Bankroll host (your server responds 401). Any other failure — including a consent decline — propagates so you can handle it; it is never silently downgraded to a bare request.

### 3. Verify on your server

Never trust claims from the browser. Verify the token server-side — this is the entire route guard:

```ts
import { verifyToken } from '@joinbankroll/sdk/server'
import { BANKROLL_TOKEN_HEADER } from '@joinbankroll/sdk'

const verified = await verifyToken(req.headers.get(BANKROLL_TOKEN_HEADER), {
  audience: 'https://yourapp.example', // your exact origin — see Troubleshooting
})
if (!verified) {
  return Response.json({ error: 'unauthorized' }, { status: 401 })
}
// verified.sub is the user's stable id — bind it to your session:
// store verified.sub itself as your key (do not assume it equals anything else).
```

`verifyToken` checks the RS256 signature against Bankroll's public JWKS, the issuer, and — critically — that the token was minted for **your** origin (`audience`). It accepts `null`/`undefined` and returns `null` on any failure, so one `if (!verified)` covers everything. It throws only on misconfiguration (missing `audience`).

### 4. Payments

```ts
const signature = await bankroll.pay({
  amountCents: 500,               // whole US cents, positive integer
  memo: `order:${orderId}`,       // optional, ≤ 80 chars, cosmetic
  idempotencyKey: `order:${orderId}`, // optional — pass YOUR stable key so the
                                      // host can recognise a retried charge as
                                      // the same one; an SDK UUID is sent when
                                      // omitted
})
```

The recipient is always the `merchantWallet` from your manifest — a `pay()` call cannot name an address. The promise resolves with the settled transaction signature only after on-chain confirmation, and may stay pending for a while when the host shows native sheets (consent, insufficient funds). **Never grant value from a resolved `pay()` alone** — verify the payment server-side (settled, expected amount, your wallet, signature not already redeemed).

## Errors

Everything throws `BankrollError` with a stable snake_case `code`; the original host message is preserved in `message`.

```ts
import { bankroll, BankrollError } from '@joinbankroll/sdk'

try {
  await bankroll.pay({ amountCents: 500 })
} catch (e) {
  if (e instanceof BankrollError) {
    switch (e.code) {
      case 'consent_declined':   return // user said no — the host handled the UX
      case 'insufficient_funds': return // host already showed the add-cash sheet
      default: throw e
    }
  }
  throw e
}
```

| code | thrown by | meaning |
|---|---|---|
| `unavailable` | identity, pay | Not in a Bankroll host (mirrors `status()`) |
| `update_required` | identity, pay | Host too old for this SDK (mirrors `status()`) |
| `consent_declined` | identity, pay | User declined the consent sheet |
| `insufficient_funds` | pay | Balance too low — host already showed add-cash |
| `invalid_amount` | pay | `amountCents` not a positive integer |
| `capability_not_registered` | identity, pay | Capability missing from your manifest |
| `manifest_error` | identity, pay | Your `/.well-known/bankroll.json` is missing or malformed |
| `unknown` | any | Unmapped host reason — original message preserved |

The code union also includes `superseded_consent`, `per_charge_declined`, `blocked_origin`, and `charge_cap_exceeded` — stable names you can switch on today.

## Verified claims

```ts
interface VerifiedToken {
  sub: string          // stable user id — bind to your session, store as-is
  username?: string    // omitted when unset
  geo?: string         // 'US-NY' (ISO 3166-2) or 'US'; omitted when unresolvable
  identity?: { age?: number } | false
  aud: string; iss: string; iat: number; exp: number
}
```

`identity` has three states — **absent** = never verified, **`false`** = verification failed, **object** = approved (`{}` when approved without a date of birth). Gate with `typeof verified.identity === 'object'`; checking mere presence wrongly passes rejected users.

## Recipes

### React: host status without hydration mismatches

The SDK ships no React code by design. This is the entire hook:

```tsx
import { useSyncExternalStore } from 'react'
import { bankroll } from '@joinbankroll/sdk'

const useBankrollStatus = () =>
  useSyncExternalStore(() => () => {}, bankroll.status, () => null)
// null during SSR + first hydration frame — gate on the concrete value
```

### Reading token claims in the browser (display only)

Client-side decoding proves nothing — use it only for display or scoping public reads, never to grant anything:

```ts
const payload = JSON.parse(
  atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
)
// payload.sub, payload.username, …
```

### Share link

```ts
import { playLink } from '@joinbankroll/sdk'

playLink('https://yourapp.example/')
// → https://joinbankroll.com/play?url=https%3A%2F%2Fyourapp.example%2F
```

## Manifest

Your app declares itself at `https://yourorigin/.well-known/bankroll.json`:

```json
{
  "name": "Your App",
  "iconUrl": "https://yourapp.example/icon-256.png",
  "merchantWallet": "…",
  "capabilities": ["identity", "pay"]
}
```

`merchantWallet` is required **even for identity-only apps** — the host validates it before reading `capabilities`. See the Build on Bankroll docs for the full manifest contract.

## Troubleshooting

- **`verifyToken` always returns null / your API 401s in the host** — your `audience` doesn't byte-match the token's `aud`. The `aud` is your origin exactly as the host derives it: `https`, lowercase host, no default port, no trailing slash (e.g. `https://app.example.com`). Decode the token payload and diff.
- **`identity()` throws `unavailable` in your tests** — there's no `window.bankroll` outside the Bankroll app; gate on `bankroll.status()` first.

## License

MIT
