// Conformance test case definitions.
// Each test case specifies input to write to the terminal and what state to capture.
// The generator runs these through @xterm/headless and records the output.

export const testCases = [
  // --- Basic text ---
  {
    name: "plain_ascii",
    cols: 80, rows: 24,
    input: "Hello, World!",
  },
  {
    name: "multiline",
    cols: 80, rows: 24,
    input: "Line 1\r\nLine 2\r\nLine 3",
  },
  {
    name: "tab_stops",
    cols: 80, rows: 24,
    input: "A\tB\tC\tD",
  },
  {
    name: "backspace",
    cols: 80, rows: 24,
    input: "ABCD\b\bXY",
  },
  {
    name: "carriage_return",
    cols: 80, rows: 24,
    input: "ABCDEF\rXY",
  },

  // --- Line wrapping ---
  {
    name: "line_wrap_exact",
    cols: 10, rows: 5,
    input: "1234567890ABCDE",
  },
  {
    name: "line_wrap_long",
    cols: 10, rows: 5,
    input: "12345678901234567890123456789012345",
  },

  // --- Cursor movement ---
  {
    name: "cup_move_to",
    cols: 80, rows: 24,
    input: "\x1b[5;10Hx",
  },
  {
    name: "cup_home",
    cols: 80, rows: 24,
    input: "ABCDEF\x1b[Hx",
  },
  {
    name: "cuu_cud_cuf_cub",
    cols: 80, rows: 24,
    input: "\x1b[10;10H*\x1b[3A^\x1b[3Bv\x1b[3C>\x1b[6D<",
  },
  {
    name: "cursor_clamp_top_left",
    cols: 80, rows: 24,
    input: "\x1b[5;5H\x1b[999A\x1b[999Dx",
  },
  {
    name: "cursor_clamp_bottom_right",
    cols: 80, rows: 24,
    input: "\x1b[999;999Hx",
  },
  {
    name: "cha_column_absolute",
    cols: 80, rows: 24,
    input: "ABCDEFGHIJ\x1b[5Gx",
  },
  {
    name: "vpa_line_absolute",
    cols: 80, rows: 24,
    input: "\x1b[1;1HAAAA\x1b[5dx",
  },
  {
    name: "cnl_cpl",
    cols: 80, rows: 24,
    input: "\x1b[5;10H\x1b[2EA\x1b[2FB",
  },

  // --- Erase ---
  {
    name: "ed_erase_below",
    cols: 20, rows: 5,
    input: "AAAA\r\nBBBB\r\nCCCC\r\nDDDD\r\nEEEE\x1b[3;3H\x1b[0J",
  },
  {
    name: "ed_erase_above",
    cols: 20, rows: 5,
    input: "AAAA\r\nBBBB\r\nCCCC\r\nDDDD\r\nEEEE\x1b[3;3H\x1b[1J",
  },
  {
    name: "ed_erase_all",
    cols: 20, rows: 5,
    input: "AAAA\r\nBBBB\r\nCCCC\x1b[2J",
  },
  {
    name: "el_erase_right",
    cols: 20, rows: 5,
    input: "ABCDEFGHIJ\x1b[1;5H\x1b[0K",
  },
  {
    name: "el_erase_left",
    cols: 20, rows: 5,
    input: "ABCDEFGHIJ\x1b[1;5H\x1b[1K",
  },
  {
    name: "el_erase_entire",
    cols: 20, rows: 5,
    input: "ABCDEFGHIJ\x1b[1;5H\x1b[2K",
  },
  {
    name: "ech_erase_chars",
    cols: 20, rows: 5,
    input: "ABCDEFGHIJ\x1b[1;4H\x1b[3X",
  },

  // --- Insert / Delete ---
  {
    name: "ich_insert_chars",
    cols: 20, rows: 5,
    input: "ABCDEFGHIJ\x1b[1;4H\x1b[3@",
  },
  {
    name: "dch_delete_chars",
    cols: 20, rows: 5,
    input: "ABCDEFGHIJ\x1b[1;4H\x1b[3P",
  },
  {
    name: "il_insert_lines",
    cols: 20, rows: 5,
    input: "AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\x1b[2;1H\x1b[2L",
  },
  {
    name: "dl_delete_lines",
    cols: 20, rows: 5,
    input: "AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\x1b[2;1H\x1b[2M",
  },

  // --- Scroll ---
  {
    name: "su_scroll_up",
    cols: 20, rows: 5,
    input: "AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\x1b[2S",
  },
  {
    name: "sd_scroll_down",
    cols: 20, rows: 5,
    input: "AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\x1b[2T",
  },
  {
    name: "scroll_region",
    cols: 20, rows: 5,
    input: "AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\x1b[2;4r\x1b[2;1H\x1b[1S",
  },

  // --- SGR attributes ---
  {
    name: "sgr_bold",
    cols: 80, rows: 24,
    input: "\x1b[1mBOLD\x1b[0m normal",
  },
  {
    name: "sgr_italic_underline",
    cols: 80, rows: 24,
    input: "\x1b[3;4mitalic+underline\x1b[0m",
  },
  {
    name: "sgr_fg_16",
    cols: 80, rows: 24,
    input: "\x1b[31mred\x1b[32mgreen\x1b[0m",
  },
  {
    name: "sgr_fg_256",
    cols: 80, rows: 24,
    input: "\x1b[38;5;196mcolor196\x1b[0m",
  },
  {
    name: "sgr_fg_rgb",
    cols: 80, rows: 24,
    input: "\x1b[38;2;100;150;200mrgb\x1b[0m",
  },
  {
    name: "sgr_bg_16",
    cols: 80, rows: 24,
    input: "\x1b[41mred_bg\x1b[0m",
  },
  {
    name: "sgr_bg_256",
    cols: 80, rows: 24,
    input: "\x1b[48;5;82mbg82\x1b[0m",
  },
  {
    name: "sgr_bg_rgb",
    cols: 80, rows: 24,
    input: "\x1b[48;2;50;100;150mrgb_bg\x1b[0m",
  },
  {
    name: "sgr_bright_colors",
    cols: 80, rows: 24,
    input: "\x1b[91mbright_red\x1b[102mbright_green_bg\x1b[0m",
  },
  {
    name: "sgr_combined",
    cols: 80, rows: 24,
    input: "\x1b[1;3;4;31;42mfancy\x1b[0m",
  },
  {
    name: "sgr_reset_individual",
    cols: 80, rows: 24,
    input: "\x1b[1;3;4;9mALL\x1b[22mno_bold\x1b[23mno_italic\x1b[24mno_underline\x1b[29mno_strike\x1b[0m",
  },
  {
    name: "sgr_underline_styles",
    cols: 80, rows: 24,
    input: "\x1b[4:1msingle\x1b[4:2mdouble\x1b[4:3mcurly\x1b[4:4mdotted\x1b[4:5mdashed\x1b[0m",
  },

  // --- Cursor save/restore ---
  {
    name: "decsc_decrc",
    cols: 80, rows: 24,
    input: "\x1b[5;10H\x1b7MOVED\x1b[1;1H\x1b8x",
  },

  // --- Alt screen ---
  {
    name: "alt_screen_1049",
    cols: 20, rows: 5,
    input: "NORMAL\x1b[?1049hALT\x1b[?1049l",
  },

  // --- Reverse index ---
  {
    name: "reverse_index",
    cols: 20, rows: 5,
    input: "AAA\r\nBBB\r\nCCC\x1b[1;1H\x1bMx",
  },

  // --- Index (IND) ---
  {
    name: "index_ind",
    cols: 20, rows: 5,
    input: "AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\x1b[5;1H\x1bDx",
  },

  // --- Full reset ---
  {
    name: "full_reset",
    cols: 20, rows: 5,
    input: "HELLO\x1b[1;3;31m\x1bcx",
  },

  // --- Soft reset ---
  {
    name: "soft_reset",
    cols: 20, rows: 5,
    input: "\x1b[2;4r\x1b[?6h\x1b[4h\x1b[!p",
  },

  // --- Scrollback ---
  {
    name: "scrollback",
    cols: 20, rows: 3,
    input: "L1\r\nL2\r\nL3\r\nL4\r\nL5\r\nL6",
  },

  // --- Resize ---
  {
    name: "resize_wider",
    cols: 10, rows: 5,
    input: "1234567890AB",
    resize: { cols: 20, rows: 5 },
  },
  {
    name: "resize_narrower",
    cols: 20, rows: 5,
    input: "12345678901234567890AB",
    resize: { cols: 10, rows: 5 },
  },

  // --- Tab set/clear ---
  {
    name: "tab_set_clear",
    cols: 40, rows: 5,
    input: "\x1b[3g\x1b[5G\x1bH\x1b[15G\x1bH\x1b[1GA\tB\tC",
  },

  // --- Insert mode ---
  {
    name: "insert_mode",
    cols: 20, rows: 5,
    input: "ABCDEF\x1b[1;3H\x1b[4hXY\x1b[4l",
  },

  // --- Origin mode ---
  {
    name: "origin_mode",
    cols: 20, rows: 5,
    input: "AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\x1b[2;4r\x1b[?6h\x1b[1;1Hx",
  },

  // --- DECALN screen alignment ---
  {
    name: "decaln",
    cols: 5, rows: 3,
    input: "\x1b#8",
  },

  // --- Device attributes ---
  {
    name: "da1_response",
    cols: 80, rows: 24,
    input: "\x1b[c",
    captureResponse: true,
  },
  {
    name: "dsr_cursor_position",
    cols: 80, rows: 24,
    input: "\x1b[5;10H\x1b[6n",
    captureResponse: true,
  },

  // --- REP (repeat preceding character) ---
  {
    name: "rep_repeat_char",
    cols: 80, rows: 24,
    input: "A\x1b[5b",
  },

  // --- Charset ---
  {
    name: "dec_special_graphics",
    cols: 20, rows: 5,
    input: "\x1b(0lqqqqk\r\nx    x\r\nmqqqqj\x1b(B",
  },

  // --- CSI ^ scroll down alias ---
  {
    name: "csi_caret_scroll_down",
    cols: 20, rows: 5,
    input: "AAA\r\nBBB\r\nCCC\r\nDDD\r\nEEE\x1b[2^",
  },

  // --- XTVERSION response ---
  {
    name: "xtversion_response",
    cols: 80, rows: 24,
    input: "\x1b[>q",
    captureResponse: true,
  },

  // --- Soft hyphen ignored ---
  {
    name: "soft_hyphen_ignored",
    cols: 80, rows: 24,
    input: "AB\u00ADCD",
  },

  // --- Cursor clamp after resize to fewer rows ---
  {
    name: "cursor_clamp_resize_shrink",
    cols: 20, rows: 10,
    input: "\x1b[9;1H",
    resize: { cols: 20, rows: 3 },
  },
];
