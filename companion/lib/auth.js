// Password protection for deployments. Set APP_PASSWORD and everything except the login page needs a session cookie.
import crypto from "node:crypto";

const COOKIE = "companion_session";
const PUBLIC_PATHS = new Set(["/login.html", "/style.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/sw.js", "/healthz", "/api/login"]);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

export class Auth {
  constructor(password, store) {
    this.password = password || "";
    let secret = store.read("secret", null)?.secret;
    if (!secret) secret = store.write("secret", { secret: crypto.randomBytes(32).toString("hex") }).secret;
    // Changing APP_PASSWORD changes the token, which signs everyone out.
    this.token = crypto.createHmac("sha256", secret).update(this.password).digest("base64url");
    this.attempts = new Map(); // ip -> [timestamps]
  }

  get enabled() {
    return Boolean(this.password);
  }

  isPublic(pathname) {
    return PUBLIC_PATHS.has(pathname);
  }

  isAuthed(req) {
    if (!this.enabled) return true;
    const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    const value = cookie?.slice(COOKIE.length + 1) || "";
    return crypto.timingSafeEqual(sha(value), sha(this.token));
  }

  /** Returns true if the password is right; sets the session cookie. Throttles guessing. */
  login(req, res, password) {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    const recent = (this.attempts.get(ip) || []).filter((t) => now - t < 60_000);
    if (recent.length >= 10) throw Object.assign(new Error("Too many attempts. Wait a minute."), { status: 429 });
    recent.push(now);
    this.attempts.set(ip, recent);

    if (!crypto.timingSafeEqual(sha(password), sha(this.password))) return false;
    const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${secure ? "; Secure" : ""}`,
    );
    return true;
  }

  logout(res) {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
}
