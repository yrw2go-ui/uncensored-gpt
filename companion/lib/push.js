// Minimal Web Push (VAPID) sender with zero dependencies.
// We send empty "tickle" pushes; the service worker then asks the server what's going on
// (e.g. which character is calling), so no payload encryption is needed.
import crypto from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export class Push {
  constructor(store, subject) {
    this.store = store;
    this.subject = subject || "mailto:companion@example.com";
    let keys = store.read("vapid", null);
    if (!keys) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = publicKey.export({ format: "jwk" });
      keys = store.write("vapid", {
        privatePem: privateKey.export({ format: "pem", type: "pkcs8" }),
        // Browsers want the raw uncompressed point: 0x04 || X || Y
        publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")])),
      });
    }
    this.keys = keys;
    this.privateKey = crypto.createPrivateKey(keys.privatePem);
  }

  get publicKey() {
    return this.keys.publicKey;
  }

  subscriptions() {
    return this.store.read("push", []);
  }

  subscribe(sub, profileId) {
    if (!sub?.endpoint?.startsWith("https://")) throw Object.assign(new Error("Invalid subscription"), { status: 400 });
    const list = this.subscriptions().filter((s) => s.endpoint !== sub.endpoint);
    list.push({ endpoint: sub.endpoint, profileId: profileId || "guest", createdAt: Date.now() });
    this.store.write("push", list);
  }

  unsubscribe(endpoint) {
    this.store.write("push", this.subscriptions().filter((s) => s.endpoint !== endpoint));
  }

  jwt(audience) {
    const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
    const body = b64url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.subject }));
    const sig = crypto.sign("sha256", Buffer.from(`${header}.${body}`), { key: this.privateKey, dsaEncoding: "ieee-p1363" });
    return `${header}.${body}.${b64url(sig)}`;
  }

  /** Wakes every subscribed device. Dead subscriptions are removed. */
  async notifyAll() {
    const subs = this.subscriptions();
    const dead = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          const r = await fetch(s.endpoint, {
            method: "POST",
            headers: {
              TTL: "60",
              Urgency: "high",
              Authorization: `vapid t=${this.jwt(new URL(s.endpoint).origin)}, k=${this.publicKey}`,
              "Content-Length": "0",
            },
          });
          if (r.status === 404 || r.status === 410) dead.push(s.endpoint);
          else if (!r.ok) console.warn("push failed", r.status, (await r.text()).slice(0, 200));
        } catch (e) {
          console.warn("push error", e.message);
        }
      }),
    );
    if (dead.length) this.store.write("push", subs.filter((s) => !dead.includes(s.endpoint)));
    return subs.length - dead.length;
  }
}
