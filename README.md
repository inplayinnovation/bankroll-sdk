# @joinbankroll/sdk

Typed client for **Build on Bankroll** apps — a thin wrapper over the `window.bankroll` bridge the Bankroll app injects, plus server-side verification of the Bankroll session token.

```
npm install @joinbankroll/sdk
```

```ts
import { bankroll } from '@joinbankroll/sdk'

bankroll.status()                    // 'unavailable' | 'update_required' | 'ready' — sync, SSR-safe
await bankroll.session()             // the session token, scoped to your origin
await bankroll.session({ identity: true }) // ...resolving only for a verified real person
await bankroll.pay({ amountCents: 500 })   // charge $5.00 to your payment address
```

```ts
import { verifyToken } from '@joinbankroll/sdk/server'

const session = await verifyToken(token, { audience: 'https://yourapp.example' })
if (!session) return unauthorized()
// session.user.wallet — the user's stable id, and payout target
```

## 📚 [Read the docs →](https://docs.joinbankroll.com/build/overview)

Everything lives there and stays current:
[Quickstart](https://docs.joinbankroll.com/build/quickstart) ·
[The session token](https://docs.joinbankroll.com/build/session) ·
[The manifest](https://docs.joinbankroll.com/build/manifest) ·
[Payments](https://docs.joinbankroll.com/build/payments) ·
[Paying a user](https://docs.joinbankroll.com/build/payouts)

## Package

Two entry points, so server-only code never reaches the browser:

- `@joinbankroll/sdk` — browser client. Zero dependencies, SSR-safe.
- `@joinbankroll/sdk/server` — token verification. Node ≥ 20, uses [jose](https://github.com/panva/jose). Never imports the client.

ESM only. Types are bundled.

## License

MIT
