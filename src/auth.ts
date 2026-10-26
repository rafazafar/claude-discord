import type { Store } from './db.js';

/**
 * Credential switching between an Anthropic API key and a Claude plan OAuth token.
 *
 * - api_key:     ANTHROPIC_API_KEY. Pay-as-you-go, or your Max/Team monthly API
 *                credits when the key belongs to the Console org linked to your plan.
 * - oauth_token: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`). Draws on the
 *                plan's own usage limits, not the monthly API credits.
 *
 * The agent process is only ever given ONE credential, so which pool pays is unambiguous
 * (Claude Code would otherwise prefer the API key when both are present).
 */

export type AuthMode = 'api_key' | 'oauth_token';

export interface AuthSecrets {
  AUTH_MODE?: AuthMode;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
}

const SETTING_KEY = 'auth_mode';

export const AUTH_LABEL: Record<AuthMode, string> = {
  api_key: 'API key (pay-as-you-go / plan monthly API credits)',
  oauth_token: 'Claude plan sign-in (plan usage limits)',
};

export class AuthManager {
  constructor(
    private readonly secrets: AuthSecrets,
    private readonly store: Store,
  ) {}

  available(): AuthMode[] {
    const m: AuthMode[] = [];
    if (this.secrets.ANTHROPIC_API_KEY) m.push('api_key');
    if (this.secrets.CLAUDE_CODE_OAUTH_TOKEN) m.push('oauth_token');
    return m;
  }

  /** Runtime override (set by /zclaude auth) > AUTH_MODE env > whichever credential exists, API key first. */
  mode(): AuthMode {
    const avail = this.available();
    const override = this.store.getSetting(SETTING_KEY) as AuthMode | undefined;
    if (override && avail.includes(override)) return override;
    if (this.secrets.AUTH_MODE && avail.includes(this.secrets.AUTH_MODE)) return this.secrets.AUTH_MODE;
    const first = avail[0];
    if (!first) throw new Error('No Claude credential configured');
    return first;
  }

  /** Persists a runtime switch. Throws if that credential isn't configured. */
  setMode(mode: AuthMode): void {
    if (!this.available().includes(mode)) {
      throw new Error(
        mode === 'api_key'
          ? 'ANTHROPIC_API_KEY is not set in the bot environment.'
          : 'CLAUDE_CODE_OAUTH_TOKEN is not set in the bot environment.',
      );
    }
    this.store.setSetting(SETTING_KEY, mode);
  }

  /** Clears the runtime override so AUTH_MODE / defaults apply again. */
  reset(): void {
    this.store.setSetting(SETTING_KEY, null);
  }

  /** Env entries for the agent subprocess: exactly one credential. */
  credentialEnv(): Record<string, string> {
    return this.mode() === 'api_key'
      ? { ANTHROPIC_API_KEY: this.secrets.ANTHROPIC_API_KEY! }
      : { CLAUDE_CODE_OAUTH_TOKEN: this.secrets.CLAUDE_CODE_OAUTH_TOKEN! };
  }
}
