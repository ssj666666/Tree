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
  /** Step 4 — voice (Alibaba Bailian / DashScope, domestic ASR -> DeepSeek -> TTS).
      DASHSCOPE_API_KEY empty = voice endpoints report "not configured"; text chat still works. */
  dashscopeKey: opt('DASHSCOPE_API_KEY'),
  /** Step 4 — Bailian workspace ID: the first label of the
      `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` domain (find it in the
      Bailian console under 业务空间， or in the wss URL of your own sample
      code). Empty = fall back to the shared dashscope.aliyuncs.com domain. */
  dashscopeWorkspaceId: process.env.DASHSCOPE_WORKSPACE_ID ?? '',
  /** Step 4 — TTS model + voice, ASR model. Voice longyingtao_v3 is the
      customer-service female voice （温柔淡定女）; longyingmu_v3 is the
      one-line alternative (change TREE_TTS_VOICE only). */
  ttsModel: process.env.TREE_TTS_MODEL ?? 'cosyvoice-v3-flash',
  ttsVoice: process.env.TREE_TTS_VOICE ?? 'longyingtao_v3',
  asrModel: process.env.TREE_ASR_MODEL ?? 'qwen3-asr-flash',
  /** Step 3.1 — "local hands": the workspace the bots may act on. */
  workspace: process.env.TREE_WORKSPACE ?? '/root/tree',
  /** Step 3.2 — headless browser: optional path to a system Chromium binary.
      Empty = use Playwright's bundled Chromium (installed by deploy.sh step 4c). */
  chromiumPath: process.env.TREE_CHROMIUM_PATH ?? '',
  /** Step 3.2 — overall budget for one browse_page call (ms). */
  browseTimeoutMs: Number(process.env.TREE_BROWSE_TIMEOUT_MS ?? 60_000),
  /** Step 3.4 — virtual screens: base X display number. Quinn = base+0,
      Scout = base+1, Forge = base+2, Ledger = base+3, Brief = base+4
      (default base 11, so Quinn :11 … Brief :15). */
  xvfbBaseDisplay: Number(process.env.TREE_XVFB_BASE_DISPLAY ?? 11),
  dbPath: process.env.DB_PATH ?? new URL('../../data/tree.db', import.meta.url).pathname,
};
