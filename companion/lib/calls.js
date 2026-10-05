// Lets characters call the user: a scheduler that "rings" (push notification + in-page ringing)
// and tracks answered / missed calls.
import { Store } from "./store.js";

const RING_MS = 45_000; // unanswered after this -> missed
const MIN_GAP_MS = 4 * 3600_000; // "now and then" calls are at least this far apart

function localTime(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
};

function inQuietHours(now, start, end) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === null || e === null || s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e; // window may wrap past midnight
}

export class Calls {
  constructor(store, push, getCharacters) {
    this.store = store;
    this.push = push;
    this.getCharacters = getCharacters;
    this.timers = new Set();
    setInterval(() => this.tick(), 30_000).unref();
  }

  state() {
    return this.store.read("calls", { pending: null, lastAttempt: {}, lastMissed: {}, dailyDone: {} });
  }

  save(s) {
    this.store.write("calls", s);
  }

  /** The call that is ringing right now, if any (expired calls become missed). */
  pending() {
    const s = this.state();
    const p = s.pending;
    if (p && Date.now() - p.at > RING_MS) {
      s.lastMissed[p.characterId] = p.at;
      s.pending = null;
      this.save(s);
      return null;
    }
    return p;
  }

  async ring(characterId) {
    if (this.pending()) return null; // already ringing
    const character = this.getCharacters().find((c) => c.id === characterId);
    if (!character) return null;
    const s = this.state();
    s.pending = { id: Store.id(), characterId, name: character.name, at: Date.now() };
    s.lastAttempt[characterId] = Date.now();
    this.save(s);
    const devices = await this.push.notifyAll();
    console.log(`📞 ${character.name} is calling (${devices} device(s) notified)`);
    return s.pending;
  }

  /** Ring after a delay (for "call me in N minutes"). */
  ringLater(characterId, delayMs) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.ring(characterId);
    }, delayMs);
    this.timers.add(t);
  }

  /** answer | decline: either way the ringing stops. Declined calls count as missed. */
  resolve(id, answered) {
    const s = this.state();
    if (s.pending?.id !== id) return false;
    if (!answered) s.lastMissed[s.pending.characterId] = s.pending.at;
    else delete s.lastMissed[s.pending.characterId];
    s.pending = null;
    this.save(s);
    return true;
  }

  lastMissed(characterId) {
    this.pending();
    return this.state().lastMissed[characterId] || 0;
  }

  clearMissed(characterId) {
    const s = this.state();
    delete s.lastMissed[characterId];
    this.save(s);
  }

  tick() {
    if (this.pending()) return;
    const s = this.state();
    for (const c of this.getCharacters()) {
      const cfg = c.calls;
      if (!cfg || cfg.mode === "never") continue;
      const { date, minutes } = localTime(cfg.tz);
      if (inQuietHours(minutes, cfg.quietStart, cfg.quietEnd)) continue;

      if (cfg.mode === "daily") {
        const at = toMinutes(cfg.time);
        // Within 30 min after the set time, once per day (so a restart doesn't call hours late).
        if (at !== null && minutes >= at && minutes - at < 30 && s.dailyDone[c.id] !== date) {
          s.dailyDone[c.id] = date;
          this.save(s);
          return void this.ring(c.id);
        }
      } else if (cfg.mode === "sometimes") {
        if (Date.now() - (s.lastAttempt[c.id] || 0) < MIN_GAP_MS) continue;
        const qs = toMinutes(cfg.quietStart);
        const qe = toMinutes(cfg.quietEnd);
        const quiet = qs === null || qe === null ? 0 : (qe - qs + 1440) % 1440;
        const awakeTicks = Math.max(60, (1440 - quiet) * 2); // ticks are 30 s
        if (Math.random() < 1 / awakeTicks) return void this.ring(c.id); // ≈ once per waking day
      }
    }
  }
}
