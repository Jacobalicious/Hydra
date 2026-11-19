// MultiClaude's service worker: shows phone notifications sent by the server
// (Web Push), even when the page is closed or the phone is locked.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const looking = wins.some(w => w.visibilityState === 'visible');
    await self.registration.showNotification(d.title || 'MultiClaude', {
      body: d.body || '',
      icon: '/icon-192.png',
      tag: d.project || d.title || 'multiclaude',   // a newer alert for the same project replaces the old one
      renotify: true,
      silent: looking,                              // he is already looking at the page: no buzz
      data: { project: d.project || null },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const project = e.notification.data && e.notification.data.project;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins[0];
    if (w) { if (project) w.postMessage({ open: project }); return w.focus(); }
    return self.clients.openWindow('/' + (project ? '?open=' + encodeURIComponent(project) : ''));
  })());
});
