# Ghost Chat code suggestions

Ghost Chat is the retained editor code-suggestion implementation. It is separate from the Chat sidebar, Quick Edit, Agent instructions and the retired legacy FIM autocomplete path.

## Current production availability

In this built production release, **production automatic suggestions are unavailable**. Void Settings omits both **Enable Ghost Chat code suggestions** and **Show suggestions on select**.

An upgraded profile can still contain the prior stored values. A persisted `enableGhostChat: true` does not enable provider debounce, automatic completion requests or visible Ghost Chat suggestions. A persisted `showInlineSuggestions: true` does not mount or show the selection helper widget. The stored fields remain only for compatibility and do not override the production admission boundary.

There is no production workflow for enabling either automatic editor suggestion. Legacy FIM remains retired and does not resume `/completions` requests.

## Unaffected features

This boundary does not disable the Chat sidebar, Quick Edit or Agent mode. Configure and use those features through their existing controls and guides. Selecting text also does not open the retired selection helper, but normal editor selection and the unrelated Chat, Quick Edit and Agent actions remain available.

## Verification boundary

The companion production prompt checks only the absence of both Settings controls and zero automatic suggestion behavior. It does not ask you to enable Ghost Chat, select a Ghost model, wait for a debounce or accept a suggestion. Record only what the built product shows and whether any automatic request or widget appears; do not infer behavior from historical settings values.
