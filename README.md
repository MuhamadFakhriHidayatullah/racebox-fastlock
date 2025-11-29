# RaceBox Web — GPS Drag Timer (App-style)

Ini adalah versi *RaceBox-style* berbentuk web app (PWA-ready) yang meniru look-and-feel perangkat RaceBox untuk latihan drag motor.

## Fitur
- Mode: 201 m, 402 m, 0→100, 0→140, 60→100 (rolling)
- Auto-arm & auto-start berdasarkan GPS (speed/movement)
- Live speed, distance, time, peak & average speed
- Speed graph (simple canvas)
- Simpan history ke localStorage
- Export history ke CSV
- PWA manifest included (sw.js placeholder)

## Cara pakai
1. Buka `index.html` di browser (Chrome/Edge recommended).
2. Izinkan akses lokasi.
3. Pilih mode, tekan **ARM**. Tunggu GPS fix (akurasi <= 50 m).
4. Bergerak untuk memulai run — timer otomatis akan berhenti ketika target tercapai.
5. Simpan run jika ingin memasukannya ke history. Export CSV untuk analisa.

## Catatan
- Akurasi bergantung pada GPS HP. Untuk latihan, gunakan area lapang.
- Untuk membuat installable PWA, tambahkan `sw.js` (service worker). File `sw.js` kosong disertakan sebagai placeholder.

