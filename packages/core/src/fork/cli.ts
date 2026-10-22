// Command-line helpers shared by the fork's startup options.

/** Value of `--flag value` or `--flag=value`; '' when the flag has no value; undefined when absent. */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flag) return i + 1 < argv.length ? argv[i + 1] : '';
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** A bad --profile, --tools, cap or limit option. Entry points print the message and exit 1. */
export class ToolsetError extends Error {
  override name = 'ToolsetError';
}
