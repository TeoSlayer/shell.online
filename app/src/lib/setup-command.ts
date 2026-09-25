/**
 * The one line that takes a computer from nothing to linked.
 *
 * The installer runs whatever follows `sh -s --` with the executable it just
 * wrote, by full path, so a fresh machine whose install directory is not on
 * PATH yet still gets to `shell auth`. Remote start is deliberately not in
 * it: it grants remote execution authority, so it stays a choice made at the
 * prompt, not one that arrives with a pasted line.
 */
export const SETUP_COMMAND = "curl -fsSL https://shell.online/install | sh -s -- auth";
