// Service worker: turns a push "tickle" from the server into an incoming-call notification.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let call = null;
      try {
        call = (await (await fetch("/api/calls/pending", { cache: "no-store" })).json()).call;
      } catch {}
      // Browsers require a visible notification for every push.
      const title = call ? `${call.name} is calling…` : "Missed call";
      await self.registration.showNotification(title, {
        body: call ? "Incoming video call. Tap to answer." : "Open the app to call back.",
        tag: "companion-call",
        renotify: true,
        requireInteraction: Boolean(call),
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        vibrate: [600, 300, 600, 300, 600, 300, 600],
        data: { callId: call?.id },
        actions: call ? [{ action: "answer", title: "Answer" }, { action: "decline", title: "Decline" }] : [],
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { callId } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      if (event.action === "decline" && callId) {
        await fetch(`/api/calls/${callId}/decline`, { method: "POST" }).catch(() => {});
        return;
      }
      const url = callId ? `/?answer=${callId}` : "/";
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins[0];
      if (win) {
        await win.focus();
        win.postMessage({ type: "answer", callId });
      } else {
        await self.clients.openWindow(url);
      }
    })(),
  );
});
