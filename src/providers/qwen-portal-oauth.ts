import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { formatCliCommand } from "../cli/command-format.js";

const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
function qwenOAuthClientId(): string {
  const clientId = process.env.QWEN_OAUTH_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("QWEN_OAUTH_CLIENT_ID is not configured on this node");
  }
  return clientId;
}

export async function refreshQwenPortalCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!credentials.refresh?.trim()) {
    throw new Error("Qwen OAuth refresh token missing; re-authenticate.");
  }

  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
      client_id: qwenOAuthClientId(),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 400) {
      throw new Error(
        `Qwen OAuth refresh token expired or invalid. Re-authenticate with \`${formatCliCommand("nova models auth login --provider qwen-portal")}\`.`,
      );
    }
    throw new Error(`Qwen OAuth refresh failed: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Qwen OAuth refresh response missing access token.");
  }

  return {
    ...credentials,
    access: payload.access_token,
    refresh: payload.refresh_token || credentials.refresh,
    expires: Date.now() + payload.expires_in * 1000,
  };
}
