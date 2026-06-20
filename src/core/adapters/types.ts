/** Per-CLI driver. On PR1 it covers only the run-path (flags + config-dir env).
 *  Sharing and session concerns are added in later PRs when a second CLI needs them. */
export interface CliAdapter {
  /** Stable identifier of the adapter family. */
  id: string;

  /** Build the model-selection args for a launch. Mirrors how the CLI takes a model. */
  modelArgs(opts: {
    model?: string;
    fallbackModel?: string;
    isSubcommand: boolean;
    userPassedModel: boolean;
    userPassedFallback: boolean;
  }): string[];

  /** Env that points the CLI at an isolated config dir. Empty for the source profile. */
  configDirEnv(profilePath: string, isSource: boolean): Record<string, string>;

  /** Whether the first passthrough arg is a CLI subcommand (suppresses model flags). */
  isSubcommand(firstArg: string | undefined): boolean;
}
