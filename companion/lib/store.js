// Tiny JSON-file store. Everything lives in companion/data/ (git-ignored), so it stays on your machine.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) {
    return path.join(this.dir, `${name.replace(/[^a-z0-9_.-]/gi, "_")}.json`);
  }

  read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), "utf8"));
    } catch {
      return fallback;
    }
  }

  write(name, value) {
    const f = this.file(name);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${f}.tmp`, f); // atomic replace
    return value;
  }

  remove(name) {
    fs.rmSync(this.file(name), { force: true });
  }

  static id() {
    return crypto.randomBytes(6).toString("hex");
  }
}
