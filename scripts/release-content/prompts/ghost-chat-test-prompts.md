# Ghost Chat production availability checks

These checks verify absence and zero automatic behavior in a built production release. Use a disposable workspace and file. Record `PASS`, `FAIL` or `BLOCKED`; do not record credentials, endpoint details, source context or response content.

## 1. Settings controls are absent

Open **Settings > Feature Options > Editor** and search the Settings UI for the exact labels **Enable Ghost Chat code suggestions** and **Show suggestions on select**.

Expected observation: neither control is rendered. Do not add or edit a setting to try to enable either feature.

## 2. Prior persisted values are ignored

If this profile was upgraded from a version that had either control enabled, keep the existing profile unchanged and restart the built production application.

Expected observation: the two controls remain absent. A prior persisted `true` does not restore either automatic feature.

## 3. Ghost automatic behavior stays at zero

In a writable disposable file, type ordinary code, pause, move the caret and continue editing.

Expected observation: no automatic Ghost request is sent, no Ghost-specific debounce delays another inline provider, and no Ghost Chat suggestion is shown. If request activity cannot be distinguished safely, record `BLOCKED` instead of assuming zero.

## 4. Selection helper stays absent

Select several characters and several lines in the disposable file, then scroll and move focus away from and back to the editor.

Expected observation: no Void selection helper overlay or widget is mounted, shown or rerendered.

## 5. Unaffected product surfaces

Open the Chat sidebar, invoke Quick Edit on disposable text and open Agent mode without making an important workspace change.

Expected observation: those existing surfaces remain available. Their provider success is a separate check; this prompt verifies only that the production automatic-suggestion boundary did not remove them.

## Result record

For each check record only:

- status: `PASS`, `FAIL` or `BLOCKED`;
- whether each exact Settings label was absent;
- whether automatic request, Ghost suggestion or selection helper UI appeared;
- whether Chat, Quick Edit and Agent entry points remained available.

The expected release contract is: **production automatic suggestions are unavailable**.
