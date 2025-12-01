/* app.js - RaceBox PRO (Final upgrade: dyno-mode accuracy) - FIXED
   Perubahan utama:
   - Tambah `finished` flag agar onPos tidak lagi memproses update setelah finish
   - finishRun sekarang mem-freeze distance & time, membersihkan watch, dan membersihkan samples
   - onPos langsung return jika finished === true
   - arm/stop/reset memperhitungkan finished flag
*/

const CONFIG = {
  GHOST_THRESHOLD_KMH: 2.5,
  START_THRESHOLD_KMH: 3,
  START_WINDOW_MS: 450,
  SPEED_SMOOTH_ALPHA: 0.25,
  KALMAN_Q: 0.1,
  KALMAN_R: 2.0,
  HEADING_MAX_DEG: 25,
  REBUILD_SPEED_MAX_DT: 1200,
  ROLL_OUT_M: 0.3048,
  GRAPH_MAX_POINTS: 240
};

(() => {
  // DOM refs (sama seperti sebelumnya)
  const armBtn = document.getElementById('armBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resetBtn = document.getElementById('resetBtn');
  const saveBtn = document.getElementById('saveBtn');
  const exportBtn = document.getElementById('exportBtn');
  const rolloutChk = document.getElementById('rollout');
  const statusBar = document.getElementById('status');
  const speedDisplay = document.getElementById('speedDisplay');
  const distanceEl = document.getElementById('distance');
  const timeEl = document.getElementById('time');
  const accEl = document.getElementById('accuracy');
  const peakEl = document.getElementById('peak');
  const avgEl = document.getElementById('avg');
  const spk = document.getElementById('spk');
  const distk = document.getElementById('distk');
  const timek = document.getElementById('timek');
  const runResults = document.getElementById('runResults');
  const rawRun = document.getElementById('rawRun');
  const historyTableBody = document.querySelector('#historyTable tbody');
  const speedGraph = document.getElementById('speedGraph');
  const ctx = speedGraph ? speedGraph.getContext('2d') : null;
  const modeSelect = document.getElementById('modeSelect');
  const estimateBtn = document.getElementById('estimateBtn');
  const massInput = document.getElementById('massInput');
  const estMarker = document.getElementById('estMarker');

  // internal state
  let watchId = null;
  let armed = false;
  let running = false;
  let finished = false;        // <-- NEW: indicates run has finished (freeze state)
  let startPos = null;
  let lastPos = null;
  let lastHeading = null;
  let cumulative = 0;
  let startTime = null;
  let peakSpeed = 0;
  let samples = [];
  let graphSamples = [];
  let history = JSON.parse(localStorage.getItem('rb_history') || '[]');

  const MILESTONES = [20, 100, 201, 402];
  let marks = {};

  // kalman (unchanged)
  const kalman = {
    x: 0, p: 1, q: CONFIG.KALMAN_Q, r: CONFIG.KALMAN_R,
    predict() { this.p += this.q; },
    update(z) { this.predict(); const k = this.p/(this.p+this.r); this.x = this.x + k*(z - this.x); this.p = (1-k)*this.p; return this.x; },
    reset(v) { this.x = v; this.p = 1; }
  };

  function setStatus(s){ if(statusBar) statusBar.textContent = s; }
  function resetMarks(){ marks = {}; MILESTONES.forEach(m => marks[m] = null); }
  function resetUI() {
    if(distanceEl) distanceEl.textContent = "0.00 m";
    if(timeEl) timeEl.textContent = "0.000 s";
    if(speedDisplay) speedDisplay.textContent = "0.0 km/h";
    if(peakEl) peakEl.textContent = "— km/h";
    if(avgEl) avgEl.textContent = "—";
    if(accEl) accEl.textContent = "— m";
    if(spk) spk.textContent = "0.0";
    if(distk) distk.textContent = "0.00";
    if(timek) timek.textContent = "0.000";
    if(runResults) runResults.innerHTML = '<div style="grid-column:1/3;color:#98a4b3;text-align:center">No run yet. ARM then gas to start.</div>';
    if(rawRun) rawRun.textContent = '—';
    if(ctx) ctx.clearRect(0,0,speedGraph.width,speedGraph.height);
    samples = []; graphSamples = []; kalman.reset(0);
  }

  function hav(a,b){
    const R = 6371000; const rad = Math.PI/180;
    const dLat=(b.latitude-a.latitude)*rad, dLon=(b.longitude-a.longitude)*rad;
    const la=a.latitude*rad, lb=b.latitude*rad;
    const s1=Math.sin(dLat/2), s2=Math.sin(dLon/2);
    const h=s1*s1 + Math.cos(la)*Math.cos(lb)*s2*s2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
  }
  function headingDeg(a,b){
    const rad = Math.PI/180;
    const y = Math.sin((b.longitude - a.longitude)*rad) * Math.cos(b.latitude*rad);
    const x = Math.cos(a.latitude*rad)*Math.sin(b.latitude*rad) - Math.sin(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.cos((b.longitude - a.longitude)*rad);
    const brad = Math.atan2(y,x); return (brad*180/Math.PI + 360) % 360;
  }
  function lowPass(prev, cur, alpha){ return (alpha*cur) + ((1-alpha)*prev); }
  function rebuildSpeedFromDelta(dMeters, dtMs){ if(dtMs<=0) return 0; const v=(dMeters/(dtMs/1000)); return v*3.6; }

  function drawGraph(){
    if(!ctx) return;
    ctx.clearRect(0,0,speedGraph.width,speedGraph.height);
    const pts = graphSamples.slice(-CONFIG.GRAPH_MAX_POINTS);
    if(pts.length===0) return;
    const w = speedGraph.width, h = speedGraph.height;
    const maxSpeed = Math.max(100, ...pts.map(p=>p.speed));
    ctx.lineWidth=2; ctx.strokeStyle='#64d2ff'; ctx.beginPath();
    pts.forEach((p,i)=>{ const x=(i/(pts.length-1))*w; const y=h-(p.speed/maxSpeed)*h; if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
    ctx.setLineDash([6,4]); ctx.strokeStyle='rgba(255,59,48,0.18)';
    const pkY = h - (peakSpeed / Math.max(1, Math.max(...pts.map(p=>p.speed)))) * h;
    ctx.beginPath(); ctx.moveTo(0,pkY); ctx.lineTo(w,pkY); ctx.stroke(); ctx.setLineDash([]);
  }

  function renderRunResults(){
    if(!runResults || !window._lastRun) return;
    const r = window._lastRun;
    let html = `<strong>Best results of 1 run:</strong><br><br>`;
    for(const m of MILESTONES){
      const mk = r.marks && r.marks[m];
      const ttxt = mk && typeof mk.time === 'number' ? mk.time.toFixed(2)+' s' : '—';
      const stxt = mk && typeof mk.speed === 'number' ? mk.speed.toFixed(2)+' km/h' : '—';
      html += `${m} m : <span style="font-weight:700">${ttxt}</span> (${stxt})<br>`;
    }
    html += `<br><strong>1ft rollout:</strong> ${(rolloutChk && rolloutChk.checked) ? 'ON' : 'OFF'}<br>`;
    html += `<strong>Peak:</strong> ${r.peak ? r.peak.toFixed(2) + ' km/h' : '—' }<br>`;
    runResults.innerHTML = html;
    if(rawRun) rawRun.textContent = JSON.stringify(r, null, 2);
  }

  function renderHistory(){
    if(!historyTableBody) return;
    historyTableBody.innerHTML = '';
    history.forEach((h,i)=>{ const tr=document.createElement('tr'); tr.innerHTML = `<td>${i+1}</td><td>${h.mode||''}</td><td>${h.d20?h.d20.toFixed(3):''}</td><td>${h.d100?h.d100.toFixed(3):''}</td><td>${h.d201?h.d201.toFixed(3):''}</td><td>${h.d402?h.d402.toFixed(3):''}</td><td>${h.peak?h.peak.toFixed(1):''}</td><td>${new Date(h.date).toLocaleString()}</td>`; historyTableBody.appendChild(tr); });
  }

  // SAFE finishRun: freeze values, clear watch, mark finished
  function finishRun(){
    if(finished) return;              // already finished -> no-op
    finished = true;                 // block further onPos processing
    running = false;
    armed = false;
    setStatus('finish — run complete');

    // freeze cumulative/time to the exact value at finish (already set just before calling)
    const last = {
      mode: modeSelect ? modeSelect.value : '',
      date: Date.now(),
      peak: peakSpeed,
      marks: JSON.parse(JSON.stringify(marks)),
      d20: marks[20] ? marks[20].time : null,
      d100: marks[100] ? marks[100].time : null,
      d201: marks[201] ? marks[201].time : null,
      d402: marks[402] ? marks[402].time : null,
      s20: marks[20] ? marks[20].speed : null,
      s100: marks[100] ? marks[100].speed : null,
      s201: marks[201] ? marks[201].speed : null,
      s402: marks[402] ? marks[402].speed : null,
      distance: cumulative,
      rollout: !!(rolloutChk && rolloutChk.checked)
    };

    window._lastRun = last;
    renderRunResults();
    renderHistory();

    // clear watch to stop position updates
    if(watchId){ try{ navigator.geolocation.clearWatch(watchId); }catch(e){}; watchId = null; }

    // clear volatile samples so UI doesn't keep updating peak etc.
    samples = []; graphSamples = [];
  }

  // position handler with early return on finished
  function onPos(p){
    if(finished) return; // <<< IMPORTANT: do nothing if already finished

    const c = p.coords;
    if(accEl) accEl.textContent = (c.accuracy||0).toFixed(1) + ' m';

    // raw speed (m/s) may be null
    const rawSpeedMs = (typeof c.speed === 'number') ? c.speed : null;
    let measuredSpeedKmh = rawSpeedMs !== null ? rawSpeedMs * 3.6 : null;

    const now = performance.now();
    let dtMs = 0;
    if(samples.length > 0) dtMs = now - samples[samples.length-1].t;

    if(lastPos && c.latitude && c.longitude){
      const dDelta = hav(lastPos, {latitude: c.latitude, longitude: c.longitude});
      const headingNow = lastHeading !== null ? headingDeg(lastPos, {latitude: c.latitude, longitude: c.longitude}) : null;
      let headingOk = true;
      if(lastHeading !== null && headingNow !== null){
        const diff = Math.abs(((headingNow - lastHeading + 540) % 360) - 180);
        if(diff > CONFIG.HEADING_MAX_DEG) headingOk = false;
      }
      lastHeading = headingNow;
      if((measuredSpeedKmh === null || measuredSpeedKmh < 0.5) && dtMs > 0 && dtMs <= CONFIG.REBUILD_SPEED_MAX_DT && headingOk){
        const rebuilt = rebuildSpeedFromDelta(dDelta, dtMs);
        measuredSpeedKmh = rebuilt;
      }
    }

    if(measuredSpeedKmh !== null && measuredSpeedKmh < CONFIG.GHOST_THRESHOLD_KMH) measuredSpeedKmh = 0;

    let smoothKmh = 0;
    if(measuredSpeedKmh !== null){
      const measMs = measuredSpeedKmh / 3.6;
      const kal = kalman.update(measMs);
      smoothKmh = kal * 3.6;
    } else {
      smoothKmh = samples.length ? samples[samples.length-1].speed : 0;
    }

    const lastSmooth = samples.length ? samples[samples.length-1].speed : smoothKmh;
    const smoothed = lowPass(lastSmooth, smoothKmh, CONFIG.SPEED_SMOOTH_ALPHA);

    // push sample and prune
    samples.push({ t: now, speed: smoothed });
    const maxKeepMs = 3000;
    samples = samples.filter(s => now - s.t <= maxKeepMs);

    graphSamples.push({ t: now, speed: smoothed });
    if(graphSamples.length > 2000) graphSamples.shift();

    if(speedDisplay) speedDisplay.textContent = smoothed.toFixed(1) + ' km/h';
    if(spk) spk.textContent = smoothed.toFixed(1);
    if(measuredSpeedKmh !== null && measuredSpeedKmh > peakSpeed) peakSpeed = measuredSpeedKmh;
    if(peakEl) peakEl.textContent = peakSpeed ? peakSpeed.toFixed(1) + ' km/h' : '—';

    drawGraph();

    // If not armed, update lastPos and exit
    if(!armed){
      lastPos = { latitude: c.latitude, longitude: c.longitude };
      return;
    }

    // ensure GPS lock
    if(!startPos){
      if(c.accuracy <= 50){
        startPos = { latitude: c.latitude, longitude: c.longitude };
        lastPos = startPos;
        lastHeading = null;
        setStatus('armed — waiting throttle');
      } else {
        setStatus('arming — waiting GPS accuracy');
      }
      lastPos = { latitude: c.latitude, longitude: c.longitude };
      return;
    }

    // delta distance (heading filter)
    let d = 0;
    if(lastPos){
      const dtmp = hav(lastPos, { latitude: c.latitude, longitude: c.longitude });
      const hNow = headingDeg(lastPos, { latitude: c.latitude, longitude: c.longitude });
      if(lastHeading !== null){
        const diff = Math.abs(((hNow - lastHeading + 540) % 360) - 180);
        if(diff <= CONFIG.HEADING_MAX_DEG) d = dtmp;
        else d = 0;
      } else {
        d = dtmp;
      }
      lastHeading = hNow;
    }

    // start detection
    const nowMs = performance.now();
    const recent = samples.filter(s => nowMs - s.t <= CONFIG.START_WINDOW_MS);
    const ready = recent.length > 0 && recent.every(s => s.speed >= CONFIG.START_THRESHOLD_KMH);

    if(!running){
      if(ready){
        running = true; startTime = now; cumulative = 0; peakSpeed = smoothed; samples = [{t: now, speed: smoothed}]; resetMarks(); setStatus('running'); 
      } else {
        setStatus('armed — waiting throttle');
      }
      lastPos = { latitude: c.latitude, longitude: c.longitude };
      return;
    }

    // RUNNING: accumulate distance/time
    cumulative += d;
    if(distanceEl) distanceEl.textContent = cumulative.toFixed(2) + ' m';
    if(distk) distk.textContent = cumulative.toFixed(2);

    const elapsed = (now - startTime) / 1000;
    if(timeEl) timeEl.textContent = elapsed.toFixed(3) + ' s';
    if(timek) timek.textContent = elapsed.toFixed(3);

    const avg = elapsed > 0 ? (cumulative / elapsed) * 3.6 : 0;
    if(avgEl) avgEl.textContent = avg.toFixed(1) + ' km/h';

    const rolloutOffset = (rolloutChk && rolloutChk.checked) ? CONFIG.ROLL_OUT_M : 0;

    for(const m of MILESTONES){
      if(!marks[m] && cumulative >= (m - rolloutOffset)){
        marks[m] = { time: elapsed, speed: smoothed };
        renderRunResults();
      }
    }

    // STOP conditions
    if(marks[402]){
      // ensure we freeze cumulative to the moment we detected milestone (avoid tiny overshoot)
      // Optionally you can set cumulative = 402 (or keep actual). We'll keep actual but mark finished.
      finishRun();
      lastPos = { latitude: c.latitude, longitude: c.longitude };
      return;
    }

    if(modeSelect){
      const mode = modeSelect.value;
      if(mode === '201' && cumulative >= (201 - rolloutOffset)) { finishRun(); lastPos = { latitude: c.latitude, longitude: c.longitude }; return; }
      if(mode === '402' && cumulative >= (402 - rolloutOffset)) { finishRun(); lastPos = { latitude: c.latitude, longitude: c.longitude }; return; }
      if(mode === '0-100' && peakSpeed >= 100) { finishRun(); lastPos = { latitude: c.latitude, longitude: c.longitude }; return; }
      if(mode === '0-140' && peakSpeed >= 140) { finishRun(); lastPos = { latitude: c.latitude, longitude: c.longitude }; return; }
      if(mode === '60-100'){
        const lastSpeeds = samples.slice(-10).map(s => s.speed);
        if(lastSpeeds.some(s => s >= 60) && lastSpeeds.some(s => s >= 100)) { finishRun(); lastPos = { latitude: c.latitude, longitude: c.longitude }; return; }
      }
    }

    lastPos = { latitude: c.latitude, longitude: c.longitude };
  } // end onPos

  // handlers
  function arm(){
    // reset finished when arming again (user wants new run)
    if(armed){
      armed = false; running = false; finished = false;
      startPos = null; lastPos = null; lastHeading = null;
      cumulative = 0; startTime = null; peakSpeed = 0;
      samples = []; graphSamples = []; resetMarks();
      if(watchId){ navigator.geolocation.clearWatch(watchId); watchId = null; }
      setStatus('idle'); resetUI(); return;
    }
    if(!('geolocation' in navigator)){ alert('Geolocation tidak tersedia'); return; }
    running = false; armed = true; finished = false;
    startPos = null; lastPos = null; lastHeading = null;
    cumulative = 0; startTime = null; peakSpeed = 0; samples = []; graphSamples = [];
    resetMarks();
    setStatus('arming — requesting GPS');
    if(watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(onPos, e => { setStatus('GPS error: ' + e.message); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  }

  function stop(){
    if(watchId){ navigator.geolocation.clearWatch(watchId); watchId = null; }
    running = false; armed = false; finished = false;
    setStatus('stopped');
  }

  function resetAll(){
    if(watchId){ navigator.geolocation.clearWatch(watchId); watchId = null; }
    armed = false; running = false; finished = false;
    startPos = null; lastPos = null; lastHeading = null;
    cumulative = 0; startTime = null; peakSpeed = 0;
    samples = []; graphSamples = [];
    resetMarks(); resetUI(); setStatus('idle');
  }

  function saveRun(){
    if(!window._lastRun){ alert('Tidak ada run untuk disimpan'); return; }
    const last = JSON.parse(JSON.stringify(window._lastRun));
    history.unshift(last);
    localStorage.setItem('rb_history', JSON.stringify(history));
    renderHistory();
    alert('Run disimpan.');
  }

  function exportCSV(){
    if(history.length === 0){ alert('History kosong'); return; }
    const rows = [['d20_s','d100_s','d201_s','d402_s','s20_kmh','s100_kmh','s201_kmh','s402_kmh','peak_kmh','rollout','date']];
    history.forEach(h => {
      rows.push([
        h.d20 ? h.d20.toFixed(3) : '',
        h.d100 ? h.d100.toFixed(3) : '',
        h.d201 ? h.d201.toFixed(3) : '',
        h.d402 ? h.d402.toFixed(3) : '',
        h.s20 ? h.s20.toFixed(2) : '',
        h.s100 ? h.s100.toFixed(2) : '',
        h.s201 ? h.s201.toFixed(2) : '',
        h.s402 ? h.s402.toFixed(2) : '',
        h.peak ? h.peak.toFixed(2) : '',
        h.rollout ? 1 : 0,
        new Date(h.date).toISOString()
      ]);
    });
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'racebox_history.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  // estimate WHP (unchanged)
  function estimateWHPFromMarker(massKg, marker){
    if(!window._lastRun || !window._lastRun.marks) return null;
    const mk = window._lastRun.marks[marker];
    if(!mk || !mk.time || !mk.speed) return null;
    const v = mk.speed / 3.6;
    const t = mk.time;
    if(t <= 0 || v <= 0) return null;
    const energy = 0.5 * massKg * v * v;
    const powerW = energy / t;
    const hp = powerW / 745.7;
    return { hp, powerW, v, t };
  }

  // bind UI
  if(armBtn) armBtn.addEventListener('click', arm);
  if(stopBtn) stopBtn.addEventListener('click', stop);
  if(resetBtn) resetBtn.addEventListener('click', resetAll);
  if(saveBtn) saveBtn.addEventListener('click', saveRun);
  if(exportBtn) exportBtn.addEventListener('click', exportCSV);

  const estimateBtnEl = document.getElementById('estimateBtn');
  if(estimateBtnEl){
    estimateBtnEl.addEventListener('click', () => {
      const mass = parseFloat(massInput.value || '0');
      const marker = parseInt(estMarker.value || '201', 10);
      const outEl = document.getElementById('estimateResult');
      if(isNaN(mass) || mass <= 0){ alert('Masukkan mass (kg) valid'); return; }
      const res = estimateWHPFromMarker(mass, marker);
      if(!res){ outEl.textContent = 'Marker data belum tersedia. Jalankan 1 run.'; return; }
      outEl.innerHTML = `Estimate WHP: <strong>${res.hp.toFixed(2)} HP</strong> — avg ${(res.powerW/1000).toFixed(2)} kW (v=${res.v.toFixed(2)} m/s, t=${res.t.toFixed(3)} s)`;
    });
  }

  // init
  resetMarks();
  renderHistory();
  resetUI();
  setStatus('idle');

  if('serviceWorker' in navigator){
    try{ navigator.serviceWorker.register('sw.js').catch(()=>{}); }catch(e){}
  }

  // debug
  window.RaceBox = {
    state: () => ({ armed, running, finished, cumulative, peakSpeed, marks, history }),
    lastRun: () => window._lastRun || null,
    estimateWHPFromMarker
  };
})(); // end IIFE
