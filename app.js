/* RaceBox Web - app.js (Throttle Start FIX v2)
   - Start ONLY when real movement (speed >= 1 km/h for ≥300ms AND moved ≥1 meter)
   - Ghost-speed filter for iPhone (0.5–1.4 km/h ignored)
   - ARM logic fixed (no auto start)
   - Modes 201,402,0–100,0–140,60–100
*/

(() => {
  // DOM
  const armBtn = document.getElementById('armBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resetBtn = document.getElementById('resetBtn');
  const saveBtn = document.getElementById('saveBtn');
  const exportBtn = document.getElementById('exportBtn');
  const modeSelect = document.getElementById('modeSelect');
  const statusBar = document.getElementById('status');
  const speedDisplay = document.getElementById('speedDisplay');
  const distanceEl = document.getElementById('distance');
  const timeEl = document.getElementById('time');
  const peakEl = document.getElementById('peak');
  const avgEl = document.getElementById('avg');
  const accEl = document.getElementById('accuracy');
  const historyTableBody = document.querySelector('#historyTable tbody');
  const canvas = document.getElementById('speedGraph');
  const ctx = canvas.getContext('2d');

  // state
  let watchId = null;
  let armed = false;
  let running = false;
  let startPos = null;
  let lastPos = null;
  let cumulative = 0;
  let startTime = null;
  let peakSpeed = 0;
  let samples = [];
  let history = JSON.parse(localStorage.getItem('rb_history') || '[]');

  // measure distance
  function hav(a,b){
    const R = 6371000;
    const rad = Math.PI/180;
    const dLat=(b.latitude-a.latitude)*rad;
    const dLon=(b.longitude-a.longitude)*rad;
    const la=a.latitude*rad, lb=b.latitude*rad;
    const s1=Math.sin(dLat/2), s2=Math.sin(dLon/2);
    const h=s1*s1 + Math.cos(la)*Math.cos(lb)*s2*s2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
  }

  function setStatus(s){ statusBar.textContent = "Status: " + s; }

  function drawGraph(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const maxPoints = 120;
    const pts = samples.slice(-maxPoints);
    if(pts.length === 0) return;
    const w=canvas.width, h=canvas.height;
    const maxSpeed = Math.max(100, ...pts.map(p=>p.speed));

    ctx.strokeStyle="#64d2ff";
    ctx.lineWidth=2;
    ctx.beginPath();
    pts.forEach((p,i)=>{
      const x = (i/(maxPoints-1))*w;
      const y = h - (p.speed/maxSpeed)*h;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  }

  function onPos(p){
    const c = p.coords;
    accEl.textContent = (c.accuracy||0).toFixed(1)+" m";

    // RAW speed (m/s → km/h)
    let speed = (c.speed || 0) * 3.6;

    // ==== GHOST SPEED FILTER ====
    if (speed < 1.5) speed = 0;

    const cur = {
      latitude:c.latitude,
      longitude:c.longitude,
      speed:speed
    };

    samples.push({t:performance.now(), speed:cur.speed});
    if(samples.length>1000) samples.shift();

    speedDisplay.textContent = cur.speed.toFixed(1);
    if(cur.speed > peakSpeed) peakSpeed = cur.speed;
    peakEl.textContent = peakSpeed.toFixed(1) + " km/h";

    if(!armed) return;

    if(!startPos){
      if(c.accuracy <= 50){
        startPos = cur;
        lastPos = cur;
        setStatus("armed — waiting for throttle");
      } else {
        setStatus("arming — waiting for better GPS accuracy");
      }
      return;
    }

    const d = hav(lastPos, cur);
    lastPos = cur;

    // ==========================================
    //    THROTTLE START FIX (real movement)
    // ==========================================

    const startThreshold = 1;
    const minMove = 1;        // minimal jarak bergerak 1 meter
    const stableTime = 300;   // speed stabil min 300ms

    if (!window._spdStart) window._spdStart = null;

    if (!running) {

      // cek speed stabil
      if (cur.speed >= startThreshold) {
        if (!window._spdStart) window._spdStart = performance.now();
      } else {
        window._spdStart = null;
      }

      const stable = window._spdStart ? (performance.now() - window._spdStart) : 0;
      const moved = hav(startPos, cur);

      if (stable >= stableTime && moved >= minMove) {
        running = true;
        startTime = performance.now();
        cumulative = 0;
        peakSpeed = cur.speed;
        samples = [{ t: performance.now(), speed: cur.speed }];
        setStatus("running");
        return;
      }

      setStatus("armed — waiting throttle");
      return;
    }

    // ==========================================
    // Running mode
    // ==========================================

    cumulative += d;
    distanceEl.textContent = cumulative.toFixed(2)+" m";
    const elapsed = (performance.now() - startTime)/1000;
    timeEl.textContent = elapsed.toFixed(3)+" s";
    const avg = (cumulative/elapsed)*3.6;
    avgEl.textContent = avg.toFixed(1)+" km/h";

    const mode = modeSelect.value;

    if(mode==="201" && cumulative>=201) finishRun(elapsed,cumulative);
    if(mode==="402" && cumulative>=402) finishRun(elapsed,cumulative);
    if(mode==="0-100" && peakSpeed>=100) finishRun(elapsed,cumulative);
    if(mode==="0-140" && peakSpeed>=140) finishRun(elapsed,cumulative);

    if(mode==="60-100"){
      const lastSpeeds = samples.slice(-8).map(s=>s.speed);
      if(lastSpeeds.some(s=>s>=60) && lastSpeeds.some(s=>s>=100)){
        finishRun(elapsed,cumulative);
      }
    }

    drawGraph();
  }

  function finishRun(elapsed,dist){
    running=false;
    armed=false;
    setStatus("finish — time: "+elapsed.toFixed(3)+" s");
    window._lastRun={
      mode:modeSelect.value,
      time:elapsed,
      distance:dist,
      peak:peakSpeed,
      date:Date.now()
    };
  }

  function arm(){
    if(armed){
      armed=false; running=false; startPos=null; lastPos=null; cumulative=0; samples=[];
      setStatus("idle");
      if(watchId){ navigator.geolocation.clearWatch(watchId); watchId=null; }
      return;
    }

    if(!('geolocation' in navigator)){
      alert("Geolocation tidak tersedia");
      return;
    }

    running = false;
    window._spdStart = null;

    armed=true;
    startPos=null; lastPos=null;
    cumulative=0; peakSpeed=0; samples=[];
    setStatus("arming — requesting GPS");

    if(watchId!==null) navigator.geolocation.clearWatch(watchId);

    watchId = navigator.geolocation.watchPosition(onPos, e=>{
      setStatus("GPS error: "+e.message);
    },{
      enableHighAccuracy:true,
      maximumAge:0,
      timeout:10000
    });
  }

  function stop(){
    if(watchId){ navigator.geolocation.clearWatch(watchId); watchId=null; }
    running=false; armed=false;
    setStatus("stopped");
  }

  function reset(){
    if(watchId){ navigator.geolocation.clearWatch(watchId); watchId=null; }
    armed=false; running=false;
    startPos=null; lastPos=null;
    cumulative=0; peakSpeed=0; samples=[];
    distanceEl.textContent="0.00 m";
    timeEl.textContent="0.000 s";
    speedDisplay.textContent="0.0";
    peakEl.textContent="— km/h";
    avgEl.textContent="—";
    accEl.textContent="— m";
    setStatus("idle");
  }

  function saveRun(){
    if(!window._lastRun){ alert("Tidak ada run"); return; }
    history.unshift(window._lastRun);
    localStorage.setItem("rb_history",JSON.stringify(history));
    renderHistory();
    alert("Run disimpan.");
  }

  function renderHistory(){
    historyTableBody.innerHTML="";
    history.forEach((h,i)=>{
      const tr=document.createElement("tr");
      tr.innerHTML=
        `<td>${i+1}</td>
         <td>${h.mode}</td>
         <td>${h.time.toFixed(3)}</td>
         <td>${h.distance.toFixed(2)}</td>
         <td>${h.peak.toFixed(1)}</td>
         <td>${new Date(h.date).toLocaleString()}</td>`;
      historyTableBody.appendChild(tr);
    });
  }

  function exportCSV(){
    if(history.length===0){ alert("History kosong"); return; }
    const rows=[["mode","time_s","distance_m","peak_kmh","date"]];
    history.forEach(r=>{
      rows.push([
        r.mode,
        r.time.toFixed(3),
        r.distance.toFixed(2),
        r.peak.toFixed(1),
        new Date(r.date).toISOString()
      ]);
    });
    const csv=rows.map(r=>r.join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download="racebox_history.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  armBtn.addEventListener("click",arm);
  stopBtn.addEventListener("click",stop);
  resetBtn.addEventListener("click",reset);
  saveBtn.addEventListener("click",saveRun);
  exportBtn.addEventListener("click",exportCSV);

  renderHistory();
  setStatus("idle");

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }
})();
