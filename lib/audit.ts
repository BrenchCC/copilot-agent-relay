// lib/audit.ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry } from "./types";

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  async write(entry: AuditEntry): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (!this.dirEnsured) {
        await mkdir(dirname(this.path), { recursive: true });
        this.dirEnsured = true;
      }
      const line = JSON.stringify(entry) + "\n";
      await appendFile(this.path, line, "utf-8");
    });
    return this.chain;
  }
}
