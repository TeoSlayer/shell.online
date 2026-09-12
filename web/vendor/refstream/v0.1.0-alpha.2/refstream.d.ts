export interface Disposable {
  dispose(): void;
}

export interface TerminalTheme {
  colorScheme?: "dark" | "light";
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionInactiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface TerminalOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly scrollback?: number;
  readonly convertEol?: boolean;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  theme?: TerminalTheme;
  cursorBlink?: boolean;
  cursorStyle?: "block" | "underline" | "bar";
  cursorInactiveStyle?: "outline" | "block" | "bar" | "underline" | "none";
  disableStdin?: boolean;
  drawBoldTextInBrightColors?: boolean;
  macOptionIsMeta?: boolean;
  scrollOnUserInput?: boolean;
  fontWeight?: string | number;
  fontWeightBold?: string | number;
}

export class Terminal {
  constructor(options?: TerminalOptions);
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly options: TerminalOptions;
  readonly buffer: { readonly active: { readonly type: "normal" | "alternate" } };
  readonly modes: { readonly mouseTrackingMode: string };
  open(element: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  refresh(start: number, end: number): void;
  focus(): void;
  blur(): void;
  dispose(): void;
  scrollLines(lines: number): void;
  hasSelection(): boolean;
  getSelection(): string;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  onData(listener: (data: string) => void): Disposable;
  onBinary(listener: (data: string) => void): Disposable;
  onTitleChange(listener: (title: string) => void): Disposable;
}
