/* app.js - RaceBox full
   - Start ONLY when REAL GAS (speed ≥ 3 km/h stable ~400ms)
   - Ghost-speed filter (< 2.5 km/h -> 0)
   - ARM logic safe (no auto start)
   - Milestones: 20, 100, 201, 402 (capture time & speed)
   - 1ft rollout support (if #rollout checkbox exists)
*/

(() => {
  // DOM
  const armBtn = document.getElementById('armBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resetBtn = document.getElementById('resetBtn');
  const saveBtn = document.getElementById('saveBtn');
  const exportBtn = document.getElementById('exportBtn');
  const modeSelect = document.getElementById('modeSelect'); // optional
  const statusBar = document.getElementById('status');
  const speedDisplay = document.getElementById('speedDisplay');
  const distanceEl = document.getElementById('distance');
  const timeEl = document.getElementById('time');
  const peakEl = document.getElementById('peak');
  const avgEl = document.getElementById('avg');
  const accEl = document.getElementById('accuracy');
  const historyTableBody = document.querySelector('#historyTable tbody');
  const runResultsEl = document.getElementById('runResults') || null;
  const rawRunEl = document.getElementById('rawRun') || null;
  const rolloutChk = document.getElementById('rollout'); // optional
  const canvas = document.getElementById('speedGraph');
  const ctx = canvas ? canvas.getContext('2d') : null;

  // STATE
  let watchId = null;
  let armed = false;
  let running = false;
  let startPos = null;
  let lastPos = null;
  let cumulative = 0;
  let startTime = null;
  let peakSpeed = 0;
  let samples = []; // {t, speed}
  let history = JSON.parse(localStorage.getItem('rb_history') || '[]');

  // Milestone markers
  const MILESTONES = [20, 100, 201, 402];
  let marks = {}; // will hold {20:{time, speed}, ...}

  // GRAPH SETTINGS
  function drawGraph(){
    if(!ctx) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const maxPoints = 120;
    const pts = samples.slice(-maxPoints);
    if(pts.length === 0) return;

    const w = canvas.width, h = canvas.height;
    const maxSpeed = Math.max(100, ...pts.map(p=>p.speed));

    ctx.strokeStyle = "#64d2ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p,i)=>{
      const x = (i/(maxPoints-1))*w;
      const y = h - (p.speed/maxSpeed)*h;
      if(i===0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    });
    ctx.stroke();
  }

  // HELPERS
  function setStatus(s){ if(statusBar) statusBar.textContent = "Status: " + s; }
  function safeText(n, digits=2){ return (typeof n === 'number') ? n.toFixed(digits) : '—'; }

  function hav(a,b){
    // expects {latitude, longitude}
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLon = (b.longitude - a.longitude) * rad;
    const la = a.latitude * rad, lb = b.latitude * rad;
    const s1 = Math.sin(dLat/2), s2 = Math.sin(dLon/2);
    const h = s1*s1 + Math.cos(la)*Math.cos(lb)*s2*s2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
  }

  function resetMarks(){
    marks = {};
    MILESTONES.forEach(m => marks[m] = null);
  }

  function resetAllUI(){
    if(distanceEl) distanceEl.textContent = "0.00 m";
    if(timeEl) timeEl.textContent = "0.000 s";
    if(speedDisplay) speedDisplay.textContent = "0.0";
    if(peakEl) peakEl.textContent = "— km/h";
    if(avgEl) avgEl.textContent = "—";
    if(accEl) accEl.textContent = "— m";
    if(runResultsEl) runResultsEl.innerHTML = '<div class="muted">No run yet. ARM then gas to start.</div>';
    if(rawRunEl) rawRunEl.textContent = "—";
    if(ctx) ctx.clearRect(0,0,canvas.width,canvas.height);
  }

  // RENDER HISTORY
  function renderHistory(){
    if(!historyTableBody) return;
    historyTableBody.innerHTML = "";
    history.forEach((h,i)=>{
      const tr = document.createElement('tr');
      const t201 = h.d201 ? h.d201.toFixed(3) : "";
      const t402 = h.d402 ? h.d402.toFixed(3) : "";
      tr.innerHTML = `<td>${i+1}</td>
        <td>${h.mode || ''}</td>
        <td>${t201}</td>
        <td>${t402}</td>
        <td>${h.peak ? h.peak.toFixed(1) : ''}</td>
        <td>${new Date(h.date).toLocaleString()}</td>`;
      historyTableBody.appendChild(tr);
    });
  }

  function renderRunResults(){
    if(!runResultsEl || !window._lastRun) return;
    const r = window._lastRun;
    // Build display similar to example
    let html = `<strong>Best results of 1 run:</strong><br><br>`;
    for(let m of MILESTONES){
      const mark = r.marks && r.marks[m];
      const ttxt = mark && (typeof mark.time === 'number') ? mark.time.toFixed(2) + " s" : "—";
      const stxt = mark && (typeof mark.speed === 'number') ? mark.speed.toFixed(2) + " km/h" : "—";
      html += `${m} m : <span class="metric">${ttxt}</span> (${stxt})<br>`;
    }
    html += `<br><strong>1ft rollout:</strong> ${ (rolloutChk && rolloutChk.checked) ? 'ON' : 'OFF' }<br>`;
    html += `<strong>Peak speed:</strong> ${ r.peak ? r.peak.toFixed(2) + ' km/h' : '—' }<br>`;
    runResultsEl.innerHTML = html;

    if(rawRunEl) rawRunEl.textContent = JSON.stringify(r, null, 2);
  }

  // FINISH
  function finishRun(){
    running = false;
    armed = false;
    setStatus("finish — run complete");

    // Build last run payload
    const last = {
      mode: modeSelect ? modeSelect.value : '',
      time: marks[201] ? marks[201].time : null,
      distance: cumulative,
      peak: peakSpeed,
      date: Date.now(),
      marks: JSON.parse(JSON.stringify(marks)), // deep copy
      d20: marks[20] ? marks[20].time : null,
      d100: marks[100] ? marks[100].time : null,
      d201: marks[201] ? marks[201].time : null,
      d402: marks[402] ? marks[402].time : null,
      s20: marks[20] ? marks[20].speed : null,
      s100: marks[100] ? marks[100].speed : null,
      s201: marks[201] ? marks[201].speed : null,
      s402: marks[402] ? marks[402].speed : null
    };

    window._lastRun = last;
    // push to history? only on save (explicit) — for now do not auto-save
    renderRunResults();
    renderHistory();

    // stop watch if active
    if(watchId){ navigator.geolocation.clearWatch(watchId); watchId = null; }
  }

  // POSITION HANDLER
  function onPos(p){
    const c = p.coords;
    if(accEl) accEl.textContent = (c.accuracy||0).toFixed(1) + " m";

    // raw speed m/s -> km/h
    let speed = (c.speed || 0) * 3.6;

    // ghost filter
    if(speed < 2.5) speed = 0;

    const cur = { latitude: c.latitude, longitude: c.longitude, speed: speed };

    const now = performance.now();
    samples.push({ t: now, speed: speed });

    // keep ~400ms window
    samples = samples.filter(s => now - s.t <= 400);

    if(speedDisplay) speedDisplay.textContent = speed.toFixed(1) + " km/h";
    if(speed > peakSpeed) peakSpeed = speed;
    if(peakEl) peakEl.textContent = peakSpeed.toFixed(1) + " km/h";

    // draw graph sample
    if(ctx) drawGraph();

    // if not armed -> ignore
    if(!armed) return;

    // need GPS lock first
    if(!startPos){
      if(c.accuracy <= 50){
        startPos = cur;
        lastPos = cur;
        setStatus("armed — waiting throttle");
      } else {
        setStatus("arming — waiting GPS accuracy");
      }
      return;
    }

    // compute delta distance
    const d = hav(lastPos, cur);
    lastPos = cur;

    // start logic: require stable >= threshold
    const startThreshold = 3; // km/h
    const readyStart = samples.length>0 && samples.every(s => s.speed >= startThreshold);

    if(!running){
      if(readyStart){
        // begin run
        running = true;
        startTime = now;
        cumulative = 0;
        peakSpeed = speed;
        samples = [{ t: now, speed: speed }];
        resetMarks();
        setStatus("running");
      } else {
        setStatus("armed — waiting throttle");
      }
      return;
    }

    // RUNNING state
    cumulative += d;
    if(distanceEl) distanceEl.textContent = cumulative.toFixed(2) + " m";

    const elapsed = (now - startTime)/1000;
    if(timeEl) timeEl.textContent = elapsed.toFixed(3) + " s";

    const avg = elapsed > 0 ? (cumulative/elapsed)*3.6 : 0;
    if(avgEl) avgEl.textContent = avg.toFixed(1) + " km/h";

    // handle rollout offset if any
    const rolloutOffset = (rolloutChk && rolloutChk.checked) ? 0.3048 : 0;

    // capture milestones
    for(let m of MILESTONES){
      if(!marks[m]){
        if(cumulative >= (m - rolloutOffset)){
          marks[m] = { time: elapsed, speed: speed };
          // live update
          renderRunResults();
        }
      }
    }

    // finish when 402 reached
    if(marks[402]){
      finishRun();
    }

    // mode-based finish (if HTML has modeSelect)
    if(modeSelect){
      const mode = modeSelect.value;
      if(mode === "201" && cumulative >= (201 - rolloutOffset)) finishRun();
      if(mode === "402" && cumulative >= (402 - rolloutOffset)) finishRun();
      if(mode === "0-100" && peakSpeed >= 100) finishRun();
      if(mode === "0-140" && peakSpeed >= 140) finishRun();
      if(mode === "60-100"){
        // check last ~200ms speeds for 60 and 100
        const lastSpeeds = samples.map(s => s.speed);
        if(lastSpeeds.some(s => s >= 60) && lastSpeeds.some(s => s >= 100)) finishRun();
      }
    }
  }

  // ARM / STOP / RESET / SAVE / EXPORT

  function arm(){
    if(armed){
      // disarm
      armed = false;
      running = false;
      startPos = null; lastPos = null;
      cumulative = 0; startTime = null; peakSpeed = 0;
      samples = [];
      resetMarks();
      if(watchId){ navigator.geolocation.clearWatch(watchId); watchId = null; }
      setStatus("idle");
      resetAllUI();
      return;
    }

    if(!('geolocation' in navigator)){
      alert("Geolocation tidak tersedia");
      return;
    }

    // arm
    running = false;
    armed = true;
    startPos = null; lastPos = null;
    cumulative = 0; startTime = null; peakSpeed = 0;
    samples = [];
    resetMarks();
    setStatus("arming — requesting GPS");

    if(watchId !== null) navigator.geolocation.clearWatch(watchId);

    watchId = navigator.geolocation.watchPosition(onPos, (e) => {
      setStatus("GPS error: " + e.message);
    }, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    });
  }

  function stop(){
    if(watchId){ navigator.geolocation.clearWatch(watchId); watchId = null; }
    running = false; armed = false;
    setStatus("stopped");
  }

  function resetAll(){
    if(watchId){ navigator.geolocation.clearWatch(watchId); watchId = null; }
    armed = false; running = false;
    startPos = null; lastPos = null; cumulative = 0; startTime = null; peakSpeed = 0; samples = [];
    resetMarks();
    resetAllUI();
    setStatus("idle");
  }

  function saveRun(){
    if(!window._lastRun){
      alert("Tidak ada run untuk disimpan");
      return;
    }
    history.unshift(window._lastRun);
    localStorage.setItem('rb_history', JSON.stringify(history));
    renderHistory();
    alert("Run disimpan.");
  }

  function exportCSV(){
    if(history.length === 0){ alert("History kosong"); return; }
    const rows = [["d20_s","d100_s","d201_s","d402_s","s20_kmh","s100_kmh","s201_kmh","s402_kmh","peak_kmh","date"]];
    history.forEach(h => {
      rows.push([
        h.d20 ? h.d20.toFixed(3) : "",
        h.d100 ? h.d100.toFixed(3) : "",
        h.d201 ? h.d201.toFixed(3) : "",
        h.d402 ? h.d402.toFixed(3) : "",
        h.s20 ? h.s20.toFixed(2) : "",
        h.s100 ? h.s100.toFixed(2) : "",
        h.s201 ? h.s201.toFixed(2) : "",
        h.s402 ? h.s402.toFixed(2) : "",
        h.peak ? h.peak.toFixed(2) : "",
        new Date(h.date).toISOString()
      ]);
    });
    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], {type:"text/csv"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = "racebox_history.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  // EVENTS
  if(armBtn) armBtn.addEventListener('click', arm);
  if(stopBtn) stopBtn.addEventListener('click', stop);
  if(resetBtn) resetBtn.addEventListener('click', resetAll);
  if(saveBtn) saveBtn.addEventListener('click', saveRun);
  if(exportBtn) exportBtn.addEventListener('click', exportCSV);

  // INIT
  resetMarks();
  renderHistory();
  resetAllUI();
  setStatus("idle");

  // register service worker if any (optional)
  if('serviceWorker' in navigator){
    try{ navigator.serviceWorker.register("sw.js").catch(()=>{}); } catch(e){}
  }

  // expose for debug
  window.RaceBox = {
    state: () => ({ armed, running, cumulative, peakSpeed, marks, history, startTime }),
    lastRun: () => window._lastRun || null
  };

})();
