# Agent Note: Wide-character token density and flat provider overflow bodies

Status: implemented

English | [中文](2026-11-06-wide-character-token-density-and-flat-provider-overflow.zh.md)

## Problem

A provider rejects a request that exceeds its context window, and the harness must recognize that rejection, condense the conversation, and retry it. Three gaps broke that path.

The token meter priced every character at a quarter of a token. A Chinese transcript therefore measured at a fraction of the provider's own count, so proactive pressure compaction fired long after the provider had passed its real window and the conversation kept growing until the provider refused the request.

The DeepSeek adapter read the provider's error fields only from a wrapped `error` object. A provider or gateway that answers with the same fields flat lost the provider's message and type, so a context-window rejection read as a generic bad request and the recovery path was never reached.

A third gap hid the remaining failures: when recovery could not proceed, the harness preserved the provider's error without saying why.

## Decision

### Wide characters cost one token each

`dsh-token-meter`'s fixed density prices one wide character — CJK ideographs, Japanese kana, Hangul, and fullwidth forms — at one token, and shares one token between four other characters. Measured against MiniMax-M2.7 on its own OpenAI-compatible endpoint, a Chinese transcript of 2,880 characters reported 1,853 prompt tokens: the former density priced it at 754 (0.41 of the provider's count), and the wide-character density prices it at 2,892 (1.56). Code and English samples are unchanged because they contain no wide characters. The rule therefore errs toward over-counting CJK content, which keeps the pressure threshold conservative.

`ctx.tokenMeter` stays model-agnostic: one fold, one estimator, no configuration and no per-model profiles. The client-side fixture that mirrors the composition projection mirrors the same densities, so a fixture's rows agree with the meter's.

### Provider error fields are read from a wrapped or flat body

`dsh-llm-deepseek` reads the provider's error fields from the wrapped `error` object and from a flat body carrying the same fields. A flat context-overflow body is classified as `CONTEXT_WINDOW_EXCEEDED` instead of a generic bad request, so the compaction recovery path is reachable. A body in neither shape keeps the HTTP status as the authority. The pi-ai route recognizes the same rejection from the provider's own message text, which already names the overflow.

### A recovery that cannot proceed says why

`dsh-compaction-basic` logs, at warning level, each reason the context-overflow recovery preserves the original provider error: no routed request target, the attempt budget exhausted, and a compaction that left the surface unchanged. The turn's failure stays the provider's own error; only its visibility changes.

## Testing

Estimator tests pin one token per wide character, one token per four other characters, the mixed densities in one block, the kana, hangul, and fullwidth forms, and the tool-schema and system-message prices. Adapter tests cover a flat context-overflow body through the real HTTP path, asserting both the canonical code and the preserved provider message.

## Alternatives considered

- **Keep one density for every character** — rejected because a CJK transcript then prices at roughly a quarter of its provider-reported size, so pressure compaction fires after the provider has already refused the request. One token per wide character over-counts the same transcript instead, which keeps the threshold conservative.
- **Adopt a per-provider exact tokenizer** — rejected because every consumer's measurement must agree and stay replay-stable, and no deployment ships the tokenizer the meter would need.
- **Read the provider fields only from the wrapped object** — rejected because a gateway that flattens the envelope turns a context-window rejection into an invalid request, and the recovery path is never reached.
- **Report a failed recovery as an error** — rejected because the provider's own error remains the turn's failure; the log line explains it without changing the outcome.

## Consequences

The pressure threshold now means roughly what it says for CJK transcripts: a conversation is condensed when it reaches the configured fraction of the model's window instead of several times later. The estimator over-counts CJK content against MiniMax by roughly half, so a Chinese session condenses earlier than the provider strictly requires; that is the safe direction for a threshold that protects a hard limit.

The cost is that the token meter's numbers are less like a byte-length estimate for CJK text, and a deployment that reports occupancy to a user sees a slightly larger figure than the provider bills. JSON tool schemas keep their own density and still underprice.

The recovery path now logs why it preserved a provider error, which turns a silent failure into a diagnosable one in the host log. Providers and gateways that answer with a flat error body are recognized; providers that use neither shape still fall back to the HTTP status.

The archived [after-call compaction pressure and overflow recovery note](../../archived/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) owns the recovery decision this note extends, and the active [routed model context and compaction policy note](../architecture/2026-07-20-routed-model-context-and-compaction-policy.md) owns the pressure trigger these measurements feed.
