/* RaceBox Web - app.js
   Features:
   - Modes (201,402,0-100,0-140,60-100)
   - Auto-arm & auto-start logic
   - Speed graph (canvas)
   - History saved to localStorage, export CSV
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

  // State
  let watchId = null;
  let armed = false;
  let running = false;
  let startPos = null;
  let lastPos = null;
  let cumulative = 0;
  let target = 201;
  let startTime = null;
  let peakSpeed = 0;
  let samples = []; // {t, speed}
  let history = JSON.parse(localStorage.getItem('rb_history') || '[]');

  function hav(a,b){
    const R = 6371000;
    const rad = Math.PI/180;
    const dLat = (b.latitude-a.latitude)*rad;
    const dLon = (b.longitude-a.longitude)*rad;
    const la = a.latitude*rad, lb = b.latitude*rad;
    const s1 = Math.sin(dLat/2), s2 = Math.sin(dLon/2);
    const h = s1*s1 + Math.cos(la)*Math.cos(lb)*s2*s2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
  }

  function setStatus(s){ statusBar.textContent = 'Status: ' + s; }

  function formatDate(ts){
    return new Date(ts).toLocaleString();
  }

  function updateUI(){
    if(!running){ timeEl.textContent = '0.000 s'; avgEl.textContent='—'; }
    // speed display updated in onPos
    // draw graph
    drawGraph();
    renderHistory();
  }

  function drawGraph(){
    // simple scrolling speed graph
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle = '#64d2ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const maxPoints = 120;
    const pts = samples.slice(-maxPoints);
    const w = canvas.width, h = canvas.height;
    if(pts.length === 0) return;
    const maxSpeed = Math.max(100, ...pts.map(p=>p.speed||0));
    pts.forEach((p,i)=>{
      const x = (i/(maxPoints-1))*w;
      const y = h - ((p.speed||0)/maxSpeed)*h;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
    // grid lines
    ctx.strokeStyle='rgba(255,255,255,0.03)';
    ctx.lineWidth=1;
    for(let g=1;g<=3;g++){
      ctx.beginPath();
      ctx.moveTo(0,h*(g/4));
      ctx.lineTo(w,h*(g/4));
      ctx.stroke();
    }
  }

  function onPos(p){
    const c = p.coords;
    accEl.textContent = (c.accuracy||0).toFixed(1)+' m';
    const cur = { latitude: c.latitude, longitude: c.longitude, speed: (c.speed||0)*3.6 }; // km/h
    // push sample
    samples.push({t:performance.now(), speed: cur.speed});
    if(samples.length>1000) samples.shift();

    // update display
    speedDisplay.textContent = cur.speed.toFixed(1);
    if(cur.speed > peakSpeed) peakSpeed = cur.speed;
    peakEl.textContent = (peakSpeed>0?peakSpeed.toFixed(1):'—') + ' km/h';

    // armed logic
    if(!armed) return;

    if(!startPos){
      if(c.accuracy <= 50){
        startPos = cur;
        lastPos = cur;
        setStatus('armed — waiting for movement');
      } else {
        setStatus('arming — waiting for better GPS accuracy');
        return;
      }
    }

    const d = hav(lastPos, cur);
    lastPos = cur;

    if(!running){
      // detect start: speed threshold or movement
      const moved = hav(startPos, cur);
      if((cur.speed>10) || (moved>1.5)){ // start threshold 10 km/h (adjustable)
        running = true;
        startTime = performance.now();
        cumulative = 0;
        peakSpeed = cur.speed;
        samples = [{t:performance.now(), speed:cur.speed}];
        setStatus('running');
      }
    } else {
      cumulative += d;
      distanceEl.textContent = cumulative.toFixed(2) + ' m';
      const elapsed = (performance.now() - startTime)/1000;
      timeEl.textContent = elapsed.toFixed(3) + ' s';
      const avg = (cumulative/elapsed) * 3.6; // km/h
      avgEl.textContent = avg.toFixed(1) + ' km/h';

      // finish logic based on mode
      const mode = modeSelect.value;
      if(mode === '201' || mode === '402'){
        const tgt = (mode==='201'?201:402);
        if(cumulative >= tgt) finishRun(elapsed, cumulative);
      } else if(mode === '0-100'){
        if(peakSpeed >= 100) finishRun(elapsed, cumulative);
      } else if(mode === '0-140'){
        if(peakSpeed >= 140) finishRun(elapsed, cumulative);
      } else if(mode === '60-100'){
        // rolling: detect when passing 60 then reaching 100
        // simple approach: check last N samples for crossing
        const last = samples.slice(-8).map(s=>s.speed);
        if(last.some(s=>s>=60) && last.some(s=>s>=100)) finishRun(elapsed, cumulative);
      }
    }
    drawGraph();
  }

  function finishRun(elapsed, dist){
    running = false;
    armed = false;
    setStatus('finish — time: ' + elapsed.toFixed(3) + ' s');
    // save last run temp
    window._lastRun = {mode: modeSelect.value, time: elapsed, distance: dist, peak: peakSpeed, date: Date.now()};
    // stop watch
  }

  function arm(){
    if(armed){ // disarm
      armed=false; running=false; startPos=null; lastPos=null; cumulative=0; samples=[];
      setStatus('idle');
      if(watchId){ navigator.geolocation.clearWatch(watchId); watchId=null; }
      return;
    }
    if(!('geolocation' in navigator)){ alert('Geolocation tidak tersedia'); return; }
    armed = true; running=false; startPos=null; lastPos=null; cumulative=0; peakSpeed=0; samples=[];
    setStatus('arming — requesting GPS');
    if(watchId!==null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(onPos, e => {
      setStatus('GPS error: ' + e.message);
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  }

  function stop(){
    if(watchId){ navigator.geolocation.clearWatch(watchId); watchId=null; }
    running=false; armed=false; setStatus('stopped');
  }

  function reset(){
    if(watchId){ navigator.geolocation.clearWatch(watchId); watchId=null; }
    armed=false; running=false; startPos=null; lastPos=null; cumulative=0; peakSpeed=0; samples=[];
    distanceEl.textContent='0.00 m'; timeEl.textContent='0.000 s'; speedDisplay.textContent='0.0';
    peakEl.textContent='— km/h'; avgEl.textContent='—'; accEl.textContent='— m';
    setStatus('idle');
  }

  function saveRun(){
    if(!window._lastRun){ alert('Tidak ada run untuk disimpan.'); return; }
    history.unshift(window._lastRun);
    localStorage.setItem('rb_history', JSON.stringify(history));
    renderHistory();
    alert('Run disimpan ke history.');
  }

  function exportCSV(){
    if(history.length===0){ alert('History kosong'); return; }
    const rows = [['mode','time_s','distance_m','peak_kmh','date']];
    history.forEach(r=>{
      rows.push([r.mode, r.time.toFixed(3), r.distance.toFixed(2), r.peak.toFixed(1), new Date(r.date).toISOString()]);
    });
    const csv = rows.map(r=>r.join(',')).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'racebox_history.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  function renderHistory(){
    historyTableBody.innerHTML = '';
    history.forEach((h,i)=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i+1}</td><td>${h.mode}</td><td>${h.time.toFixed(3)}</td><td>${h.distance.toFixed(2)}</td><td>${h.peak.toFixed(1)}</td><td>${new Date(h.date).toLocaleString()}</td>`;
      historyTableBody.appendChild(tr);
    });
  }

  // buttons
  armBtn.addEventListener('click', arm);
  stopBtn.addEventListener('click', stop);
  resetBtn.addEventListener('click', reset);
  saveBtn.addEventListener('click', saveRun);
  exportBtn.addEventListener('click', exportCSV);

  // initialize
  renderHistory();
  setStatus('idle');

  // PWA install hint (minimal)
  if ('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }

  // expose for debug
  window.rb = {arm, stop, reset, history};
})();
