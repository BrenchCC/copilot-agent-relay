// cli/login.ts
import { requestDeviceCode, pollForToken, fetchUsername } from "../lib/copilot-auth";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AccountFile } from "../lib/types";

export async function runLogin(dataDir: string): Promise<void> {
  console.log("Starting GitHub Device Flow login...\n");

  const deviceCode = await requestDeviceCode();

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Open:  ${deviceCode.verification_uri}`);
  console.log(`  Code:  ${deviceCode.user_code}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("\nWaiting for authorization...");

  const githubToken = await pollForToken(deviceCode.device_code, deviceCode.interval);

  console.log("Authorization successful! Fetching username...");
  const username = await fetchUsername(githubToken);

  const accountsDir = join(dataDir, "accounts");
  await mkdir(accountsDir, { recursive: true });

  const accountFile: AccountFile = {
    username,
    github_token: githubToken,
    created_at: new Date().toISOString(),
  };

  const filePath = join(accountsDir, `${username}.json`);
  await writeFile(filePath, JSON.stringify(accountFile, null, 2), { mode: 0o600 });

  console.log(`\n✓ Account "${username}" saved to ${filePath}`);
  console.log("You can now start the relay with: bun run serve");
}
