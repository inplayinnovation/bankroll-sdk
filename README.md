# @joinbankroll/sdk

Typed client for **Build on Bankroll** apps — a thin wrapper over the `window.bankroll` bridge the Bankroll app injects, plus server helpers for session-token verification, payments, app authentication, notifications, and matchmaking.

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

// env: SOLANA_RPC_URL (optional; falls back to the rate-limited public endpoint)
// confirm a settled charge() before releasing value
const charge = await confirmCharge(signature)
// { payer, payee, amountCents, memo } — check payee is your payment address,
// amountCents matches the order, payer is session.user.wallet; store the signature.

// env: BANKROLL_TREASURY_KEY — pay a user from your treasury (winnings, refunds)
const { signature: payout } = await pay({ to: session.user.wallet, amountCents: 2500 })

// keeping a payout row? Know the signature BEFORE anything is broadcast:
const signed = await buildAndSignPayout({ to: session.user.wallet, amountCents: 2500 })
// persist signed.{transaction,signature,lastValidBlockHeight} in the write that
// locks the row, then:
await sendPayout(signed.transaction)
await confirmPayout(signed.signature, { lastValidBlockHeight: signed.lastValidBlockHeight })
```

```ts
// Privy server wallet instead of an env key? Drop-in signer, sponsorship included:
import { privySigner } from '@joinbankroll/sdk/privy' // needs @privy-io/node (optional peer)

const signer = await privySigner({ idempotencyKey: `payout-${orderId}` })
await pay({ to: session.user.wallet, amountCents: 2500 }, { signer })

// A sponsoring signer can't know the signature before the send — store a
// reference with the row instead, and find the landed payout by it:
const reference = createReference()
const built = await buildPayout({ to: session.user.wallet, amountCents: 2500, reference }, { signer })
// persist reference + built.transaction, sendPayout, and on a stuck row:
const found = await findPayoutByReference(reference) // { signature, slot, failed } | null
```

```ts
// Several recipients in ONE transaction — a winner and the creator's cut —
// each its own transfer, all landing or none:
await pay({
  recipients: [{ to: winner, amountCents: 160 }, { to: creator, amountCents: 40 }],
  memo: `game:${gameId}`,
}, { signer })
```

```ts
// A Bankroll server wallet (in-app builder apps, or provisioned by Bankroll)?
// Explicit: pass the signer where you pay. It defaults its inputs from the
// four env lines provisioning printed — BANKROLL_PAYEE, BANKROLL_DELEGATED_KEY,
// BANKROLL_DELEGATED_WALLET_ID, BANKROLL_PRIVY_APP_ID — and advertise
// BANKROLL_PAYEE as your manifest's payment address. The app signs each payout
// request with its own key; Bankroll's relay adds Privy's credentials and
// Privy's enclave enforces the wallet's policy, sponsors and broadcasts. It
// signs at send time, so keep a reference, as above.
import { delegatedPrivySigner } from '@joinbankroll/sdk/server'
const signer = delegatedPrivySigner({ idempotencyKey: `payout-${orderId}` })
await pay({ to: session.user.wallet, amountCents: 2500 }, { signer })
```

## 📚 [Read the docs →](https://docs.joinbankroll.com/build/overview)

Everything lives there and stays current:
[Quickstart](https://docs.joinbankroll.com/build/quickstart) ·
[The session token](https://docs.joinbankroll.com/build/session) ·
[The manifest](https://docs.joinbankroll.com/build/manifest) ·
[Getting verified](https://docs.joinbankroll.com/build/verified) ·
[App authentication](https://docs.joinbankroll.com/build/app-authentication) ·
[Payments](https://docs.joinbankroll.com/build/payments) ·
[Paying a user](https://docs.joinbankroll.com/build/payouts) ·
[App tokens](https://docs.joinbankroll.com/build/app-tokens) ·
[Balances and deposits](https://docs.joinbankroll.com/build/balances) ·
[Notifications](https://docs.joinbankroll.com/build/push) ·
[Matchmaking](https://docs.joinbankroll.com/build/matchmaking)

Helpers: [Next.js](https://docs.joinbankroll.com/build/next) ·
[The store](https://docs.joinbankroll.com/build/store) ·
[React](https://docs.joinbankroll.com/build/react)

**[Changelog →](https://docs.joinbankroll.com/build/changelog)** — what landed in
which version, and every breaking change.

## Package

The split is load-bearing: server-only code never reaches the browser, and every
optional entry brings its own peer so you install only what you use.

| Entry | What it is |
|---|---|
| `@joinbankroll/sdk` | Browser client. No runtime imports — none of the server half's dependencies reach the browser bundle. SSR-safe. |
| `@joinbankroll/sdk/server` | Token verification, charge confirmation, payouts, treasury, app public key, and notifications. Node ≥ 20; depends on [jose](https://github.com/panva/jose) plus exact-pinned `@solana/web3.js` (no version ranges on the money path). Never imports the client. |
| `@joinbankroll/sdk/matchmaking` | Server client for verified apps: `createTicket`, `listTickets`, `cancelTicket`. Recoverable entries, final head-to-head matches, atomic cancellation. |
| `@joinbankroll/sdk/next` | Server helpers for Next: `getOrigin`, `getSession` / `requireSession`, `requireIdentity`, `manifestRoute`. Server-only — importing it from a client bundle throws. Peer: `next >= 15`. |
| `@joinbankroll/sdk/store` | Durable JSON with an atomic create and compare-and-swap. `./store` is pure interface; `./store/fs` imports only Node builtins; `./store/vercel` is the only module touching `@vercel/blob` (peer, `>= 2.3.0`). |
| `@joinbankroll/sdk/react` | `useBankrollStatus` / `useBankrollChecked`, `bankrollFetch`, `verifyIdentity`, and a development overlay. Peer: `react >= 18`. |
| `@joinbankroll/sdk/privy` | Drop-in payout signer for Privy server wallets. Peer: `@privy-io/node`. |
| `@joinbankroll/sdk/mock` | A stand-in host for tests: `mockHostScript()` defines `window.bankroll` in a headless browser, and with `BANKROLL_MOCK=1` outside production `getSession` and `confirmCharge` accept its token and signatures, and `mockPayoutSigner()` pays out with signatures `confirmPayout` accepts. A production build never reads the flag. |

Every peer is optional. ESM only. Types are bundled.

## License

MIT
