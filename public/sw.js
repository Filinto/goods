const CACHE_NAME = 'basket-shell-v4'
const APP_ROOT = new URL('./', self.registration.scope)
const APP_SHELL = [APP_ROOT.href, new URL('manifest.webmanifest', APP_ROOT).href, new URL('basket-icon.svg', APP_ROOT).href]

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))))
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return
  if (event.request.mode === 'navigate') {
    const networkResponse = fetch(event.request)
    event.waitUntil(networkResponse.then(response => {
      if (response.ok) {
        return caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()))
      }
    }).catch(() => undefined))
    event.respondWith(networkResponse.catch(async () => {
      const cached = await caches.match(event.request)
      if (cached) return cached
      return caches.match(APP_ROOT.href)
    }))
    return
  }

  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()))
    return response
  })))
})
