function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** Optional env: empty string when not configured; features using it are skipped. */
function opt(name: string): string {
  return process.env[name] ?? '';
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  /** Tree's model: DeepSeek V4.1 Flash (API id `deepseek-flash`). */
  deepseekKey: req('DEEPSEEK_API_KEY'),
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash',
  /** Optional: Composio (app connections). Empty = app connections disabled, text chat still works. */
  composioKey: opt('COMPOSIO_API_KEY'),
  /** Optional: Orgo cloud computers. Empty = no cloud computer, text chat still works. */
  orgoKey: opt('ORGO_API_KEY'),
  /** Orgo workspace that holds every user's box. */
  orgoWorkspaceId: process.env.ORGO_WORKSPACE_ID ?? '',
  /** Orgo box size for new users. */
  orgoRamGb: Number(process.env.ORGO_RAM_GB ?? 8),
  orgoCpu: Number(process.env.ORGO_CPU ?? 2),
  orgoResolution: process.env.ORGO_RESOLUTION ?? '1280x800x24',
  /** Unused by the current auth flow (dev login only); kept for compatibility, defaults to a dev value. */
  sessionSecret: process.env.SESSION_SECRET ?? 'tree-dev-secret-change-me',
  devLogin: process.env.DEV_LOGIN === '1',
  /** Single-admin login (Tree step 2): username + scrypt hash of the password. */
  adminUser: process.env.TREE_ADMIN_USER ?? 'tree',
  /** Empty = admin login is not configured; POST /api/auth/login reports that. */
  adminPasswordHash: process.env.TREE_ADMIN_PASSWORD_HASH ?? '',
  /** Optional: Bocha web-search API key. Empty = web_search tells the bot search is not configured. */
  bochaKey: opt('BOCHA_API_KEY'),
  dbPath: process.env.DB_PATH ?? new URL('../../data/tree.db', import.meta.url).pathname,
};
