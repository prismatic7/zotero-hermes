# Live Runtime Debugging (Firefox RDP)

When a plugin feature fails silently and there is no log, probe the user's
_running_ Zotero directly. `Zotero.debug` goes to stdout only, and a
Finder-launched Zotero has no readable log — so RDP is the ground truth.

## Setup

The `mcp-rdp@zotero.org` addon opens a Firefox DevTools server on
`127.0.0.1:6100` (it sets `devtools.debugger.remote-enabled`). Confirm it is
listening before anything else:

```bash
lsof -nP -iTCP:6100 -sTCP:LISTEN     # no output = no server, stop here
```

Zotero's own local server is a different port (`23119`). Do not confuse them.

## Protocol

Raw socket, framed `<decimal-byte-length>:<utf8-json>`:

1. Connect, read the intro packet.
2. `{"to":"root","type":"getRoot"}`
3. `{"to":"root","type":"getProcess","id":0}` — `id` MUST be a number; `0` is
   the parent chrome process.
4. `{"to":<processDescriptor.actor>,"type":"getTarget"}`
5. Use the returned `consoleActor` with
   `{"type":"evaluateJSAsync","text":<js>,"eager":true}`.

**Critical client trap:** the console interleaves `frameUpdate` and `resultID`
ack notifications with results, and each connection gets a fresh actor
namespace. A naive read-one-packet-per-request client mis-pairs replies and
silently returns the PREVIOUS query's answer. Drain stale packets before each
request and correlate strictly on the `resultID` issued for that request. This
trap has already produced a false "the running code is old" conclusion.

## What reads, and what does not

| Read                                     | Over RDP        |
| ---------------------------------------- | --------------- |
| `el.clientWidth` / `clientHeight`        | works           |
| `el.getAttribute(...)`, `el.style.width` | works           |
| `String(typeof X)`                       | works           |
| `el.getComputedStyle(x).<prop>`          | **`undefined`** |
| `el.getBoundingClientRect()` fields      | **`undefined`** |

Multi-statement snippets also return `undefined`. Keep each probe to ONE
expression returning a primitive, and read the value in a separate call — do
not assign to a `window` global and read it back.

## `undefined` is a FAILED PROBE, not a falsy answer

`String(window.__probe)` returning `undefined` when you just set
`window.__probe = 0` means the snippet did not run. Any conclusion drawn from
that is invalid. **Never convert `undefined` into "the thing did not happen"** —
re-probe with a simpler expression or a different read, or report the probe as
unmeasured. Reading a silent `undefined` as a negative result is how a false
"the click did nothing" / "the code is old" conclusion gets manufactured.

## Verify the channel before trusting a probe

Sanity-check arithmetic (`1+1` → `2`) and something stable (`document.title`)
first. If those are wrong, every subsequent answer is suspect.

## Cleaning up

Any probe that creates DOM (a measurement div, a style rule) must remove it and
then _re-read_ to confirm removal. Verify with a second call, not the same
snippet that removed it.

## Known limits

- Dispatching synthetic events (`new MouseEvent('click')` / `KeyboardEvent`)
  over RDP was measured NOT to reach XUL `click` / `keydown` handlers attached in
  the page. Do not conclude from a synthetic dispatch either that the handler is
  broken or that it works — drive the real UI, or read state that the handler
  would have changed.
- `Zotero.getActiveZoteroPane().itemPane` and `ChromeUtils.importESModule(...)`
  results do not serialise; reach for DOM reads instead.
