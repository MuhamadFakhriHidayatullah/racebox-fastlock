/* RaceBox Web - app.js (Throttle Start FIX v3 FINAL)
   - Start ONLY when real movement (speed >= 1 km/h for ≥300ms AND moved ≥1 meter)
   - Ghost-speed filter (0.5–1.4 km/h ignored)
   - Zero drift fix (distance tidak naik kalau diam)
   - ARM logic fixed (distance/time tetap nol)
   - Modes 201, 402, 0–100, 0–140, 60–100
*/

(() => {
  // DOM
  const armBtn = document.getElementById("armBtn");
  const stopBtn = document.getElementById("stopBtn");
  const resetBtn = document.getElementById("resetBtn");
  const saveBtn = document.getElementById("saveBtn");
  const exportBtn = document.getElementById("exportBtn");
  const modeSelect = document.getElementById("modeSelect");
  const statusBar = document.getElementById("status");
  const speedDisplay = document.getElementById("speedDisplay");
  const distanceEl = document.getElementById("distance");
  const timeEl = document.getElementById("time");
  const peakEl = document.getElementById("peak");
  const avgEl = document.getElementById("avg");
  const accEl = document.getElementById("accuracy");
  const historyTableBody = document.querySelector("#historyTable tbody");
  const canvas = document.getElementById("speedGraph");
  const ctx = canvas.getContext("2d");

  // State
  let watchId = null;
  let armed = false;
  let running = false;
  let startPos = null;
  let lastPos = null;
  let cumulative = 0;
  let startTime = null;
  let peakSpeed = 0;
  let samples = [];
  let history = JSON.parse(localStorage.getItem("rb_history") || "[]");

  // Distance function
  function hav(a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLon = (b.longitude - a.longitude) * rad;
    const la = a.latitude * rad,
      lb = b.latitude * rad;
    const s1 = Math.sin(dLat / 2),
      s2 = Math.sin(dLon / 2);
    const h = s1 * s1 + Math.cos(la) * Math.cos(lb) * s2 * s2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function setStatus(s) {
    statusBar.textContent = "Status: " + s;
  }

  function onPos(position) {
    const c = position.coords;

    accEl.textContent = (c.accuracy || 0).toFixed(1) + " m";

    // Speed (m/s → km/h)
    let speed = (c.speed || 0) * 3.6;

    // Ghost filter: 0–1.4 km/h dianggap 0
    if (speed < 1.5) speed = 0;

    const cur = {
      latitude: c.latitude,
      longitude: c.longitude,
      speed: speed,
    };

    // Peak speed update
    speedDisplay.textContent = speed.toFixed(1);
    if (speed > peakSpeed) peakSpeed = speed;
    peakEl.textContent = peakSpeed.toFixed(1) + " km/h";

    // Not armed, do nothing
    if (!armed) return;

    // First lock = set start position
    if (!startPos) {
      if (c.accuracy <= 50) {
        startPos = cur;
        lastPos = cur;
        setStatus("armed — waiting throttle");
      } else {
        setStatus("arming — waiting for better GPS accuracy");
      }
      return;
    }

    // Measure movement
    const d = hav(lastPos, cur);
    lastPos = cur;

    // While armed + NOT running → distance/time MUST stay 0
    distanceEl.textContent = "0.00 m";
    timeEl.textContent = "0.000 s";

    // ==========================================
    //         START VALIDATION FIX
    // ==========================================
    const startThreshold = 1; // minimal speed 1 km/h
    const minMove = 1; // minimal gerak 1 meter
    const stableTime = 300; // minimal stabil 300ms

    if (!window._spdStart) window._spdStart = null;

    if (!running) {
      // Cek apakah speed >= 1 km/h stabil
      if (speed >= startThreshold) {
        if (!window._spdStart) window._spdStart = performance.now();
      } else {
        window._spdStart = null;
      }

      const stable = window._spdStart
        ? performance.now() - window._spdStart
        : 0;

      const moved = hav(startPos, cur);

      // -------- Syarat mulai 100% FIX --------
      if (stable >= stableTime && moved >= minMove) {
        running = true;
        startTime = performance.now();
        cumulative = 0;
        peakSpeed = speed;
        samples = [{ t: performance.now(), speed: speed }];
        setStatus("running");
        return;
      }

      setStatus("armed — waiting throttle");
      return;
    }

    // ==========================================
    //                RUNNING
    // ==========================================

    // Add distance (ONLY when running)
    cumulative += d;
    distanceEl.textContent = cumulative.toFixed(2) + " m";

    const elapsed = (performance.now() - startTime) / 1000;
    timeEl.textContent = elapsed.toFixed(3) + " s";

    // Average speed
    const avg = (cumulative / elapsed) * 3.6;
    avgEl.textContent = avg.toFixed(1) + " km/h";

    // Auto finish by mode
    const mode = modeSelect.value;
    if (mode === "201" && cumulative >= 201) finishRun(elapsed, cumulative);
    if (mode === "402" && cumulative >= 402) finishRun(elapsed, cumulative);
    if (mode === "0-100" && peakSpeed >= 100) finishRun(elapsed, cumulative);
    if (mode === "0-140" && peakSpeed >= 140) finishRun(elapsed, cumulative);

    if (mode === "60-100") {
      const lastSpeeds = samples.slice(-8).map((s) => s.speed);
      if (lastSpeeds.some((s) => s >= 60) && lastSpeeds.some((s) => s >= 100)) {
        finishRun(elapsed, cumulative);
      }
    }
  }

  function finishRun(time, dist) {
    running = false;
    armed = false;
    setStatus("finish — time: " + time.toFixed(3) + " s");
  }

  function arm() {
    if (armed) {
      armed = false;
      running = false;
      startPos = null;
      lastPos = null;
      cumulative = 0;
      peakSpeed = 0;
      samples = [];
      setStatus("idle");
      if (watchId) navigator.geolocation.clearWatch(watchId);
      return;
    }

    if (!("geolocation" in navigator)) {
      alert("Geolocation tidak tersedia");
      return;
    }

    running = false;
    window._spdStart = null;

    armed = true;
    startPos = null;
    lastPos = null;
    cumulative = 0;
    peakSpeed = 0;
    samples = [];
    setStatus("arming — requesting GPS");

    if (watchId) navigator.geolocation.clearWatch(watchId);

    watchId = navigator.geolocation.watchPosition(
      onPos,
      (e) => setStatus("GPS error: " + e.message),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  }

  function stop() {
    if (watchId) navigator.geolocation.clearWatch(watchId);
    running = false;
    armed = false;
    setStatus("stopped");
  }

  function reset() {
    if (watchId) navigator.geolocation.clearWatch(watchId);
    armed = false;
    running = false;
    startPos = null;
    lastPos = null;
    cumulative = 0;
    peakSpeed = 0;
    samples = [];
    distanceEl.textContent = "0.00 m";
    timeEl.textContent = "0.000 s";
    speedDisplay.textContent = "0.0";
    avgEl.textContent = "—";
    peakEl.textContent = "— km/h";
    setStatus("idle");
  }

  armBtn.addEventListener("click", arm);
  stopBtn.addEventListener("click", stop);
  resetBtn.addEventListener("click", reset);

  setStatus("idle");
})();
