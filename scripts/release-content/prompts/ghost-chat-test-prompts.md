# Ghost Chat direct test prompts

These checks are observations, not pre-recorded passes. Use a disposable workspace and file. Record `PASS`, `FAIL`, `BLOCKED` or `EXPLORATORY`, the visible setting state, editor state and privacy-safe scalar diagnostics. Do not record credentials, endpoint details, source context or suggestion text.

## 1. Provider and default-off boundary

Configure an OpenAI-Compatible provider and add the exact custom model `gpt-4.1`. Open **Settings > Feature Options > Editor** and confirm **Enable Ghost Chat code suggestions** is off before the first test.

In a writable disposable file, type a short incomplete expression, leave one empty caret at the end and wait longer than 750ms.

Expected observation: no Ghost Chat request or suggestion is admitted while the switch is off. If provider activity cannot be distinguished safely, record this check as `BLOCKED` instead of assuming it passed.

## 2. Automatic suggestion after idle

Turn on **Enable Ghost Chat code suggestions**. Type a fresh incomplete expression and stop typing with one empty caret in a writable editor.

Expected observation: automatic admission does not begin until 750ms of idle time has elapsed. A valid response appears as native one-line ghost text at that caret. Provider response time comes after the debounce and can vary, so record admission timing and visible-result timing separately.

## 3. Tab full acceptance

When a Ghost Chat suggestion is visible, note the exact document bytes and then press **Tab** once.

Expected observation: the full visible suggestion is inserted exactly once at the caret. There is no partial acceptance step. The accepted counter increases once and the document contains no duplicate insertion.

## 4. Escape rejection

Create another visible suggestion and press **Escape** before accepting it.

Expected observation: the suggestion disappears, the document bytes do not change and the rejection counter increases once. If the suggestion disappears before Escape can be pressed, record `BLOCKED` for this check.

## 5. Edit and caret cancellation

Start a suggestion request, then perform each action in a fresh attempt before the response is shown:

1. type another character;
2. move the caret;
3. create or change a selection.

Expected observation: each action invalidates the captured snapshot. A stale response is not displayed or inserted. At most one request is active, and a later qualifying edit may start only after its own 750ms idle interval.

## 6. Toggle-off cancellation

Start a request or leave a suggestion visible, then turn off **Enable Ghost Chat code suggestions**.

Expected observation: the active request is cancelled, visible ghost text is hidden and no late result reappears. Keep the switch off for longer than the provider response time to check for a stale display.

## 7. Fixed request profile and result bounds

If the product exposes a privacy-safe request or diagnostics view, inspect one completed Ghost Chat attempt without copying request content.

Expected observation:

- route: `/chat/completions`;
- wire model: `gpt-4.1`;
- reasoning effort: `none`;
- tools and child delegation: absent;
- visible suggestion: one line, no more than 1,000 characters;
- simultaneous active requests: no more than one.

Any `/completions` request is a failure: Ghost Chat is not legacy FIM. Do not infer provider quality or model identity beyond the wire profile from a successful local request.

## 8. No cache or automatic retry

Cancel one request, then create a new qualifying snapshot. If a request fails, leave the editor idle without taking another action.

Expected observation: a new snapshot creates its own request, while the cancelled or failed request is neither replayed from a cache nor retried automatically. Similar suggestion text is not evidence of caching; use only request lifecycle counters when available. If those counters are unavailable, record this check as `BLOCKED`.

## Result record

For each check, record only:

- status: `PASS`, `FAIL`, `BLOCKED` or `EXPLORATORY`;
- toggle state and action performed;
- debounce observation and whether a suggestion became visible;
- accepted, rejected, cancelled, stale-suppressed, error or timeout scalar changes when available;
- whether the disposable document changed.

Do not copy the endpoint, authentication material, source prefix/suffix, response body or raw error into the result record.
