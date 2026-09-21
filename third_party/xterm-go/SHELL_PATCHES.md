# Local xterm-go compatibility patch

Source: https://github.com/gitpod-io/xterm-go
Revision: dae5128cb6b3 (v0.0.0-20260907130418-dae5128cb6b3).
Upstream license and tests are retained.

`buffer.go`: clamp MaxBufferSize to the native int range, reserving one value
for limit+1. The upstream 2^32-1 constant fails compilation on shell.online's
supported 32-bit Linux targets. The host uses only 100 scrollback lines.

`terminal.go`: expose read-only CharsetState, alongside the existing Buffer
state, so a snapshot preserves DEC line-drawing character sets for subsequent
output. Upstream's serializer preserves cells but omits active G-set state.

`inputhandler_osc.go`: explicitly check 0..255 before channel conversions.
This preserves valid parsed colours and avoids relying solely on upstream
regex/substring length constraints for integer-conversion safety.

Remove this local replacement once an upstream release includes a portable
bound and passes the Go/xterm.js snapshot comparison and release target builds.
