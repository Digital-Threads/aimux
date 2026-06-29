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

  /** Transform a profile's base dir (`~/.aimux/profiles/<name>`) into the dir that IS the
   *  CLI's config home. Most CLIs use the base dir as-is (default); gemini needs the
   *  profile dir to be a `.gemini` subdir so `GEMINI_CLI_HOME` can point one level up.
   *  Optional — when absent the base dir is used unchanged. */
  configPathFor?(baseDir: string): string;

  /** Whether the first passthrough arg is a CLI subcommand (suppresses model flags). */
  isSubcommand(firstArg: string | undefined): boolean;

  /** Whether a source-dir entry should be shared (symlinked) into profiles.
   *  claude shares everything except the config's private set (denylist); other CLIs
   *  may share only an allowlist of knowledge dirs. `configPrivate` is `config.private`. */
  isShared(entry: string, configPrivate: Set<string>): boolean;

  /** Whether a profile's REAL (non-symlink) file at a shared entry should be replaced by
   *  the source symlink on sync, instead of being left as a conflict. Use only for
   *  source-authoritative state (codex's session-index DB) — never for user data.
   *  Optional; absent → conflicts are preserved (the safe default). */
  reclaimsFromSource?(entry: string): boolean;

  /** Args to launch the CLI's interactive auth/login flow (claude: `auth login`;
   *  codex: `login`). */
  authArgs(): string[];

  /** File inside the profile dir that proves the profile is authenticated
   *  (claude: `.credentials.json`; codex: `auth.json`). */
  credentialsFile(): string;

  /** Default source-of-truth dir for this CLI, used when registering `shared_sources`
   *  for a freshly added non-claude profile (claude: `~/.claude`; codex: `~/.codex`). */
  defaultSource(): string;

  /** Args to resume an existing session by id (claude: `--resume <id>` [+ `--fork-session`];
   *  codex: `resume <id>`). */
  resumeArgs(sessionId: string, opts?: { fork?: boolean }): string[];

  /** Args for a non-interactive one-shot with a prompt, captured via runProfileHeadless.
   *  claude prints the answer to stdout (`-p <prompt>`); codex's stdout is noisy, so it
   *  writes just the final message to `outFile` (`exec --output-last-message <f> <prompt>`).
   *  Used by the cross-CLI summarizer. */
  headlessArgs(prompt: string, outFile?: string): string[];

  /** True when headless output must be read from `outFile` (codex) rather than stdout
   *  (claude). The summarizer uses this to capture a clean result. */
  headlessCaptureToFile: boolean;

  /** Global flags prepended to a `run` invocation (before the subcommand/model flags).
   *  claude needs none; codex injects `-p aimux` for RUNTIME invocations so the shared
   *  settings/plugins overlay layers on top. `firstArg` is the first passthrough arg,
   *  used to skip non-runtime subcommands (plugin/doctor/login) that reject `-p`. */
  globalArgs(firstArg: string | undefined): string[];

  /** Extra symlinks to create in a profile beyond the shared source entries. Each is
   *  `{ link }` (name inside the profile dir) → `{ target }` (absolute path). codex uses
   *  this for its config overlay (`aimux.config.toml` → source `config.toml`) and plugin
   *  content. `sourceDir` is the CLI's source-of-truth dir. */
  extraLinks(sourceDir: string): Array<{ link: string; target: string }>;
}
