# Wallet Intelligence Shadow Module

## Status

This is an isolated, read-only analysis library. It is not connected to the Worker scan path, dashboard, KV, or any external wallet-history provider. It must not be treated as a live wallet rating or buy signal.

## What the current implementation can do

- Evaluate a wallet when a caller supplies complete historical metrics: closed-token sample count, win rate, realized PnL, median return, rug/zero-value token exposure, and data coverage.
- Summarize an early-buyer cohort when a caller supplies observed holding states and optional funding/synchronized-buy group identifiers.
- Return `unknown` when required evidence is missing or below the minimum coverage threshold.
- Mark shared funding and synchronized buys as correlation evidence only; neither proves common ownership.

## Current data-source limitation

The existing `/pool-wallet-flow` route uses GeckoTerminal pool-trade samples. Its current response contains aggregate counts and concentration warnings for one pool. It does not provide a wallet's complete cross-token trading history, realized historical PnL, token-by-token win rate, or reliable current token balances.

Therefore, the current scanner cannot honestly populate the historical fields required by `evaluateWalletQuality`. A pool's recent trades must not be presented as a wallet's long-term performance. Nor should "bought but no sell seen in this sample" be labeled as "still holding".

## Data required before live integration

A future adapter must provide, per wallet and chain:

1. A sufficiently complete set of closed token positions with entry/exit amounts and timestamps.
2. Realized PnL calculated with a documented cost-basis method, including fees where available.
3. Win rate and median return from closed positions, with a minimum sample count.
4. A clearly defined rug/near-zero exposure metric.
5. Coverage diagnostics: history start, pages/transactions fetched, known pagination limits, and provider errors.
6. For cohort analysis, current token balances or verified sell events; shared-funder/synchronized-buy evidence must include transaction provenance.

Provider gaps, partial pagination, rate limits, and unsupported chains must yield `unknown`, never a positive score.

## Safety constraints

- No private keys, wallet connection, signing, transactions, or trading actions.
- Do not infer wallet ownership from a shared funding source alone.
- Do not promote a token or wallet to "safe" based on this score.
- Keep this module in shadow mode until provider coverage and historical classifications have been validated against known wallets and failed/scam examples.
- Any future provider integration must be separately reviewed for API cost, rate limits, supported chains, data completeness, and secret handling before deployment.

## CI

The wallet module tests, existing Worker route tests, and dashboard syntax check run as separate jobs. This makes failures attributable: the module can be tested independently without concealing failures in the existing Worker suite.
