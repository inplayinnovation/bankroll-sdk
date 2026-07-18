# @joinbankroll/sdk

Typed client for **Build on Bankroll** apps — a thin wrapper over the `window.bankroll` bridge the Bankroll app injects, plus the server half: session-token verification, charge confirmation, and payouts.

```
npm install @joinbankroll/sdk
```

```ts
import { bankroll } from '@joinbankroll/sdk'

bankroll.status()                    // 'unavailable' | 'update_required' | 'ready' — sync, SSR-safe
await bankroll.session()             // the session token, scoped to your origin
await bankroll.session({ identity: true }) // ...resolving only for a verified real person
await bankroll.charge({ amountCents: 500 })  // charge $5.00 to your payment address
```

```ts
import { verifyToken, confirmCharge, pay } from '@joinbankroll/sdk/server'

const session = await verifyToken(token, { audience: 'https://yourapp.example' })
if (!session) return unauthorized()
// session.user.wallet — the user's stable id, and payout target

// env: SOLANA_RPC_URL — confirm a settled charge() before releasing value
const charge = await confirmCharge(signature)
// { payer, payee, amountCents, memo } — check payee is your payment address,
// amountCents matches the order, payer is session.user.wallet; store the signature.

// env: BANKROLL_TREASURY_KEY — pay a user from your treasury (winnings, refunds)
const { signature: payout } = await pay({ to: session.user.wallet, amountCents: 2500 })
```

```ts
// Privy server wallet instead of an env key? Drop-in signer, sponsorship included:
import { privySigner } from '@joinbankroll/sdk/privy' // needs @privy-io/node (optional peer)

const signer = await privySigner({ idempotencyKey: `payout-${orderId}` })
await pay({ to: session.user.wallet, amountCents: 2500 }, { signer })
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

- `@joinbankroll/sdk` — browser client. No runtime imports — nothing of the server half's dependencies reaches the browser bundle. SSR-safe.
- `@joinbankroll/sdk/server` — token verification, charge confirmation, payouts. Node ≥ 20; depends on [jose](https://github.com/panva/jose) plus exact-pinned `@solana/web3.js` + `@solana/spl-token` (no version ranges on the money path). Never imports the client.
- `@joinbankroll/sdk/privy` — drop-in payout signer for Privy server wallets. Requires `@privy-io/node` (optional peer — only installed if you use this entry).

ESM only. Types are bundled.

**0.3.0 rename:** `bankroll.pay()` is now `bankroll.charge()` — same behavior, same signature. The server entry adds `confirmCharge` and `pay` (payouts).

**0.4.0:** the payout lifecycle — `buildPayout` / `sendPayout` / `confirmPayout`, with `pay()` as their composition. Build returns the exact transaction bytes + `lastValidBlockHeight` so record-before-broadcast apps can persist both between steps; `confirmPayout` doubles as the reconciliation primitive for stuck payouts.

## License

MIT
