# Ghost Chat code suggestions

Ghost Chat shows a bounded code suggestion as native editor ghost text. It is separate from the Chat sidebar, Quick Edit, Agent instructions and the retired legacy FIM autocomplete path. The feature is off by default.

## Configure the provider and model

1. Open Void Settings and configure an OpenAI-Compatible endpoint supplied by your service.
2. Add a custom model whose exact name is `gpt-4.1` under that provider.
3. Verify that the provider is available before enabling editor suggestions.

Ghost Chat uses that configured OpenAI-Compatible endpoint but has a fixed request-local profile: `/chat/completions`, wire model `gpt-4.1`, reasoning effort `none` and no tools. It does not inherit the selected Chat model, Chat reasoning control, AGENTS content, Skills or child delegation. Do not expect another model alias to substitute for `gpt-4.1`.

## Enable automatic suggestions

Open **Settings > Feature Options > Editor** and turn on **Enable Ghost Chat code suggestions**. The stored default is off. Turning the switch off again cancels the current request and hides a visible Ghost Chat suggestion.

With the switch on, pause at one empty caret in a writable editor. A qualifying edit waits for 750ms of idle time before automatic admission. The 750ms value is the configured debounce, not a promise about provider response time or total suggestion latency.

Only one Ghost Chat request can be active. A newer qualifying edit supersedes the earlier snapshot rather than starting parallel work. The request is cancelled or its result is discarded when the document, caret, selection or active editor no longer matches the captured snapshot. Making another edit, moving the caret, changing the selection, turning the feature off or closing the relevant editor therefore prevents stale insertion.

## Accept or reject

- Press **Tab** while the native suggestion is visible to accept the full suggestion once.
- Press **Escape** to reject and hide the visible suggestion without changing the document.
- Any accepted result is plain insertion at the captured caret, limited to one line and at most 1,000 characters.

There is no partial acceptance, response cache, automatic retry or simultaneous second request. An empty, multiline, oversized or otherwise invalid result is not shown. Freeing an editor completion without an explicit rejection is not counted as a rejection.

Ghost Chat never re-enables legacy FIM and never sends the retired `/completions` request. The fixed Chat Completions profile is the only supported Ghost Chat route in this release.

## Diagnostics and verification boundary

Ghost Chat keeps only a bounded recent lifecycle view and scalar counters such as requested, shown, accepted, rejected, cancelled, timed out and first-suggestion timing when available. It does not retain the source prefix, suffix, suggestion body or raw provider error in that view.

The source and focused fixtures verify default-off admission, the 750ms gate, max-one supersession, stale-result rejection, full-accept accounting and bounded validation. In two actual-product core observations on the current source, toggle-off produced zero requests; after toggle-on, physical typing admitted a request about 815ms and 824ms after the last edit, used the exact wire profile, showed native ghost text, inserted once with Tab and returned to the original document with Undo. Those two timings are observations, not a latency guarantee.

Actual-product follow-on checks for max-one overlap and toggle-off cancellation have not yet been completed; only their source-focused tests currently pass. Provider quality, broader network latency and environment-specific behavior must not be inferred from the core observations or fixtures. Use the companion test prompts in a disposable file and record only the observed UI state and privacy-safe scalar results.
