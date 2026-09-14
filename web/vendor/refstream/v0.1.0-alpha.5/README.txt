Refstream.js 0.1.0-alpha.5

Standalone browser JavaScript and CSS. Serve this folder over HTTP(S).
Keep the chunks/ directory next to the JavaScript files.

Import Terminal from refstream.js and load refstream.css. Optional controls
come from ui.js with ui.css. Classic script users can load refstream.global.js
and create new Refstream.Terminal(options).

No framework, installer, Node.js, or build step is needed by browser consumers.
The optional agent connector uses Node.js 22+ and an explicit private invitation.
See docs/agents.md for persistent handoffs and host-reported composer/lifecycle
state. Unintegrated terminal applications report unknown rather than guessed
editor state. Never send composer values or raw hook payloads as status reports.

Source: https://github.com/TeoSlayer/refstream.js/tree/131a71335f05344f3018c43a76ffbe7376493a34
Release: https://github.com/TeoSlayer/refstream.js/releases/tag/v0.1.0-alpha.5
License: MIT (see LICENSE)
