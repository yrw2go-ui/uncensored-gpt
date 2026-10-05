// Turns a character + what it remembers about the user into the system prompt.
const RECENT = 40; // non-core memories of each kind sent to the model (all core ones always are)

export const TRAITS = ["warmth", "humor", "sarcasm", "energy", "curiosity", "formality"];

const TRAIT_WORDS = {
  warmth: ["cold", "warm"],
  humor: ["serious", "funny"],
  sarcasm: ["sincere", "sarcastic"],
  energy: ["calm", "energetic"],
  curiosity: ["reserved", "curious"],
  formality: ["casual", "formal"],
};

function describeTrait(t, v) {
  const [lo, hi] = TRAIT_WORDS[t];
  if (v <= 2) return `very ${lo}`;
  if (v <= 4) return `somewhat ${lo}`;
  if (v >= 8) return `very ${hi}`;
  if (v >= 6) return `fairly ${hi}`;
  return null;
}

function ago(ts) {
  if (!ts) return "";
  const mins = (Date.now() - ts) / 60000;
  if (mins < 60) return "a few minutes ago";
  if (mins < 60 * 24) return "earlier today";
  const days = Math.round(mins / 60 / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * @param c character
 * @param who { name, recognizedBy, facts, moments, summary, lastSeen, calls }
 */
export function compilePrompt(c, who = {}) {
  const lines = [`You are ${c.name}${c.tagline ? `, ${c.tagline}` : ""}.`];
  if (c.personality) lines.push(`Personality: ${c.personality}`);
  if (c.backstory) lines.push(`Backstory: ${c.backstory}`);
  if (c.speakingStyle) lines.push(`Speaking style: ${c.speakingStyle}`);
  if (c.likes) lines.push(`You like: ${c.likes}`);
  if (c.dislikes) lines.push(`You dislike: ${c.dislikes}`);
  const vibe = TRAITS.map((t) => describeTrait(t, c.traits?.[t] ?? 5)).filter(Boolean);
  if (vibe.length) lines.push(`Overall you come across as ${vibe.join(", ")}.`);
  if (c.rules) lines.push(c.rules);
  lines.push(
    "You are on a live video call and everything you write is spoken aloud, so talk naturally in short spoken sentences. " +
      "No markdown, lists, emojis or stage directions. Keep most replies under three sentences unless asked for more. Stay in character.",
  );

  lines.push("");
  if (who.name) {
    const how = who.recognizedBy ? ` (you recognized them by their ${who.recognizedBy})` : "";
    lines.push(`You are talking with ${who.name}${how}.`);
    if (who.lastSeen) lines.push(`You last talked ${ago(who.lastSeen)}${who.calls ? `; this is call number ${who.calls}` : ""}.`);
  } else {
    lines.push("You don't know who you're talking to yet. Early on, warmly ask their name.");
  }
  const all = [...(who.facts || []), ...(who.moments || [])];
  const core = all.filter((m) => m.core);
  const about = (who.facts || []).filter((m) => !m.core).slice(-RECENT);
  const moments = (who.moments || []).filter((m) => !m.core).slice(-RECENT);
  const bullet = (items) => items.map((m) => `- ${m.text}`).join("\n");
  if (core.length) lines.push(`Core memories (the most important things; never contradict or forget these):\n${bullet(core)}`);
  if (about.length) lines.push(`Other things you know about them:\n${bullet(about)}`);
  if (moments.length) lines.push(`Moments you've shared:\n${bullet(moments)}`);
  if (who.summary) lines.push(`Your relationship so far: ${who.summary}`);
  if (all.length || who.summary) lines.push("Bring these memories up naturally when relevant, like a friend would. Don't recite them.");
  return lines.join("\n");
}
