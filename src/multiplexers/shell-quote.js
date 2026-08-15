// Serializing an argv vector for a multiplexer that has no exec path.
//
// tmux and zellij both take a real argv vector and exec it, so nothing here
// applies to them. herdr has no such call: `herdr pane run <pane> <words...>`
// joins everything after the pane id with spaces and TYPES the result into the
// pane's interactive shell (upstream src/cli/pane.rs — `args[1..].join(" ")`
// sent as PaneSendInput). Handing it bare argv words therefore hands the
// user's shell an unquoted command line: `codex resume <id> Continue where you
// left off.` becomes thirty arguments, and a `$(...)`, `;` or `|` anywhere in
// a resume message is live shell syntax.
//
// So the caller must do the quoting the shell would otherwise have done.

export class UnquotableArgError extends Error {
  constructor(message, { arg, char } = {}) {
    super(message);
    this.name = 'UnquotableArgError';
    this.arg = arg;
    this.char = char;
  }
}

// Characters that survive no amount of quoting, because they are not text to a
// terminal — they are keystrokes. Quoting protects the SHELL's parse; it has no
// say over what the terminal does with the bytes on the way in.
//   \n, \r  submit the line, splitting the command in half and running it
//   \t      is a completion request (verified against real herdr 0.8.0: a tab
//           inside a quoted argument arrived as nothing at all)
//   \0      cannot be transported through argv at all
const UNTYPEABLE = [
  ['\n', 'a newline'], ['\r', 'a carriage return'],
  ['\t', 'a tab'], ['\0', 'a null byte'],
];

// POSIX single-quoting: everything is literal inside '…', and a literal quote
// is written by closing, escaping, reopening. Correct for sh/bash/zsh/fish.
export function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function untypeableChar(value) {
  return UNTYPEABLE.find(([char]) => value.includes(char));
}

// Build the command line to type, plus any environment it needs.
//
// An argument holding a newline or a tab cannot be typed at all — those are
// keystrokes to a terminal, not characters — but it does not have to be typed.
// The multiplexer can carry it into the pane as an environment variable, and
// the line then references it: the shell expands `"$UNSNOOZE_ARGV_5"` back into
// exactly the original bytes, newlines and all. Verified against real herdr
// 0.8.0: a value containing \n and \t arrives byte-for-byte intact.
//
// This is why `resumeMessage` may be a multi-line paragraph and still reach
// Codex as one argument.
export function shellCommand(file, args = [], { prefix = 'UNSNOOZE_ARGV' } = {}) {
  const env = {};
  const parts = [file, ...args].map(String).map((part, index) => {
    const found = untypeableChar(part);
    if (!found) return shQuote(part);
    // A NUL cannot travel in an environment variable either — execve's
    // environment is NUL-terminated strings — so it is the one thing that has
    // nowhere to go.
    if (part.includes('\0')) {
      throw new UnquotableArgError(
        'cannot pass a null byte to a pane command — it cannot be typed or carried in the environment'
          + ` (in argument ${JSON.stringify(part.slice(0, 60))})`,
        { arg: part, char: '\0' },
      );
    }
    const name = `${prefix}_${index}`;
    env[name] = part;
    // Double-quoted so word splitting and globbing leave the value alone; the
    // variable name is ours, so it needs no quoting of its own.
    return `"$${name}"`;
  });
  return { line: parts.join(' '), env };
}

// The line alone, for callers with no way to deliver environment. Refuses what
// it cannot type, because silently mangling a command is worse.
export function shellLine(file, args = []) {
  const parts = [file, ...args].map(String);
  for (const part of parts) {
    const found = untypeableChar(part);
    if (found) {
      const [char, label] = found;
      throw new UnquotableArgError(
        `cannot type ${label} into a pane — the terminal reads it as a keystroke, not text`
          + ` (in argument ${JSON.stringify(part.slice(0, 60))})`,
        { arg: part, char },
      );
    }
  }
  return parts.map(shQuote).join(' ');
}
