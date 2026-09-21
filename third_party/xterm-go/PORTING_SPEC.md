# xterm.js → Go Porting Specification

This document is the reference for porting the headless xterm.js terminal emulator to Go.

**Source:** https://github.com/xtermjs/xterm.js (MIT license)
**Target:** This repository (`github.com/gitpod-io/xterm-go`)


## Goal

A pure-Go headless terminal emulator that processes VT/ANSI escape sequences and maintains buffer state. No rendering, no DOM, no browser APIs. Stdlib-only dependencies (no third-party packages).

## Architecture Overview

```
Terminal (public API)
  └── coreTerminal (internal orchestration)
        ├── inputHandler (sequence → buffer ops)
        │     └── parser (EscapeSequenceParser)
        │           ├── oscParser
        │           ├── dcsParser
        │           └── apcParser
        ├── bufferService
        │     └── bufferSet (normal + alt)
        │           └── buffer
        │                 ├── CircularList[*BufferLine]
        │                 └── markers
        ├── coreService (data events)
        ├── optionsService
        ├── charsetService
        ├── unicodeService
        └── oscLinkService
```

## Porting Rules

### General
1. **Port behavior, not syntax.** Translate TypeScript idioms to idiomatic Go.
2. **No dependency injection framework.** xterm.js uses `InstantiationService` — replace with plain struct composition and constructor injection.
3. **No `interface{}`.** Use concrete types or generics.
4. **Unexported by default.** Only export the public Terminal API. Internal types are unexported.
5. **Single package.** Everything lives in `package xterm` at the repository root.
6. **Tests required.** Every file `foo.go` must have `foo_test.go`. Use table-driven tests with `cmp.Diff`.

### Type Mapping

| TypeScript | Go |
|---|---|
| `interface` | Go `interface` (only when needed for polymorphism) |
| `class` | `struct` with methods |
| `enum` (const enum) | `const` block with `iota` or explicit values |
| `Uint16Array` / `Uint32Array` / `Int32Array` | `[]uint16` / `[]uint32` / `[]int32` |
| `number` (integer context) | `int32` or `uint32` (match xterm.js bit widths) |
| `string` | `string` or `[]rune` depending on context |
| `Emitter<T>` / `IEvent<T>` | `EventEmitter[T]` (callback-based, see below) |
| `IDisposable` | `Disposable` interface with `Dispose()` |
| `Promise<T>` | Drop async support — Go port is synchronous |

### Event System

xterm.js uses `Emitter<T>` with `.event` property returning `IEvent<T>`. Port as:

```go
// EventEmitter is a synchronous event emitter.
type EventEmitter[T any] struct {
    listeners []func(T)
}

func (e *EventEmitter[T]) Fire(value T) { ... }
func (e *EventEmitter[T]) Event(listener func(T)) Disposable { ... }
```

### Bit Layout Preservation

The attribute bit layouts MUST match xterm.js exactly. This ensures compatibility if we ever need to exchange buffer state.

**fg (uint32):**
- bits 0-7: blue (RGB) or palette index
- bits 8-15: green (RGB)
- bits 16-23: red (RGB)
- bits 24-25: color mode (0=default, 1=P16, 2=P256, 3=RGB)
- bit 26: INVERSE
- bit 27: BOLD
- bit 28: UNDERLINE
- bit 29: BLINK
- bit 30: INVISIBLE
- bit 31: STRIKETHROUGH

**bg (uint32):**
- bits 0-25: same color layout as fg
- bit 26: ITALIC
- bit 27: DIM
- bit 28: HAS_EXTENDED
- bit 29: PROTECTED
- bit 30: OVERLINE

**content (uint32):**
- bits 0-20: codepoint (max 0x10FFFF)
- bit 21: IS_COMBINED (cell has combined string data)
- bits 22-23: wcwidth (0-2)

### Parser State Machine

The parser is a table-driven VT500 state machine. The transition table is a `[]uint16` of 4095 entries:
- Index: `state << 8 | charCode`
- Value: `action << 8 | nextState`

15 states, 18 actions. Port the `VT500_TRANSITION_TABLE` initialization exactly.

### CircularList

Generic circular buffer used for scrollback:

```go
type CircularList[T any] struct {
    array    []T
    length   int
    maxLen   int
    startIdx int
    // events for insert/delete/trim
}
```

### BufferLine Cell Storage

Each cell is stored as 3 values in parallel slices:
- `content []uint32` — codepoint + width + combined flag
- `fg []uint32` — foreground color + text attributes
- `bg []uint32` — background color + flags

Combined characters (emoji, accented chars) store their string in a side map.

## File Mapping

| xterm.js Source | Go Target | Phase |
|---|---|---|
| `src/common/Types.ts` | `types.go` | 1 |
| `src/common/buffer/Constants.ts` | `constants.go` | 1 |
| `src/common/parser/Constants.ts` | `constants.go` | 1 |
| `src/common/CircularList.ts` | `circularlist.go` | 1 |
| `src/common/Event.ts` | `event.go` | 1 |
| `src/common/Lifecycle.ts` | `lifecycle.go` | 1 |
| `src/common/buffer/AttributeData.ts` | `attributedata.go` | 1 |
| `src/common/buffer/CellData.ts` | `celldata.go` | 1 |
| `src/common/parser/EscapeSequenceParser.ts` | `parser.go` | 2 |
| `src/common/parser/Params.ts` | `parser_params.go` | 2 |
| `src/common/parser/OscParser.ts` | `parser_osc.go` | 2 |
| `src/common/parser/DcsParser.ts` | `parser_dcs.go` | 2 |
| `src/common/parser/ApcParser.ts` | `parser_apc.go` | 2 |
| `src/common/buffer/BufferLine.ts` | `bufferline.go` | 3 |
| `src/common/buffer/Buffer.ts` | `buffer.go` | 3 |
| `src/common/buffer/BufferSet.ts` | `bufferset.go` | 3 |
| `src/common/buffer/Marker.ts` | `marker.go` | 3 |
| `src/common/buffer/BufferReflow.ts` | `bufferreflow.go` | 3 |
| `src/common/services/OptionsService.ts` | `options.go` | 4 |
| `src/common/services/BufferService.ts` | `bufferservice.go` | 4 |
| `src/common/services/CoreService.ts` | `coreservice.go` | 4 |
| `src/common/services/CharsetService.ts` | `charset.go` | 4 |
| `src/common/services/UnicodeService.ts` | `unicode.go` | 4 |
| `src/common/services/MouseStateService.ts` | `mousestate.go` | 4 |
| `src/common/services/OscLinkService.ts` | `osclink.go` | 4 |
| `src/common/data/Charsets.ts` | `charset.go` | 4 |
| `src/common/InputHandler.ts` | `inputhandler.go` + `inputhandler_*.go` | 5 |
| `src/common/input/WriteBuffer.ts` | `writebuffer.go` | 5 |
| `src/common/input/TextDecoder.ts` | `textdecoder.go` | 5 |
| `src/headless/Terminal.ts` | `terminal.go` | 6 |
| `src/common/CoreTerminal.ts` | `terminal.go` | 6 |

## Subagent Instructions

Each subagent works on one phase. The subagent should:

1. Clone the xterm.js repo (or read source files via GitHub raw URLs)
2. Read the relevant TypeScript source files listed in the phase's Linear issue
3. Create the Go files at the repository root
4. Write tests for each file
5. Run `go test ./...` to verify
6. Run `gofmt` on all files
7. Commit and push to a feature branch
8. Create a PR

### Reading xterm.js source
Use raw GitHub URLs:
```
https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/common/<path>
```

### Key xterm.js files to read for context (all phases)
- `src/common/Types.ts` — all interfaces
- `src/common/buffer/Types.ts` — buffer interfaces
- `src/common/parser/Types.ts` — parser interfaces
- `src/common/buffer/Constants.ts` — bit layout constants
- `src/common/parser/Constants.ts` — parser state/action enums

## Phase Dependencies

```
Phase 1 (types/constants) ──┬──→ Phase 2 (parser)
                             ├──→ Phase 3 (buffer)
                             └──→ Phase 4 (services) ──→ Phase 5 (input handler) ──→ Phase 6 (terminal)
                                       ↑                        ↑
                                  Phase 3 ───────────────────────┘
                                  Phase 2 ───────────────────────┘
```

Phases 2 and 3 can run in parallel after Phase 1.
Phase 4 depends on Phase 1 and Phase 3.
Phase 5 depends on Phases 2, 3, and 4.
Phase 6 depends on all previous phases.
