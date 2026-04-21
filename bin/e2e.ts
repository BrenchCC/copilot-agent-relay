#!/usr/bin/env bun

import { spawn } from "node:child_process";

const relayBaseUrl = process.env.RELAY_BASE_URL ?? "http://127.0.0.1:8787";
const relaySecret = process.env.RELAY_SECRET;
const expectedText = process.env.E2E_EXPECTED_TEXT ?? "relay-e2e-ok";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response, got: ${text}`);
  }
}

async function runClaude(prompt: string): Promise<{ result: string; raw: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "--bare",
        "--print",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--max-turns",
        "1",
        prompt,
      ],
      {
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: relayBaseUrl,
          ANTHROPIC_AUTH_TOKEN: relaySecret,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as { result?: string };
        resolve({ result: (parsed.result ?? "").trim(), raw: stdout.trim() });
      } catch {
        reject(new Error(`Failed to parse claude JSON output: ${stdout || stderr}`));
      }
    });
  });
}

async function main(): Promise<void> {
  if (!relaySecret) {
    fail("RELAY_SECRET environment variable is required");
  }

  const healthResp = await fetch(`${relayBaseUrl}/relay/health`, {
    headers: { authorization: `Bearer ${relaySecret}` },
  });

  if (!healthResp.ok) {
    fail(`Health check failed: ${healthResp.status} ${await healthResp.text()}`);
  }

  const health = (await readJson(healthResp)) as {
    status?: string;
    accounts?: Array<{ username?: string; healthy?: boolean; hasToken?: boolean }>;
  };

  if (health.status !== "ok") {
    fail(`Health check returned unexpected status: ${JSON.stringify(health)}`);
  }

  const healthyAccount = health.accounts?.find((account) => account.healthy && account.hasToken);
  if (!healthyAccount) {
    fail(`No healthy account with token found: ${JSON.stringify(health)}`);
  }

  const prompt = `Reply with exactly: ${expectedText}`;
  const claudeResult = await runClaude(prompt);

  if (claudeResult.result !== expectedText) {
    fail(`Unexpected Claude CLI response: ${claudeResult.raw}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      relayBaseUrl,
      account: healthyAccount.username ?? "",
      text: claudeResult.result,
    }),
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
