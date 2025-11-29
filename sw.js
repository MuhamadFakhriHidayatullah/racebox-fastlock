// sw.js placeholder for PWA
self.addEventListener('install', (e)=>{self.skipWaiting()});
self.addEventListener('activate', (e)=>{self.clients.claim()});
