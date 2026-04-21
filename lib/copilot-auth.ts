import { COPILOT_CLIENT_ID, COPILOT_HEADERS, type DeviceCodeResponse } from "./types";
import { RelayError } from "./types";

const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const resp = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!resp.ok) {
    throw new RelayError(`Device code request failed: ${resp.status}`, resp.status);
  }

  return (await resp.json()) as DeviceCodeResponse;
}

export async function pollForToken(deviceCode: string, intervalS: number = 5): Promise<string> {
  let interval = intervalS;

  while (true) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = (await resp.json()) as Record<string, string>;

    if (data.error === "authorization_pending") {
      continue;
    }

    if (data.error === "slow_down") {
      interval += 5;
      continue;
    }

    if (data.error) {
      throw new RelayError(`OAuth polling error: ${data.error}`, 400, data.error);
    }

    if (data.access_token) {
      return data.access_token;
    }

    throw new RelayError("Unexpected OAuth response: no access_token and no error", 500);
  }
}

export async function fetchUsername(githubToken: string): Promise<string> {
  const resp = await fetch(COPILOT_USER_URL, {
    headers: {
      authorization: `token ${githubToken}`,
      accept: "application/json",
      ...COPILOT_HEADERS,
    },
  });

  if (!resp.ok) {
    throw new RelayError(`Failed to fetch Copilot user: ${resp.status}`, resp.status);
  }

  const data = (await resp.json()) as { login?: string; user?: string };
  const username = data.login || data.user;

  if (!username) {
    throw new RelayError("Failed to fetch Copilot user: response missing login/user", 500);
  }

  return username;
}
