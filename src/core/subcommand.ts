// Heuristic: a bare lowercase token (no leading dash) is a CLI subcommand
// (e.g. `mcp`, `plugin`, `update`) rather than a prompt or flag value.
const SUBCOMMAND_TOKEN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function looksLikeSubcommand(arg: string | undefined): boolean {
  if (!arg) return false;
  if (arg.startsWith('-')) return false;
  return SUBCOMMAND_TOKEN.test(arg);
}
