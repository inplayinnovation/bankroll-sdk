---
name: bankroll
description: Build, run, and debug Built for Bankroll apps — real-money web apps that run inside the Bankroll mobile app (joinbankroll.com), with verified identity, geolocation, and HSUSD payments on Solana. Use when the user mentions Bankroll, joinbankroll, HSUSD, @joinbankroll packages, the bankroll CLI or starter, or asks to build or integrate a real-money app on Bankroll. Do not use for generic Solana, wallet, or payment work that does not involve Bankroll.
---

# Bankroll

A Built for Bankroll app is a web app on your own HTTPS origin, opened inside the Bankroll mobile app. The host supplies verified identity (one person, one account, with a verified age), per-session geolocation, payments in HSUSD (a one-dollar stablecoin on Solana), and haptics (`bankroll.haptics({ type })`, decoration that never rejects — see the docs). Charges settle on-chain to the address the app's manifest declares. Settlement is final: there are no chargebacks, and mistakes move real money. That is why this skill is mostly rules.

## The guided setup

When the user asks to set up a Bankroll app — for example, "Set up my Bankroll app" — fetch https://docs.joinbankroll.com/build/agents.md and follow its "What the agent does with that" steps in order. Pause at each gate and wait for the user to say continue. Step 4's QR code must end up scannable **inside your chat reply** — the page says exactly how; never point the user at background-task output, and never send the QR as an image file or attachment, since neither reaches a terminal chat.

## Read before you write code

1. Fetch the docs once: https://docs.joinbankroll.com/llms-full.txt (the full reference, ~110 KB; the index is /llms.txt). If the Bankroll MCP server is connected, `search_bankroll` also works.
2. Inside a scaffolded project, `AGENTS.md` is the authority. Where it and this skill differ, follow `AGENTS.md`.
3. Do not write SDK calls from memory. The SDK is pre-1.0, and minor versions carry breaking changes. Check the installed version, then the changelog page.

## Start a new app

```bash
npm create @joinbankroll/app@latest my-app
cd my-app
npm run dev
```

The scaffolder downloads the starter, writes `.env.local` (`STORE=fs`, the app name, an RPC), installs dependencies, and makes the first commit. There is no signup and no API key.

## Add Bankroll to an existing app

1. `npm install @joinbankroll/sdk`, and add `@joinbankroll/cli` as a devDependency for the dev loop.
2. Serve the manifest at `/.well-known/bankroll.jwt`. On Next.js, `manifestRoute()` from `@joinbankroll/sdk/next` is the whole route. On other stacks, build the two Base64URL segments by hand (see the manifest docs page).
3. Verify the session token on every server route that matters: `requireSession(request)` on Next.js, or `verifyToken(token, { audience })` on any Node server. The audience is your exact origin.
4. Copy the recovery machinery from the starter: `src/lib/charges.ts`, `src/lib/store.ts`, `src/lib/sweep.ts`, and the three `api/charges` routes. It is MIT-licensed and not yet packaged in the SDK. Do not skip it — it is what finds a payment when the page dies before it reports the signature.
5. Next.js dev only: add `allowedDevOrigins: ['*.trycloudflare.com']` to `next.config.ts`.

## Testing without a phone

`@joinbankroll/sdk/mock` is a stand-in host. `mockHostScript({ payee })` returns
JavaScript that defines `window.bankroll` the way the Bankroll app does; hand it
to Playwright's `addInitScript` and the client SDK reports `ready`, `session()`
answers, and `pay()` returns a made-up signature. Set `BANKROLL_MOCK=1` on the
dev server and `getSession` / `confirmCharge` accept that token and those
signatures, so the app's own routes run end to end with no money moving. The
flag is ignored in production builds. The starter's `npm run check -- /app`
does exactly this and fails on any console error, page error, or failed request.

## The dev loop

- `npm run dev` runs `bankroll dev`: it starts the dev server behind a public tunnel and prints a QR code. Scan it, and the app opens inside Bankroll on a phone. The app only fully runs there.
- Run it as a background task and leave it running. Its output — the QR included — is never shown to the user; never point them at it.
- The QR must reach the user **inside your chat reply**: plain monospace glyphs in a fenced code block, the play link as plain text under it. When stdout is not a TTY (any backgrounded run), CLI 0.3+ prints exactly that — re-print it verbatim. Older CLIs print an ANSI QR whose contrast lives in the color codes — unrecoverable as text — so rebuild it: play link = `https://joinbankroll.com/play?url=<URL-encoded tunnel URL>`, QR from the `qrcode-generator` package already in node_modules (`q.createASCII()`; the agents docs page carries the one-liner). Image files and attachments do not render in a terminal chat.
- The tunnel URL changes on every restart. "Can't open this app" almost always means a dead tunnel. Restart, then put the new QR in chat.
- The dev signing key lives at `~/.config/bankroll/keypair.json`. The CLI creates it on first use and injects it into the dev server. It receives payments and signs payouts with real mainnet HSUSD. Fund it with cents, not dollars. Never copy it into the project.
- `npx next dev` (plain localhost) is fine for UI-only work. A browser has no host bridge: `status()` is `'unavailable'`, and token-protected API routes return 401. That is expected, not a bug.

## The CLI

`@joinbankroll/cli` is a project devDependency, not a global install. Discover it; do not recall it:

```bash
npx bankroll --help
npx bankroll treasury                              # the wallet the app runs on
npx bankroll token create --name "Promo Credit"    # play money for testing the loop
```

`token create` writes the mint into `app-tokens.json`, which the manifest serves as `appTokens`.

## Money rules — never break these

1. Every fact about the user comes from the verified session: `wallet`, `username`, `identity`, `geo`, `age`. Never from the request body.
2. The server computes amounts. The client never names a price or a recipient.
3. Before you release value, check all four facts on the confirmed charge: `payee` is your treasury, `mint` is HSUSD or a declared app token, `amountCents` matches the order, `payer` is the session wallet. The `payee` check is the classic miss. The `mint` check is what stops free tokens from buying real value.
4. Record each charge with one atomic create, keyed by the transaction (`sortableId(slot, signature)`). `created: false` means a retry or a replay — return the existing charge; never grant twice.
5. Mint a `reference` and an `idempotencyKey` on the server *before* you call `charge()`, and store them. If the result never comes back, find the charge with `findChargeByReference()`. Never call `charge()` again to learn an outcome.
6. Store the payout's signature BEFORE broadcasting it: `buildAndSignPayout()` → persist bytes + signature + expiry in the same write that locks the payout row → `sendPayout()` → `confirmPayout()`. Signing is deterministic, so the signature exists before any send — once stored, every uncertain outcome is answerable by `confirmPayout(storedSignature)`. Never blind-retry: only `expired` proves the transaction never landed and never can; `send_failed` rejects one submission, not the past.
7. Pay back in the asset that paid. A charge in app tokens pays out app tokens, never HSUSD.

## STOP — ask the user first

- Replacement or rotation of a funded treasury key. A swap of the variable strands the balance; move the funds first.
- Anything that writes a secret key into the project, a log, or a commit.
- Movement of more real money than the task needs. Test the loop with app tokens.

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Can't open this app" on the phone | The tunnel died on restart | Restart `npm run dev`, scan the new QR |
| `update_required` | The Bankroll app is too old (references need client v3+) | Ask the user to update the app; do not charge without a reference |
| 401 from API routes in a browser | No host bridge outside Bankroll | Expected; test on the phone |
| Slow or failed confirmations under load | The public RPC fallback | Set `SOLANA_RPC_URL`; `usingPublicRpc()` reports the state |
| `manifest_error` | The manifest is missing or malformed | `curl <origin>/.well-known/bankroll.jwt`; check `sub` equals the exact origin |

## Before you finish

Run `npm run typecheck && npm run lint && npm test`. Confirm the manifest serves and decodes. Confirm the replay guard: the same signature must not grant value twice.
