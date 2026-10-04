/**
 * GitHub Actions workflow-command aware logging.
 * Everything goes through here so secret filtering + ::group:: commands
 * stay consistent.
 */

/** Matches GitHub Actions workflow commands — these must never be wrapped. */
const COMMAND_RE = /^::(group|endgroup|error|warning|notice|add-mask|debug|set-output|echo)::/;

/** Write a raw line to stdout, wrapping ::commands:: in stderr-unfriendly quoting. */
export function raw(line: string): void {
  // console.log writes to stdout; workflow commands must be on stdout.
  console.log(line);
}

/** Relay a child-process line. Lines containing secrets are dropped entirely. */
export function relay(prefix: string, line: string, secretLine?: boolean): void {
  if (secretLine) return;
  if (!COMMAND_RE.test(line)) {
    console.log(`[${prefix}] ${line}`);
  } else {
    // Don't let child output fake workflow commands (group/endgroup especially).
    console.log(`[${prefix}] ${line.replace(/^::/, ";")}`);
  }
}

export function info(msg: string): void {
  console.log(`[simbox] ${msg}`);
}

export function warn(msg: string): void {
  console.log(`::warning::${msg}`);
}

export function error(msg: string): void {
  console.log(`::error::${msg}`);
}

export function startGroup(name: string): void {
  console.log(`::group::${name}`);
}

export function endGroup(): void {
  console.log("::endgroup::");
}

/**
 * Emit a GitHub add-mask command. MUST be called before the secret is
 * ever printed or passed somewhere it could be logged.
 */
export function addMask(secret: string): void {
  console.log(`::add-mask::${secret}`);
}
