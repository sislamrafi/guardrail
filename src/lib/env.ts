// Settings from the environment. Opsara AI reads OPSARA_* first; the old GUARDRAIL_* names (from when
// the project was called GuardRail) still work, so existing .env files keep running unchanged.
// Explicit names (no dynamic lookup) so the edge middleware can read them too.

export const env = {
  adminPassword: () => process.env.OPSARA_ADMIN_PASSWORD ?? process.env.GUARDRAIL_ADMIN_PASSWORD ?? '',
  adminName: () => process.env.OPSARA_ADMIN_NAME || process.env.GUARDRAIL_ADMIN_NAME || 'Admin',
  secret: () => process.env.OPSARA_SECRET || process.env.GUARDRAIL_SECRET || '',
  keySecret: () => process.env.OPSARA_KEY_SECRET || process.env.GUARDRAIL_KEY_SECRET || '',
  db: () => process.env.OPSARA_DB || process.env.GUARDRAIL_DB || '',
  promptsDir: () => process.env.OPSARA_PROMPTS_DIR || process.env.GUARDRAIL_PROMPTS_DIR || '',
  promptRetentionDays: () => process.env.OPSARA_PROMPT_RETENTION_DAYS || process.env.GUARDRAIL_PROMPT_RETENTION_DAYS || '',
};
