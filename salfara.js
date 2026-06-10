/* ═══════════════════════════════════════════════════════
   SALFARA — App Engine
   WebSocket · State · Routing · Views
   ═══════════════════════════════════════════════════════ */

const HA_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkODI0NTRmNTkzY2E0OWRlOWNlNzIzNGVhMmQyOWNjMCIsImlhdCI6MTc4MTAxMTcyMiwiZXhwIjoyMDk2MzcxNzIyfQ.v8cDSh-JCMu5RmNthb7LE5DnGHNhk4juttYsEFZKSCw';
const HA_BASE  = `${location.protocol}//${location.hostname}:8123`;
const HA_WS    = `${location.protocol==='https:'?'wss':'ws'}://${location.hostname}:8123/api/websocket`;

/* ═══════════════════════════════════════════════════════
   STATO GLOBALE
   ═══════════════════════════════════════════════════════ */
const S = {};          // Stati HA — S['sensor.xxx'] = { state, attributes }
let ws, msgId = 1;
let currentView = 'home';
let congelTemp = -22, fornoTemp = 180;
let chartInstances = {};

/* ═══════════════════════════════════════════════════════
   WEBSOCKET
   ═══════════════════════════════════════════════════════ */
function wsConnect() {
  ws = new WebSocket(HA_WS);
  ws.onopen    = () => setConn('Autenticazione…', 'connecting');
  ws.onmessage = e  => wsHandle(JSON.parse(e.data));
  ws.onclose   = () => { setConn('● Disconnesso', 'error'); setTimeout(wsConnect, 3000); };
}

function wsHandle(msg) {
  if (msg.type === 'auth_required') wsSend({ type: 'auth', access_token: HA_TOKEN });
  if (msg.type === 'auth_ok') {
    setConn('● Connesso', '');
    wsSend({ id: msgId++, type: 'get_states' });
    wsSend({ id: msgId++, type: 'subscribe_events', event_type: 'state_changed' });
  }
  if (msg.type === 'result' && Array.isArray(msg.result)) {
    msg.result.forEach(s => { S[s.entity_id] = s; });
    renderCurrentView();
  }
  if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
    const d = msg.event.data;
    S[d.entity_id] = d.new_state;
    patchEntity(d.entity_id);
  }
}

function wsSend(m)  { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
function callSvc(domain, service, data) {
  wsSend({ id: msgId++, type: 'call_service', domain, service, service_data: data });
}

function setConn(t, c) {
  const el = document.getElementById('conn-status');
  if (el) { el.textContent = t; el.className = 'conn-status ' + (c || ''); }
}

/* ═══════════════════════════════════════════════════════
   ROUTING
   ═══════════════════════════════════════════════════════ */
function navigate(view) {
  currentView = view;

  // Aggiorna navbar
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });

  // Distruggi grafici se si lascia statistiche
  if (view !== 'statistiche') destroyAllCharts();

  // Render
  renderCurrentView();

  // Scroll to top
  const v = document.getElementById('view');
  if (v) v.scrollTop = 0;
}

function renderCurrentView() {
  const views = { home, cucina, clima, consumi, automazioni, statistiche, sistema, impostazioni };
  const fn = views[currentView];
  if (fn) {
    const v = document.getElementById('view');
    if (v) {
      v.className = ['home','consumi','sistema'].includes(currentView) ? 'no-scroll' : '';
      v.innerHTML = fn();
      afterRender(currentView);
    }
  }
}

function afterRender(view) {
  if (view === 'home')         { startClock(); }
  if (view === 'statistiche')  { loadAllCharts(1); }
  if (view === 'impostazioni') { syncAllSliders(); }
}

/* ═══════════════════════════════════════════════════════
   PATCH — aggiornamenti minimi senza re-render completo
   ═══════════════════════════════════════════════════════ */
function patchEntity(id) {
  const s = S[id]; if (!s) return;
  const val = s.state;

  // Entities che richiedono re-render completo della vista corrente
  const fullRerender = {
    home:          ['person.lorenzo','person.raffaele','climate.sala','climate.soppalco','weather.meteo_casa'],
    automazioni:   ['switch.sonoff_s60zbtpf','climate.sala','climate.soppalco','switch.sala_nanoe','switch.soppalco_nanoe','sensor.primo_piano_b_umidita','sensor.termostato_camera_da_letto_umidita','switch.presa_parentesi','sensor.ipad_battery_level','automation.clima_salfara_controllo_intelligente','automation.parentesi_tramonto_spegni_all_1_00','automation.ricarica_ipad','input_number.vmc_soglia_spegnimento','input_number.vmc_soglia_accensione','input_number.clima_dry_off','input_number.clima_dry_on','input_number.ipad_soglia_ricarica','input_number.ipad_soglia_stop'],
    impostazioni:  Object.keys(S).filter(k => k.startsWith('input_')),
  };

  if (fullRerender[currentView]?.includes(id)) {
    renderCurrentView(); return;
  }

  // Patch selettivi per elementi sempre visibili
  patch(id, val, s.attributes || {});
}

function patch(id, val, attr) {
  const v = parseFloat(val) || 0;

  // ── Entità sempre visibili in qualsiasi vista ──
  setText(`clock-time`,  null); // gestito da startClock
  patchIfExists(`tramonto`, id === 'sensor.sun_next_setting' ? fmtTime(val) : null);

  switch(id) {
    // Presenza
    case 'person.lorenzo':  patchPresenza('lorenzo', val); break;
    case 'person.raffaele': patchPresenza('raffaele', val); break;

    // Meteo
    case 'weather.meteo_casa': patchMeteo(val, attr); break;

    // Temperature home
    case 'sensor.piano_terra_a_temperatura': setText('temp-soggiorno', fmtFloat(val)+'°C'); break;
    case 'sensor.primo_piano':               setText('temp-piano',     fmtFloat(val)+'°C'); break;

    // Split home badges
    case 'climate.sala':
      setText('temp-sala',    fmtFloat(attr.current_temperature)+'°C');
      setText('modo-sala',    modeLabel(val));
      setStyle('modo-sala', 'color', modeColor(val));
      patchSplitClima('sala', val, attr);
      break;
    case 'climate.soppalco':
      setText('temp-soppalco', fmtFloat(attr.current_temperature)+'°C');
      setText('modo-soppalco', modeLabel(val));
      setStyle('modo-soppalco', 'color', modeColor(val));
      patchSplitClima('soppalco', val, attr);
      break;

    // Batterie
    case 'sensor.iphone_di_lorenzo_battery_level':
      setText('lore-batt',   val+'%');
      setText('lorenzo-info', val+'%');
      break;
    case 'sensor.iphone_di_raffaele_battery_level':
      setText('raffa-batt',   val+'%');
      setText('raffaele-info', val+'%');
      break;
    case 'sensor.ipad_battery_level':
      setText('ipad-batt', Math.round(v)+'%');
      patchIpadBatt(v);
      break;

    // Rete
    case 'sensor.internetgatewaydevicev2_fritz_box_5690_pro_velocita_di_scaricamento':
      setText('download', fmtSpeed(val)); break;
    case 'sensor.internetgatewaydevicev2_fritz_box_5690_pro_velocita_di_caricamento':
      setText('upload', fmtSpeed(val)); break;
    case 'binary_sensor.internetgatewaydevicev2_fritz_box_5690_pro_stato_della_wan':
      patchWan(val); break;
    case 'binary_sensor.remote_ui':
      setText('cloud-stato', val==='on'?'Online':'Offline');
      setClass('cloud-stato', val==='on'?'val sm stato-on-green':'val sm stato-on-red');
      break;

    // Growatt
    case 'sensor.growatt_pv_potenza_totale':  setText('pv-power',   fmtW(val)); break;
    case 'sensor.growatt_batteria_soc':       patchBattSoc(v); break;
    case 'sensor.growatt_carico_locale':      setText('home-load',  fmtW(val)); break;
    case 'sensor.growatt_potenza_da_rete':    setText('grid-power', fmtW(val)); break;

    // Elettrodomestici home
    case 'sensor.forno_stato_di_funzionamento':       patchAppl('forno',    val); break;
    case 'sensor.lavastoviglie_stato_di_funzionamento':patchAppl('lavast',  val); break;
    case 'sensor.lavabiancheria_stato':               patchAppl('lavatrice',val); break;
    case 'number.congelatore_temperatura_del_congelatore':
      setText('congel-temp', Math.round(v)+'°C');
      congelTemp = Math.round(v);
      break;

    // TV
    case 'media_player.koso':
      patchTV('koso', val); break;
    case 'media_player.tv_salotto':
      patchTV('salotto', val); break;

    // Nanoe toggle clima
    case 'switch.sala_nanoe':    setToggle('tog-sala-nanoe',   val==='on'); break;
    case 'switch.sala_econavi':  setToggle('tog-sala-econavi', val==='on'); break;
    case 'switch.sala_iauto_x':  setToggle('tog-sala-iauto',   val==='on'); break;
    case 'switch.sala_ai_eco':   setToggle('tog-sala-aieco',   val==='on'); break;
    case 'switch.soppalco_nanoe':   setToggle('tog-sopp-nanoe',   val==='on'); break;
    case 'switch.soppalco_econavi': setToggle('tog-sopp-econavi', val==='on'); break;
    case 'switch.soppalco_iauto_x': setToggle('tog-sopp-iauto',   val==='on'); break;
    case 'switch.soppalco_ai_eco':  setToggle('tog-sopp-aieco',   val==='on'); break;

    // VMC
    case 'switch.sonoff_s60zbtpf':
      setToggle('tog-vmc-override', val==='on');
      setToggle('tog-vmc-home',     val==='on');
      setText('vmc-home-stato', val==='on'?'Accesa':'Spenta');
      break;

    // Luci
    case 'switch.presa_parentesi':
      setToggle('tog-parentesi-home', val==='on');
      setStyle('tog-parentesi-home', 'background', val==='on'?'#D97706':'');
      break;
  }
}

/* ═══════════════════════════════════════════════════════
   PATCH HELPERS
   ═══════════════════════════════════════════════════════ */
function patchPresenza(who, val) {
  const home = val === 'home';
  const el   = document.getElementById(`${who}-stato`);
  if (!el) return;
  el.textContent = '● ' + (home ? 'In casa' : 'Fuori casa');
  el.style.color = home ? '#22C55E' : '#9CA3AF';
  el.style.animation = home ? 'dot-blink 2s ease-in-out infinite' : 'none';
}

function patchMeteo(val, attr) {
  const icons   = { sunny:'☀️', 'clear-night':'🌙', cloudy:'☁️', partlycloudy:'⛅', rainy:'🌧️', snowy:'❄️', fog:'🌫️', windy:'🌬️', lightning:'⛈️', pouring:'🌧️' };
  const labels  = { sunny:'Soleggiato', 'clear-night':'Sereno', cloudy:'Nuvoloso', partlycloudy:'Parz. nuvoloso', rainy:'Pioggia', snowy:'Neve', fog:'Nebbia', windy:'Ventoso', lightning:'Temporale', pouring:'Pioggia forte' };
  setText('meteo-icon', icons[val] || '🌡️');
  setText('meteo-temp', (attr.temperature || '--') + '°');
  const hum = S['sensor.piano_terra_a_umidita']?.state || '--';
  setText('meteo-cond', `${labels[val]||val} · ${hum}% umid.`);
}

function patchWan(val) {
  const on = val === 'on';
  setText('wan-stato', on ? 'Online' : 'Offline');
  setClass('wan-stato', 'val sm ' + (on ? 'stato-on-green' : 'stato-on-red'));
  const card = document.getElementById('card-wan');
  if (card) card.className = 'card ' + (on ? 'accent-green' : 'accent-orange');
}

function patchBattSoc(pct) {
  setText('batt-soc', Math.round(pct) + '%');
  const c = pct > 60 ? '#22C55E' : pct > 30 ? '#F59E0B' : '#EF4444';
  const fill = document.getElementById('soc-fill');
  if (fill) { fill.style.width = pct + '%'; fill.style.background = `linear-gradient(90deg,${c},${c}99)`; }
}

function patchAppl(key, val) {
  const on = val === 'In funzione';
  const badge = document.getElementById(`${key}-badge`);
  if (!badge) return;
  badge.textContent = on ? 'In funzione' : (val || 'Inattivo');
  const styles = { forno:'stato-orange', lavast:'stato-teal', lavatrice:'stato-purple' };
  badge.className = 'appl-stato ' + (on ? styles[key] : 'stato-off');
  const btn = document.getElementById(`btn-${key}`);
  if (btn) btn.className = 'appl-btn' + (on ? ` active-${key}` : '');
}

function patchTV(key, val) {
  const on = val === 'on';
  const el = document.getElementById(`${key}-stato`);
  if (!el) return;
  el.textContent = on ? 'Acceso' : 'OFF';
  el.className = 'val sm ' + (on ? 'stato-on-purple' : 'stato-off');
}

function patchSplitClima(which, val, attr) {
  const suffix = which === 'sala' ? 'sala' : 'sopp';
  const color  = which === 'sala' ? '#2196F3' : '#8B5CF6';
  const t = attr.temperature || '--';

  setText(`target-${suffix}`,       t + '°');
  setText(`target-${suffix}-popup`, t + '°');
  setStyle(`split-temp-int-${which}`, 'color', color);
  setText(`temp-int-${suffix}`, fmtFloat(attr.current_temperature) + '°');

  // Modalità bottoni
  ['heat','cool','dry','fan','auto'].forEach(m => {
    const mKey = m === 'fan' ? 'fan_only' : m;
    const el = document.getElementById(`mode-${suffix}-${m}`);
    if (!el) return;
    const active = val === mKey;
    const colorMap = { cool:'m-blue', heat:'m-amber', dry:'m-purple', fan_only:'m-teal', auto:'m-amber' };
    el.className = 'mode-btn-clima ' + (active ? (colorMap[mKey] || 'm-blue') : 'm-off');
  });

  // Badge
  const badge = document.getElementById(`badge-${suffix}`);
  if (badge) {
    badge.textContent = modeLabel(val);
    badge.style.cssText = modeBadgeStyle(val);
  }
}

function patchIpadBatt(pct) {
  const c = pct < 20 ? '#EF4444' : pct > 80 ? '#F59E0B' : '#22C55E';
  const fill = document.getElementById('ipad-bar-fill');
  if (fill) { fill.style.width = pct + '%'; fill.style.background = c; }
  const pctEl = document.getElementById('ipad-batt-live');
  if (pctEl) { pctEl.textContent = Math.round(pct) + '%'; pctEl.style.color = c; }
}

/* ═══════════════════════════════════════════════════════
   DOM UTILITIES
   ═══════════════════════════════════════════════════════ */
function setText(id, val)  { if (val === null) return; const el = document.getElementById(id); if (el) el.textContent = val; }
function setClass(id, cls) { const el = document.getElementById(id); if (el) el.className = cls; }
function setStyle(id, prop, val) { const el = document.getElementById(id); if (el) el.style[prop] = val; }
function setToggle(id, on) { const el = document.getElementById(id); if (el) el.className = 'toggle-switch' + (on ? ' on' : ''); }
function patchIfExists(id, val) { if (val !== null) setText(id, val); }
function showEl(id, visible) { const el = document.getElementById(id); if (el) el.style.display = visible ? '' : 'none'; }

/* ═══════════════════════════════════════════════════════
   FORMATTERS
   ═══════════════════════════════════════════════════════ */
function fmtFloat(v, d=1) { const n = parseFloat(v); return isNaN(n) ? '--' : n.toFixed(d); }
function fmtW(v) { const n = parseFloat(v)||0; return n>=1000 ? (n/1000).toFixed(2)+' kW' : Math.round(n)+' W'; }
function fmtSpeed(v) { const n = parseFloat(v)||0; return n>=1000 ? (n/1000).toFixed(1)+' MiB/s' : n.toFixed(1)+' KiB/s'; }
function fmtTime(v) {
  if (!v || v==='unknown') return '--';
  try { const d=new Date(v); if(isNaN(d.getTime())) return '--'; return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0'); } catch { return '--'; }
}
function fmtDate(v) {
  if (!v || v==='unknown') return '--';
  try { const d=new Date(v); if(isNaN(d.getTime())) return '--'; return d.toLocaleDateString('it-IT',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch { return '--'; }
}
function cleanProgram(v) {
  if(!v||v==='unknown') return '--';
  return v.replace(/^dishcare_dishwasher_program_/,'').replace(/^dishwasher_/,'').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
}
function boolLabel(v, t='Sì', f='No') { return v==='on'?t:f; }

// Clima
const MLABELS = { cool:'❄ Freddo', heat:'🌡 Caldo', dry:'◎ Dry', fan_only:'⊙ Ventila', auto:'⚡ Auto', off:'○ Spento' };
const MCOLORS = { cool:'#2196F3', heat:'#EA580C', dry:'#8B5CF6', fan_only:'#0F766E', auto:'#F59E0B', off:'#9CA3AF' };
const MBADGE  = {
  cool: 'background:#DBEAFE;color:#1D4ED8', heat: 'background:#FEF3C7;color:#92400E',
  dry:  'background:#EDE9FE;color:#5B21B6', fan_only:'background:#CCFBF1;color:#0F766E',
  auto: 'background:#FEF3C7;color:#92400E', off: 'background:#F3F4F6;color:#6B7280',
};
function modeLabel(m)      { return MLABELS[m] || m; }
function modeColor(m)      { return MCOLORS[m] || '#9CA3AF'; }
function modeBadgeStyle(m) { return MBADGE[m]  || MBADGE.off; }

// Soglie configurabili
function getN(id, def) { return parseFloat(S[id]?.state) || def; }

/* ═══════════════════════════════════════════════════════
   OROLOGIO
   ═══════════════════════════════════════════════════════ */
let clockInterval;
function startClock() {
  clearInterval(clockInterval);
  updateClock();
  clockInterval = setInterval(updateClock, 1000);
}
function updateClock() {
  const now = new Date();
  const hh  = now.getHours().toString().padStart(2,'0');
  const mm  = now.getMinutes().toString().padStart(2,'0');
  const days   = ['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];
  const months = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  setText('clock-time', hh+':'+mm);
  setText('clock-date', days[now.getDay()].toUpperCase()+' '+now.getDate()+' '+months[now.getMonth()].toUpperCase());
  const h = now.getHours();
  const g = h<5?'Buonanotte':h<12?'Buongiorno':h<18?'Buon Pomeriggio':h<22?'Buonasera':'Buonanotte';
  setText('greeting', g+', Famiglia Salfara');
}

/* ═══════════════════════════════════════════════════════
   AZIONI COMUNI
   ═══════════════════════════════════════════════════════ */
function toggleSwitch(entity_id, btnId) {
  const on = S[entity_id]?.state === 'on';
  const el = document.getElementById(btnId);
  if (el) { el.className = 'toggle-switch' + (on ? '' : ' on'); el.disabled = true; setTimeout(()=>{ el.disabled=false; }, 4000); }
  callSvc('switch', on ? 'turn_off' : 'turn_on', { entity_id });
}
function setClimate(entity_id, mode) { callSvc('climate','set_hvac_mode',{entity_id,hvac_mode:mode}); }
function toggleAutomation(entity_id, btnId) {
  const on = S[entity_id]?.state === 'on';
  callSvc('automation', on?'turn_off':'turn_on', {entity_id});
}
function triggerAutomation(entity_id) { callSvc('automation','trigger',{entity_id}); }
function sendRemote(entity_id, command) { callSvc('remote','send_command',{entity_id,command:[command]}); }
function toggleBoolean(entity_id, btnId, alertId) {
  const on = S[entity_id]?.state === 'on';
  callSvc('input_boolean', on?'turn_off':'turn_on', {entity_id});
  const el = document.getElementById(btnId);
  if (el) el.className = 'toggle-switch' + (on ? '' : ' on');
  if (alertId) { const al = document.getElementById(alertId); if(al) al.className = 'bypass-alert' + (on ? '' : ' visible'); }
  showToast();
}
function setModalita(val) {
  callSvc('input_select','select_option',{entity_id:'input_select.modalita_casa',option:val});
  updateModalitaBtns(val);
  showToast();
}
function saveSlider(entity, value) { callSvc('input_number','set_value',{entity_id:entity,value:parseFloat(value)}); showToast(); }
function saveTime(entity, value)   { callSvc('input_datetime','set_datetime',{entity_id:entity,time:value+':00'}); showToast(); }
function adjustTarget(which, delta) {
  const entity = `climate.${which}`;
  const cur    = parseFloat(S[entity]?.attributes?.temperature) || 22;
  const newT   = Math.round((cur + delta) * 2) / 2;
  callSvc('climate','set_temperature',{entity_id:entity,temperature:newT});
}
function adjustCongel(d) {
  congelTemp = Math.min(-10, Math.max(-30, congelTemp + d));
  setText('congel-setpoint', congelTemp + '°C');
  callSvc('number','set_value',{entity_id:'number.congelatore_temperatura_del_congelatore',value:congelTemp});
}
function adjustForno(d) {
  fornoTemp = Math.min(300, Math.max(30, fornoTemp + d));
  setText('forno-setpoint', fornoTemp + '°C');
  callSvc('number','set_value',{entity_id:'number.forno_setpoint_temperature',value:fornoTemp});
}
function avviaForno() {
  const sel = document.getElementById('forno-prog-select');
  if (!sel?.value) { alert('Seleziona prima un programma'); return; }
  callSvc('select','select_option',{entity_id:'select.forno_programma_selezionato',option:sel.value});
  setTimeout(()=>callSvc('select','select_option',{entity_id:'select.forno_active_program',option:sel.value}),800);
}
function setFornoProgram(val) {
  if (!val) return;
  callSvc('select','select_option',{entity_id:'select.forno_programma_selezionato',option:val});
  setTimeout(()=>callSvc('select','select_option',{entity_id:'select.forno_active_program',option:val}),800);
}
function setLavastProgram(val) {
  if (!val) return;
  callSvc('select','select_option',{entity_id:'select.lavastoviglie_programma_selezionato',option:val});
}
function toggleVMC() {
  const on = S['switch.sonoff_s60zbtpf']?.state === 'on';
  if (!on && !confirm('Vuoi forzare l\'accensione della VMC?\n\nAttenzione: l\'automazione clima potrebbe spegnerla se la temperatura supera la soglia.')) return;
  callSvc('switch', on?'turn_off':'turn_on', {entity_id:'switch.sonoff_s60zbtpf'});
}

function openPopup(id)  { const el=document.getElementById('popup-'+id); if(el) el.classList.add('open'); }
function closePopup(id) { const el=document.getElementById('popup-'+id); if(el) el.classList.remove('open'); }
function closeOnOverlay(e, id) { if(e.target===e.currentTarget) closePopup(id); }

function showToast() {
  const t = document.getElementById('save-toast');
  if (!t) return;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1500);
}

/* ═══════════════════════════════════════════════════════
   IMPOSTAZIONI — Slider sync
   ═══════════════════════════════════════════════════════ */
function updateSlider(key, unit, entity, showPlus=false) {
  const sl  = document.getElementById('sl-'+key);
  const lbl = document.getElementById('val-'+key);
  if (!sl || !lbl) return;
  const v = parseFloat(sl.value);
  lbl.textContent = (showPlus && v > 0 ? '+' : '') + v + unit;
}
function syncAllSliders() {
  const map = [
    ['sl-vmc-off',  'val-vmc-off',  'input_number.vmc_soglia_spegnimento',  '°C'],
    ['sl-vmc-on',   'val-vmc-on',   'input_number.vmc_soglia_accensione',   '°C'],
    ['sl-target',   'val-target',   'input_number.clima_temp_target',       '°C'],
    ['sl-cool',     'val-cool',     'input_number.clima_soglia_raffreddamento','°C'],
    ['sl-heat',     'val-heat',     'input_number.clima_soglia_riscaldamento','°C'],
    ['sl-estate',   'val-estate',   'input_number.clima_soglia_estate',     '°C'],
    ['sl-inverno',  'val-inverno',  'input_number.clima_soglia_inverno',    '°C'],
    ['sl-dry-on',   'val-dry-on',   'input_number.clima_dry_on',            '%'],
    ['sl-dry-off',  'val-dry-off',  'input_number.clima_dry_off',           '%'],
    ['sl-ipad-low', 'val-ipad-low', 'input_number.ipad_soglia_ricarica',    '%'],
    ['sl-ipad-high','val-ipad-high','input_number.ipad_soglia_stop',        '%'],
    ['sl-offset',   'val-offset',   'input_number.parentesi_offset_tramonto',' min', true],
  ];
  map.forEach(([slId, valId, entity, unit, plus]) => {
    const v = parseFloat(S[entity]?.state);
    if (isNaN(v)) return;
    const sl = document.getElementById(slId); if (sl) sl.value = v;
    const lbl = document.getElementById(valId); if (lbl) lbl.textContent = (plus&&v>0?'+':'')+v+unit;
  });
  // Time picker
  const tp = document.getElementById('tp-parentesi');
  const tv = S['input_datetime.parentesi_orario_spegnimento']?.state;
  if (tp && tv) tp.value = tv.substring(0, 5);
  // Modalità casa
  const mv = S['input_select.modalita_casa']?.state;
  if (mv) updateModalitaBtns(mv);
  // Bypass toggles
  setToggle('tog-bypass-clima', S['input_boolean.bypass_clima']?.state === 'on');
  setToggle('tog-bypass-ipad',  S['input_boolean.bypass_ipad']?.state  === 'on');
}

function updateModalitaBtns(val) {
  ['auto','manuale','vacanza'].forEach(m => {
    const btn = document.getElementById('mode-'+m);
    if (btn) btn.className = 'mode-btn';
  });
  const map = {'Auto':'auto','Manuale':'manuale','Vacanza':'vacanza'};
  const key = map[val];
  if (key) { const btn = document.getElementById('mode-'+key); if(btn) btn.className = `mode-btn active-${key}`; }
  const alert = document.getElementById('alert-modalita');
  if (alert) alert.className = 'bypass-alert' + (val !== 'Auto' ? ' visible' : '');
}

/* ═══════════════════════════════════════════════════════
   STATISTICHE — Chart.js
   ═══════════════════════════════════════════════════════ */
function destroyAllCharts() {
  Object.values(chartInstances).forEach(c => { try { c.destroy(); } catch {} });
  chartInstances = {};
}
async function fetchHistory(entityId, days) {
  const end   = new Date();
  const start = new Date(end - days * 86400000);
  const url   = `${HA_BASE}/api/history/period/${start.toISOString()}?filter_entity_id=${entityId}&end_time=${end.toISOString()}&minimal_response=true&no_attributes=true`;
  const res   = await fetch(url, { headers: { Authorization: `Bearer ${HA_TOKEN}` } });
  if (!res.ok) return [];
  const data  = await res.json();
  return data[0] || [];
}
async function fetchHistoryMulti(ids, days) {
  const end   = new Date();
  const start = new Date(end - days * 86400000);
  const url   = `${HA_BASE}/api/history/period/${start.toISOString()}?filter_entity_id=${ids.join(',')}&end_time=${end.toISOString()}&minimal_response=true&no_attributes=true`;
  const res   = await fetch(url, { headers: { Authorization: `Bearer ${HA_TOKEN}` } });
  if (!res.ok) return [];
  return await res.json();
}
function parseStates(states) {
  return (states||[]).filter(s=>s.state!=='unavailable'&&s.state!=='unknown').map(s=>({x:new Date(s.last_changed),y:parseFloat(s.state)})).filter(p=>!isNaN(p.y));
}
function resample(pts, max=100) {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  return pts.filter((_,i)=>i%step===0);
}
function lineDataset(label, data, color, fill=false) {
  return { label, data, borderColor:color, backgroundColor:fill?color+'22':'transparent', borderWidth:1.8, pointRadius:0, pointHoverRadius:4, tension:0.4, fill };
}
function baseOpts(unit='') {
  return {
    responsive:true, maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{display:true,position:'top',labels:{boxWidth:10,padding:12,font:{size:11}}},
      tooltip:{backgroundColor:'white',titleColor:'#111827',bodyColor:'#6B7280',borderColor:'rgba(0,0,0,0.1)',borderWidth:1,padding:10,callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1)}${unit}`}}
    },
    scales:{
      x:{type:'time',time:{tooltipFormat:'dd MMM HH:mm',displayFormats:{hour:'HH:mm',day:'dd MMM'}},grid:{color:'rgba(0,0,0,0.04)'},ticks:{maxTicksLimit:8}},
      y:{grid:{color:'rgba(0,0,0,0.04)'},ticks:{callback:v=>v.toFixed(1)+unit}}
    }
  };
}

let currentStatsDays = 1;
function setPeriod(days, btn) {
  currentStatsDays = days;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  destroyAllCharts();
  loadAllCharts(days);
}

async function loadAllCharts(days) {
  const loaders = [
    ['solare',   loadChart,      ['sensor.growatt_energia_prodotta_oggi',           days, 'Produzione solare', '#F59E0B', true]],
    ['batt',     loadChart,      ['sensor.growatt_batteria_soc',                    days, 'SOC Batteria',       '#22C55E', true]],
    ['temp',     loadMultiChart, [['sensor.piano_terra_a_temperatura','sensor.primo_piano','sensor.termostato_camera_da_letto_temperatura'], days, ['Soggiorno','1° Piano','Camera'], ['#FF6B35','#22C55E','#2196F3']]],
    ['umid',     loadMultiChart, [['sensor.piano_terra_a_umidita','sensor.primo_piano_b_umidita','sensor.termostato_camera_da_letto_umidita'], days, ['Soggiorno','1° Piano','Camera'], ['#FF6B35','#22C55E','#2196F3']]],
    ['cucina',   loadMultiChart, [['sensor.consumo_stimato_forno','sensor.consumo_stimato_piano_cottura'], days, ['Forno','Piano cottura'], ['#EA580C','#DC2626']]],
    ['lavaggio', loadMultiChart, [['sensor.consumo_stimato_lavastoviglie','sensor.consumo_stimato_lavatrice'], days, ['Lavastoviglie','Lavatrice'], ['#0F766E','#7C3AED']]],
    ['prese',    loadMultiChart, [['sensor.sonoff_s60zbtpf_potenza','sensor.presa_shuko_smart_potenza'], days, ['VMC (reale)','Presa Shuko (reale)'], ['#6B7280','#F59E0B']]],
    ['rete',     loadMultiChart, [['sensor.growatt_potenza_da_rete','sensor.growatt_potenza_verso_rete'], days, ['Prelevata','Ceduta'], ['#EF4444','#22C55E']]],
    ['sala',     loadMultiChart, [['sensor.sala_daily_heating_energy','sensor.sala_daily_cooling_energy'], days, ['Riscaldamento','Raffreddamento'], ['#EA580C','#2196F3']]],
    ['sopp',     loadMultiChart, [['sensor.soppalco_daily_heating_energy','sensor.soppalco_daily_cooling_energy'], days, ['Riscaldamento','Raffreddamento'], ['#8B5CF6','#60A5FA']]],
  ];
  await Promise.all(loaders.map(([id, fn, args]) => fn(id, ...args)));
}

async function loadChart(id, entity, days, label, color, fill=false) {
  const canvas = document.getElementById('chart-'+id);
  const loader = document.getElementById('load-'+id);
  if (!canvas) return;
  const data = await fetchHistory(entity, days);
  const pts  = resample(parseStates(data));
  if (loader) loader.style.display = 'none';
  canvas.style.display = 'block';
  if (chartInstances[id]) chartInstances[id].destroy();
  chartInstances[id] = new Chart(canvas.getContext('2d'), { type:'line', data:{datasets:[lineDataset(label,pts,color,fill)]}, options:baseOpts() });
}

async function loadMultiChart(id, entities, days, labels, colors) {
  const canvas = document.getElementById('chart-'+id);
  const loader = document.getElementById('load-'+id);
  if (!canvas) return;
  const all  = await fetchHistoryMulti(entities, days);
  const datasets = entities.map((_, i) => lineDataset(labels[i], resample(parseStates(all[i]||[])), colors[i]));
  if (loader) loader.style.display = 'none';
  canvas.style.display = 'block';
  if (chartInstances[id]) chartInstances[id].destroy();
  chartInstances[id] = new Chart(canvas.getContext('2d'), { type:'line', data:{datasets}, options:baseOpts() });
}

/* ═══════════════════════════════════════════════════════
   FORNO — programmi
   ═══════════════════════════════════════════════════════ */
const FORNO_PROGRAMMI = [
  {val:'90 Watt',label:'90 Watt'},{val:'180 Watt',label:'180 Watt'},{val:'360 Watt',label:'360 Watt'},
  {val:'600 Watt',label:'600 Watt'},{val:'Max',label:'Potenza massima'},{val:'Hot air',label:'Aria calda'},
  {val:'Top bottom heating',label:'Riscaldamento sopra/sotto'},{val:'Top bottom heating eco',label:'Sopra/sotto ECO'},
  {val:'Hot air grilling',label:'Grill con aria calda'},{val:'Pizza setting',label:'Programma pizza'},
  {val:'Special heat-up for frozen products',label:'Prodotti surgelati'},{val:'Intensive heat',label:'Calore intensivo'},
  {val:'Slow cook',label:'Cottura lenta'},{val:'Desiccation',label:'Essiccazione'},
  {val:'Bottom heating',label:'Riscaldamento basso'},{val:'Keep warm',label:'Mantenimento calore'},
  {val:'Preheat ovenware',label:'Preriscaldo teglie'},{val:'Pre-heating',label:'Pre-riscaldamento'},
];
const LAVAST_PROGRAMMI = [
  {val:'Eco 50°C',label:'Eco 50°C'},{val:'Auto 2',label:'Auto 2'},{val:'Intensive 70°C',label:'Intensivo 70°C'},
  {val:'Speed 60°C',label:'Rapido 60°C'},{val:'Night wash',label:'Lavaggio notturno'},{val:'Machine care',label:'Pulizia macchina'},
  {val:'Pre-rinse',label:'Pre-risciacquo'},{val:'Super 60°C',label:'Super 60°C'},{val:'Intensive power',label:'Potenza intensiva'},
  {val:'Glass 40°C',label:'Delicati/Cristalli 40°C'},{val:'Quick 45°C',label:'Rapido 45°C'},{val:'Mixed load',label:'Carico misto'},
];
function fornoSelect() {
  const cur = S['select.forno_programma_selezionato']?.state || '';
  return `<select id="forno-prog-select" onchange="setFornoProgram(this.value)" style="border:1px solid #E5E7EB;border-radius:10px;padding:6px 10px;font-size:12px;color:#374151;background:white;cursor:pointer;max-width:220px;">
    <option value="">-- Seleziona --</option>
    ${FORNO_PROGRAMMI.map(p=>`<option value="${p.val}"${p.val===cur?' selected':''}>${p.label}</option>`).join('')}
  </select>`;
}
function lavastSelect() {
  const cur = S['select.lavastoviglie_programma_selezionato']?.state || '';
  return `<select id="lavast-prog-select" onchange="setLavastProgram(this.value)" style="border:1px solid #E5E7EB;border-radius:10px;padding:6px 10px;font-size:12px;color:#374151;background:white;cursor:pointer;max-width:220px;">
    <option value="">-- Seleziona --</option>
    ${LAVAST_PROGRAMMI.map(p=>`<option value="${p.val}"${p.val===cur?' selected':''}>${p.label}</option>`).join('')}
  </select>`;
}

/* ═══════════════════════════════════════════════════════
   VIEWS — ogni funzione ritorna HTML string
   ═══════════════════════════════════════════════════════ */

// ── VIEW: HOME ────────────────────────────────────────
function home() {
  const lor = S['person.lorenzo']?.state;
  const raf = S['person.raffaele']?.state;
  const lorHome = lor === 'home';
  const rafHome = raf === 'home';
  const lorBatt = S['sensor.iphone_di_lorenzo_battery_level']?.state || '--';
  const rafBatt = S['sensor.iphone_di_raffaele_battery_level']?.state || '--';
  const ipadBatt= S['sensor.ipad_battery_level']?.state || '--';
  const sunset  = fmtTime(S['sensor.sun_next_setting']?.state);

  const meteoVal  = S['weather.meteo_casa']?.state || '';
  const meteoAttr = S['weather.meteo_casa']?.attributes || {};
  const meteoIcons= { sunny:'☀️','clear-night':'🌙',cloudy:'☁️',partlycloudy:'⛅',rainy:'🌧️',snowy:'❄️',fog:'🌫️',windy:'🌬️',lightning:'⛈️',pouring:'🌧️' };
  const meteoLabels={ sunny:'Soleggiato','clear-night':'Sereno',cloudy:'Nuvoloso',partlycloudy:'Parz. nuvoloso',rainy:'Pioggia',snowy:'Neve',fog:'Nebbia',windy:'Ventoso',lightning:'Temporale',pouring:'Pioggia forte' };

  const hum = S['sensor.piano_terra_a_umidita']?.state || '--';
  const ts  = fmtFloat(S['sensor.piano_terra_a_temperatura']?.state) + '°C';
  const tp  = fmtFloat(S['sensor.primo_piano']?.state) + '°C';
  const ts2 = fmtFloat(S['climate.sala']?.attributes?.current_temperature) + '°C';
  const ts3 = fmtFloat(S['climate.soppalco']?.attributes?.current_temperature) + '°C';

  const pvW  = fmtW(S['sensor.growatt_pv_potenza_totale']?.state);
  const battS= Math.round(parseFloat(S['sensor.growatt_batteria_soc']?.state)||0);
  const battC= battS > 60 ? '#22C55E' : battS > 30 ? '#F59E0B' : '#EF4444';
  const homeL= fmtW(S['sensor.growatt_carico_locale']?.state);
  const gridW= fmtW(S['sensor.growatt_potenza_da_rete']?.state);

  const fornoSt = S['sensor.forno_stato_di_funzionamento']?.state || '--';
  const lavastSt= S['sensor.lavastoviglie_stato_di_funzionamento']?.state || '--';
  const lavSt   = S['sensor.lavabiancheria_stato']?.state || '--';
  const congelT = Math.round(parseFloat(S['number.congelatore_temperatura_del_congelatore']?.state)||0);

  const kosoOn = S['media_player.koso']?.state === 'on';
  const tvOn   = S['media_player.tv_salotto']?.state === 'on';
  const dl = fmtSpeed(S['sensor.internetgatewaydevicev2_fritz_box_5690_pro_velocita_di_scaricamento']?.state);
  const ul = fmtSpeed(S['sensor.internetgatewaydevicev2_fritz_box_5690_pro_velocita_di_caricamento']?.state);
  const wanOn   = S['binary_sensor.internetgatewaydevicev2_fritz_box_5690_pro_stato_della_wan']?.state === 'on';
  const cloudOn = S['binary_sensor.remote_ui']?.state === 'on';
  const vmc     = S['switch.sonoff_s60zbtpf']?.state;
  const vmcOn   = vmc === 'on';

  return `
<div style="padding:24px 28px 20px;">
  <div id="greeting" class="greeting">Buon Pomeriggio, Famiglia Salfara</div>
  <div style="display:grid;grid-template-columns:268px 1fr 1fr 268px;gap:10px;margin-top:10px;">

    <!-- COL 1 — IDENTITÀ -->
    <div class="col">
      <div class="clock-card">
        <div class="clock-time" id="clock-time">--:--</div>
        <div class="clock-date" id="clock-date"></div>
      </div>
      <div class="card" style="height:66px;display:flex;align-items:center;gap:12px;padding:0 14px;">
        <div style="width:34px;height:34px;border-radius:50%;background:#BFDBFE;color:#1D4ED8;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;">L</div>
        <div>
          <div style="font-size:14px;font-weight:600;color:#111827;">Lorenzo</div>
          <div id="lorenzo-stato" style="font-size:12px;font-weight:500;color:${lorHome?'#22C55E':'#9CA3AF'};">● ${lorHome?'In casa':'Fuori casa'}</div>
          <div style="font-size:10px;color:#9CA3AF;" id="lorenzo-info">${lorBatt}%</div>
        </div>
      </div>
      <div class="card" style="height:66px;display:flex;align-items:center;gap:12px;padding:0 14px;">
        <div style="width:34px;height:34px;border-radius:50%;background:#FDE68A;color:#92400E;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;">R</div>
        <div>
          <div style="font-size:14px;font-weight:600;color:#111827;">Raffaele</div>
          <div id="raffaele-stato" style="font-size:12px;font-weight:500;color:${rafHome?'#22C55E':'#9CA3AF'};">● ${rafHome?'In casa':'Fuori casa'}</div>
          <div style="font-size:10px;color:#9CA3AF;" id="raffaele-info">${rafBatt}%</div>
        </div>
      </div>
      <div class="grid2">
        <div class="card"><div class="val sm" id="raffa-batt">${rafBatt}%</div><div class="lbl">Raffa</div></div>
        <div class="card"><div class="val sm" id="lore-batt">${lorBatt}%</div><div class="lbl">Lore</div></div>
      </div>
      <div class="grid2">
        <div class="card"><div class="val sm" id="ipad-batt">${ipadBatt}%</div><div class="lbl">iPad</div></div>
        <div class="card"><div class="val sm" id="tramonto" style="color:#8B5CF6;">${sunset}</div><div class="lbl">Tramonto</div></div>
      </div>
    </div>

    <!-- COL 2 — ENERGIA & METEO -->
    <div class="col">
      <div class="card" style="height:120px;display:flex;align-items:center;gap:16px;padding:0 18px;">
        <div style="font-size:48px;">${meteoIcons[meteoVal]||'🌡️'}</div>
        <div>
          <div style="font-size:34px;font-weight:700;color:#111827;line-height:1;" id="meteo-temp">${meteoAttr.temperature||'--'}°</div>
          <div style="font-size:13px;color:#6B7280;margin-top:4px;" id="meteo-cond">${meteoLabels[meteoVal]||meteoVal} · ${hum}% umid.</div>
        </div>
      </div>
      <div class="card" style="height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;">
        <div style="display:grid;grid-template-columns:1fr 60px 1fr;grid-template-rows:1fr 60px 1fr;gap:8px;width:200px;height:160px;align-items:center;justify-items:center;">
          <div></div>
          <div style="text-align:center;">
            <div style="font-size:10px;color:#9CA3AF;margin-bottom:2px;">Solare</div>
            <div style="width:48px;height:48px;border-radius:50%;border:2px solid #F59E0B;display:flex;align-items:center;justify-content:center;background:white;">
              <div style="font-size:9px;font-weight:700;color:#F59E0B;" id="pv-power">${pvW}</div>
            </div>
          </div>
          <div></div>
          <div style="text-align:center;">
            <div style="font-size:10px;color:#9CA3AF;margin-bottom:2px;">Rete</div>
            <div style="width:48px;height:48px;border-radius:50%;border:2px solid #6B7280;display:flex;align-items:center;justify-content:center;background:white;">
              <div style="font-size:9px;font-weight:700;color:#6B7280;" id="grid-power">${gridW}</div>
            </div>
          </div>
          <div style="text-align:center;">
            <div style="width:54px;height:54px;border-radius:50%;border:3px solid #2196F3;display:flex;align-items:center;justify-content:center;background:white;box-shadow:0 2px 8px rgba(33,150,243,0.2);">
              <div style="text-align:center;"><div style="font-size:18px;">🏠</div><div style="font-size:9px;font-weight:700;color:#2196F3;" id="home-load">${homeL}</div></div>
            </div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:10px;color:#9CA3AF;margin-bottom:2px;">Batteria</div>
            <div style="width:48px;height:48px;border-radius:50%;border:2px solid ${battC};display:flex;align-items:center;justify-content:center;background:white;">
              <div style="font-size:9px;font-weight:700;color:${battC};" id="batt-soc">${battS}%</div>
            </div>
          </div>
          <div></div><div></div><div></div>
        </div>
      </div>
      <div class="grid3">
        <div class="card" style="height:80px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;" onclick="navigate('cucina')">
          <div style="width:36px;height:36px;border-radius:10px;background:#F0FDF4;display:flex;align-items:center;justify-content:center;font-size:18px;">🍳</div>
          <div style="font-size:12px;font-weight:500;color:#374151;">Cucina</div>
        </div>
        <div class="card" style="height:80px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;" onclick="navigate('clima')">
          <div style="width:36px;height:36px;border-radius:10px;background:#FFF7ED;display:flex;align-items:center;justify-content:center;font-size:18px;">🌡️</div>
          <div style="font-size:12px;font-weight:500;color:#C2410C;">Clima</div>
        </div>
        <div class="card" style="height:80px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;" onclick="navigate('consumi')">
          <div style="width:36px;height:36px;border-radius:10px;background:#FFFBEB;display:flex;align-items:center;justify-content:center;font-size:18px;">☀️</div>
          <div style="font-size:12px;font-weight:500;color:#92400E;">Energia</div>
        </div>
      </div>
      <div class="grid3">
        <div class="card" style="height:80px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;" onclick="navigate('automazioni')">
          <div style="width:36px;height:36px;border-radius:10px;background:#FAF5FF;display:flex;align-items:center;justify-content:center;font-size:18px;">🤖</div>
          <div style="font-size:12px;font-weight:500;color:#374151;">Auto.</div>
        </div>
        <div class="card" style="height:80px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;" onclick="navigate('statistiche')">
          <div style="width:36px;height:36px;border-radius:10px;background:#F0FDFA;display:flex;align-items:center;justify-content:center;font-size:18px;">📊</div>
          <div style="font-size:12px;font-weight:500;color:#374151;">Stats</div>
        </div>
        <div class="card" style="height:80px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;cursor:pointer;" onclick="navigate('sistema')">
          <div style="width:36px;height:36px;border-radius:10px;background:#F8FAFC;display:flex;align-items:center;justify-content:center;font-size:18px;">⚙️</div>
          <div style="font-size:12px;font-weight:500;color:#374151;">Sistema</div>
        </div>
      </div>
    </div>

    <!-- COL 3 — TEMPERATURA & CASA -->
    <div class="col">
      <div class="grid2">
        <div class="card accent-orange"><div class="val" id="temp-soggiorno">${ts}</div><div class="lbl">Soggiorno</div><div class="sub">${hum}% umid.</div></div>
        <div class="card accent-green"><div class="val" id="temp-piano">${tp}</div><div class="lbl">1° Piano</div></div>
        <div class="card accent-blue clickable" onclick="navigate('clima')"><div class="val" id="temp-sala">${ts2}</div><div class="lbl">Split Sala</div><div class="sub" id="modo-sala" style="color:${modeColor(S['climate.sala']?.state)};">${modeLabel(S['climate.sala']?.state||'off')}</div></div>
        <div class="card accent-purple clickable" onclick="navigate('clima')"><div class="val" id="temp-soppalco">${ts3}</div><div class="lbl">Soppalco</div><div class="sub" id="modo-soppalco" style="color:${modeColor(S['climate.soppalco']?.state)};">${modeLabel(S['climate.soppalco']?.state||'off')}</div></div>
      </div>
      <div class="section-label" style="background:rgba(0,0,0,0.05);border-radius:10px;padding:0 12px;height:36px;display:flex;align-items:center;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;">Elettrodomestici</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div class="card accent-orange clickable" id="card-forno" onclick="navigate('cucina')">
          <div class="val sm ${fornoSt==='In funzione'?'stato-on-red':'stato-off'}" id="forno-badge-main">${fornoSt==='In funzione'?'In funzione':'Inattivo'}</div>
          <div class="lbl">Forno</div>
        </div>
        <div class="card accent-teal clickable" id="card-lavast" onclick="navigate('cucina')">
          <div class="val sm ${lavastSt==='In funzione'?'stato-on-teal':'stato-off'}">${lavastSt==='In funzione'?'In funzione':'Inattivo'}</div>
          <div class="lbl">Lavast.</div>
        </div>
        <div class="card accent-purple clickable" id="card-lavatrice" onclick="navigate('cucina')">
          <div class="val sm ${lavSt==='In funzione'?'stato-on-purple':'stato-off'}">${lavSt==='In funzione'?'In funzione':'Inattivo'}</div>
          <div class="lbl">Lavatrice</div>
        </div>
        <div class="card accent-red clickable" onclick="navigate('cucina')">
          <div class="val sm ${S['sensor.piano_cottura_stato_di_funzionamento']?.state==='In funzione'?'stato-on-red':'stato-off'}">${S['sensor.piano_cottura_stato_di_funzionamento']?.state==='In funzione'?'In funzione':'Inattivo'}</div>
          <div class="lbl">Piano Cottura</div>
        </div>
        <div class="card accent-cyan clickable" onclick="navigate('cucina')">
          <div class="val sm" style="color:#0EA5E9;" id="congel-temp">${congelT}°C</div>
          <div class="lbl">Congelatore</div>
        </div>
      </div>
    </div>

    <!-- COL 4 — TV & RETE -->
    <div class="col">
      <div class="grid2">
        <div class="card accent-purple clickable" onclick="openPopup('koso')">
          <div class="val sm ${kosoOn?'stato-on-purple':'stato-off'}" id="koso-stato">${kosoOn?'Acceso':'OFF'}</div>
          <div class="lbl">KOSO</div>
        </div>
        <div class="card accent-purple clickable" onclick="openPopup('salotto')">
          <div class="val sm ${tvOn?'stato-on-purple':'stato-off'}" id="salotto-stato">${tvOn?'Acceso':'OFF'}</div>
          <div class="lbl">Salotto</div>
        </div>
      </div>
      <div class="card clickable" id="card-vmc-home" onclick="toggleVMC()" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;">
        <div>
          <div class="val sm" id="vmc-home-stato" style="color:${vmcOn?'#22C55E':'#EF4444'};">${vmcOn?'Accesa':'Spenta'}</div>
          <div class="lbl">VMC — Sonoff</div>
        </div>
        <button class="toggle-switch ${vmcOn?'on':''}" id="tog-vmc-home" style="pointer-events:none;"></button>
      </div>
      <div class="section-label" style="background:rgba(0,0,0,0.05);border-radius:10px;padding:0 12px;height:36px;display:flex;align-items:center;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;">Luci</div>
      <div class="card clickable" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;" onclick="toggleSwitch('switch.presa_parentesi','tog-parentesi-home')">
        <div>
          <div class="val sm" style="color:${S['switch.presa_parentesi']?.state==='on'?'#D97706':'#9CA3AF'};">${S['switch.presa_parentesi']?.state==='on'?'Accesa':'Spenta'}</div>
          <div class="lbl">Parentesi</div>
        </div>
        <button class="toggle-switch ${S['switch.presa_parentesi']?.state==='on'?'on':''}" id="tog-parentesi-home" style="pointer-events:none;"></button>
      </div>
      <div class="section-label" style="background:rgba(0,0,0,0.05);border-radius:10px;padding:0 12px;height:36px;display:flex;align-items:center;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;">Rete</div>
      <div class="grid2">
        <div class="card accent-blue"><div class="val sm" id="download">${dl}</div><div class="lbl">Download</div></div>
        <div class="card accent-blue"><div class="val sm" id="upload">${ul}</div><div class="lbl">Upload</div></div>
      </div>
      <div class="grid2">
        <div class="card ${wanOn?'accent-green':'accent-orange'}" id="card-wan">
          <div class="val sm ${wanOn?'stato-on-green':'stato-on-red'}" id="wan-stato">${wanOn?'Online':'Offline'}</div>
          <div class="lbl">WAN</div>
        </div>
        <div class="card ${cloudOn?'accent-green':'accent-orange'}">
          <div class="val sm ${cloudOn?'stato-on-green':'stato-on-red'}" id="cloud-stato">${cloudOn?'Online':'Offline'}</div>
          <div class="lbl">Cloud HA</div>
        </div>
      </div>
      <div class="section-label" style="background:rgba(0,0,0,0.05);border-radius:10px;padding:0 12px;height:36px;display:flex;align-items:center;font-size:11px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;">Sistema</div>
      <div class="grid2">
        <div class="card accent-gray clickable" onclick="navigate('sistema')">
          <div class="val xs" id="backup-stato">${S['sensor.backup_backup_manager_state']?.state||'--'}</div>
          <div class="lbl">Backup</div>
        </div>
        <div class="card accent-gray">
          <div class="val sm ${S['binary_sensor.rpi_power_status']?.state==='on'?'':'stato-on-red'}" id="rpi-stato">${S['binary_sensor.rpi_power_status']?.state==='on'?'Online':'Off'}</div>
          <div class="lbl">RPi</div>
        </div>
      </div>
    </div>
  </div>
</div>
${popupKoso()}
${popupSalotto()}`;
}

function popupKoso() {
  return `<div class="popup-overlay" id="popup-koso" onclick="closeOnOverlay(event,'koso')">
  <div class="popup-box"><div class="popup-header">
    <div class="popup-header-left"><div class="popup-hicon" style="background:#FAF5FF;">📺</div><div><div class="popup-title">KOSO</div></div></div>
    <button class="popup-close" onclick="closePopup('koso')">✕</button>
  </div><div class="popup-body">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
      <button onclick="callSvc('media_player','toggle',{entity_id:'media_player.koso'})" style="height:54px;border-radius:12px;background:#FEE2E2;color:#B91C1C;border:none;cursor:pointer;font-weight:600;">⏻ PWR</button>
      <button onclick="sendRemote('remote.koso','KEY_HOME')" style="height:54px;border-radius:12px;background:#f0f2f5;color:#374151;border:none;cursor:pointer;font-weight:600;">🏠 HOME</button>
      <button onclick="sendRemote('remote.koso','KEY_RETURN')" style="height:54px;border-radius:12px;background:#f0f2f5;color:#374151;border:none;cursor:pointer;font-weight:600;">← BACK</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
      <div></div><button onclick="sendRemote('remote.koso','KEY_UP')" style="height:54px;border-radius:12px;background:#f0f2f5;border:none;cursor:pointer;font-size:18px;">▲</button><div></div>
      <button onclick="sendRemote('remote.koso','KEY_LEFT')" style="height:54px;border-radius:12px;background:#f0f2f5;border:none;cursor:pointer;font-size:18px;">◀</button>
      <button onclick="sendRemote('remote.koso','KEY_ENTER')" style="height:52px;border-radius:26px;background:linear-gradient(135deg,#6D28D9,#8B5CF6);color:white;border:none;cursor:pointer;font-weight:700;font-size:15px;">OK</button>
      <button onclick="sendRemote('remote.koso','KEY_RIGHT')" style="height:54px;border-radius:12px;background:#f0f2f5;border:none;cursor:pointer;font-size:18px;">▶</button>
      <div></div><button onclick="sendRemote('remote.koso','KEY_DOWN')" style="height:54px;border-radius:12px;background:#f0f2f5;border:none;cursor:pointer;font-size:18px;">▼</button><div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;">
      <button onclick="callSvc('media_player','volume_down',{entity_id:'media_player.koso'})" style="height:54px;border-radius:12px;background:#f0f2f5;color:#374151;border:none;cursor:pointer;font-size:18px;">🔉</button>
      <button onclick="callSvc('media_player','volume_mute',{entity_id:'media_player.koso',is_volume_muted:true})" style="height:54px;border-radius:12px;background:#FEE2E2;color:#B91C1C;border:none;cursor:pointer;font-size:18px;">🔇</button>
      <button onclick="callSvc('media_player','volume_up',{entity_id:'media_player.koso'})" style="height:54px;border-radius:12px;background:#f0f2f5;color:#374151;border:none;cursor:pointer;font-size:18px;">🔊</button>
    </div>
  </div></div></div>`;
}

function popupSalotto() {
  return `<div class="popup-overlay" id="popup-salotto" onclick="closeOnOverlay(event,'salotto')">
  <div class="popup-box"><div class="popup-header">
    <div class="popup-header-left"><div class="popup-hicon" style="background:#FAF5FF;">📺</div><div><div class="popup-title">TV Salotto</div></div></div>
    <button class="popup-close" onclick="closePopup('salotto')">✕</button>
  </div><div class="popup-body">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
      <button onclick="callSvc('media_player','toggle',{entity_id:'media_player.tv_salotto'})" style="height:54px;border-radius:12px;background:#FEE2E2;color:#B91C1C;border:none;cursor:pointer;font-weight:600;">⏻ PWR</button>
      <button onclick="sendRemote('remote.tv_salotto','KEY_HOME')" style="height:54px;border-radius:12px;background:#f0f2f5;color:#374151;border:none;cursor:pointer;font-weight:600;">🏠 HOME</button>
      <button onclick="sendRemote('remote.tv_salotto','KEY_RETURN')" style="height:54px;border-radius:12px;background:#f0f2f5;color:#374151;border:none;cursor:pointer;font-weight:600;">← BACK</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
      <div></div><button onclick="sendRemote('remote.tv_salotto','KEY_UP')" style="height:54px;border-radius:12px;background:#f0f2f5;border:none;cursor:pointer;font-size:18px;">▲</button><div></div>
      <button onclick="sendRemote('remote.tv_salotto','KEY_LEFT')" style="height:54px;border-radius:12px;background:#f0f2f5;border:none;cursor:pointer;font-size:18px;">◀</button>
      <button onclick="sendRemote('remote.tv_salotto','KEY_ENTER')" style="height:52px;border-radius:26px;background:linear-gradient(135deg,#6D28D9,#8B5CF6);color:white;border:none;cursor:pointer;font-weight:700;font-size:15px;">OK</button>
      <button onclick="sendRemote('remote.tv_salotto','KEY_RIGHT')" style="height:54px;border-radius:12px;background:#f0f2f5;border:none;cursor:pointer;font-size:18px;">▶</button>
      <div></div><button onclick="sendRemote('remote.tv_salotto','KEY_DOWN')" style="height:54px;border-radius:12px;background:#f0f2f5;border:none;cursor:pointer;font-size:18px;">▼</button><div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;">
      <button onclick="callSvc('media_player','volume_down',{entity_id:'media_player.tv_salotto'})" style="height:54px;border-radius:12px;background:#f0f2f5;color:#374151;border:none;cursor:pointer;font-size:18px;">🔉</button>
      <button onclick="callSvc('media_player','volume_mute',{entity_id:'media_player.tv_salotto',is_volume_muted:true})" style="height:54px;border-radius:12px;background:#FEE2E2;color:#B91C1C;border:none;cursor:pointer;font-size:18px;">🔇</button>
      <button onclick="callSvc('media_player','volume_up',{entity_id:'media_player.tv_salotto'})" style="height:54px;border-radius:12px;background:#f0f2f5;color:#374151;border:none;cursor:pointer;font-size:18px;">🔊</button>
    </div>
  </div></div></div>`;
}

// ── VIEW PLACEHOLDER per le altre viste ──────────────
// Le viste cucina, clima, consumi, automazioni, statistiche, sistema, impostazioni
// sono troppo lunghe per un singolo messaggio — le aggiungiamo nel prossimo step
function cucina()      { return viewPlaceholder('cucina'); }
function clima()       { return viewPlaceholder('clima'); }
function consumi()     { return viewPlaceholder('consumi'); }
function automazioni() { return viewPlaceholder('automazioni'); }
function statistiche() { return viewPlaceholder('statistiche'); }
function sistema()     { return viewPlaceholder('sistema'); }
function impostazioni(){ return viewPlaceholder('impostazioni'); }

function viewPlaceholder(name) {
  return `<div style="padding:40px;text-align:center;color:#9CA3AF;">
    <div style="font-size:48px;margin-bottom:16px;">⚙️</div>
    <div style="font-size:18px;font-weight:700;color:#374151;margin-bottom:8px;">${name} — in caricamento</div>
    <div style="font-size:13px;">Le viste vengono aggiunte in salfara.js</div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  wsConnect();
  navigate('home');
});

/* ═══════════════════════════════════════════════════════
   VIEW: CUCINA
   ═══════════════════════════════════════════════════════ */
function cucina() {
  const forno   = { stato: S['sensor.forno_stato_di_funzionamento']?.state||'--', temp: S['sensor.forno_temperatura_del_forno_attuale']?.state||'--', fine: fmtTime(S['sensor.forno_orario_di_fine_del_programma']?.state), avanz: Math.round(parseFloat(S['sensor.forno_avanzamento_del_programma']?.state)||0), prog: S['select.forno_programma_selezionato']?.state||'--', activeProg: S['select.forno_active_program']?.state||'--', setpoint: Math.round(parseFloat(S['number.forno_setpoint_temperature']?.state)||180), porta: S['sensor.forno_porta']?.state||'--', light: S['binary_sensor.forno_interior_illumination_active']?.state==='on'?'Accesa':'Spenta', conn: S['binary_sensor.forno_connettivita']?.state==='on'?'Connessa':'Non connessa', remote: S['binary_sensor.forno_controllo_remoto']?.state==='on'?'Abilitato':'Disabilitato', remoteStart: S['binary_sensor.forno_avvio_remoto']?.state==='on'?'Pronto':'Non pronto', preheat: S['switch.forno_fast_pre_heat']?.state==='on', lock: S['switch.forno_blocco_bambini']?.state==='on', power: S['switch.forno_potenza']?.state==='on' };
  const piano   = { stato: S['sensor.piano_cottura_stato_di_funzionamento']?.state||'--', conn: S['binary_sensor.piano_cottura_controllo_locale']?.state==='on'?'Connesso':'Non connesso', power: S['switch.piano_cottura_potenza']?.state==='on', lock: S['switch.piano_cottura_blocco_bambini']?.state==='on' };
  const lavast  = { stato: S['sensor.lavastoviglie_stato_di_funzionamento']?.state||'--', fine: fmtTime(S['sensor.lavastoviglie_orario_di_fine_del_programma']?.state), avanz: Math.round(parseFloat(S['sensor.lavastoviglie_avanzamento_del_programma']?.state)||0), porta: S['sensor.lavastoviglie_porta']?.state||'--', remote: S['binary_sensor.lavastoviglie_controllo_remoto']?.state==='on'?'Abilitato':'Disabilitato', remoteStart: S['binary_sensor.lavastoviglie_avvio_remoto']?.state==='on'?'Pronto':'Non pronto', conn: S['binary_sensor.lavastoviglie_connettivita']?.state==='on'?'Connessa':'Non connessa', light: S['binary_sensor.lavastoviglie_interior_illumination_active']?.state==='on'?'Accesa':'Spenta', intense: S['switch.lavastoviglie_intensive_zone']?.state==='on', dry: S['switch.lavastoviglie_brilliance_dry']?.state==='on', speed: S['switch.lavastoviglie_vario_speed']?.state==='on', silence: S['switch.lavastoviglie_silence_on_demand']?.state==='on', half: S['switch.lavastoviglie_half_load']?.state==='on', hygiene: S['switch.lavastoviglie_hygiene']?.state==='on', power: S['switch.lavastoviglie_potenza']?.state==='on' };
  const lavatrice={ stato: S['sensor.lavabiancheria_stato']?.state||'--', prog: S['sensor.lavabiancheria_programma']?.state||'--', tipo: S['sensor.lavabiancheria_tipo_programma']?.state||'--', fase: S['sensor.lavabiancheria_fase_programma']?.state||'--', temp: S['sensor.lavabiancheria_temperatura_impostata']?.state||'--', rpm: S['sensor.lavabiancheria_centrifuga']?.state||'--', residuo: S['sensor.lavabiancheria_tempo_residuo']?.state, elapsed: S['sensor.lavabiancheria_tempo_trascorso']?.state, fine: fmtTime(S['sensor.lavabiancheria_ora_termine']?.state), start: fmtTime(S['sensor.lavabiancheria_ora_inizio']?.state), scheduled: fmtTime(S['sensor.lavabiancheria_ora_partenza_programmata']?.state), porta: S['binary_sensor.lavabiancheria_sportello']?.state==='on'?'Aperto':'Chiuso', portaOn: S['binary_sensor.lavabiancheria_sportello']?.state==='on', remote: S['binary_sensor.lavabiancheria_remote_control']?.state==='on'?'Abilitato':'Disabilitato', mobile: S['binary_sensor.lavabiancheria_mobilestart']?.state==='on'?'Attivo':'Non attivo', smart: S['binary_sensor.lavabiancheria_smart_grid']?.state==='on'?'Attivo':'Non attivo', info: S['binary_sensor.lavabiancheria_info']?.state==='on'?'Presente':'Nessuna', guasto: S['binary_sensor.lavabiancheria_guasto']?.state==='on', energia: S['sensor.lavabiancheria_consumo_energia']?.state, acqua: S['sensor.lavabiancheria_consumo_acqua']?.state, power: S['switch.lavabiancheria_accensione']?.state==='on' };
  const congel  = { temp: Math.round(parseFloat(S['number.congelatore_temperatura_del_congelatore']?.state)||0), porta: S['binary_sensor.congelatore_porta_del_congelatore']?.state==='on', conn: S['binary_sensor.congelatore_connettivita']?.state==='on'?'Connesso':'Non connesso', super: S['switch.congelatore_modalita_super_congelatore']?.state==='on', assistente: S['switch.congelatore_assistente_porta_del_congelatore']?.state==='on', power: S['switch.congelatore_potenza']?.state==='on' };
  fornoTemp = forno.setpoint; congelTemp = congel.temp;

  const tog = (id,on) => `<button class="toggle-switch${on?' on':''}" id="${id}" onclick="toggleSwitch('${id.replace('tog-','switch.').replace(/-([a-z])/g,(_,c)=>c.toUpperCase())}','${id}')"></button>`;
  const tr  = (l,v,cls='') => `<div class="info-row"><span class="il">${l}</span><span class="iv${cls?' '+cls:''}">${v}</span></div>`;
  const fornoOn = forno.stato==='In funzione'; const lavastOn = lavast.stato==='In funzione'; const lavOn = lavatrice.stato==='In funzione';

  return `
<div style="padding:20px 28px 16px;">
  <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:16px;">
    <div class="page-title">🍳 Cucina</div>
    <div class="col-label">Elettrodomestici</div>
  </div>
  <div class="grid5">

    <!-- FORNO -->
    <button class="appl-btn-fusion${fornoOn?' appl-fusion-active':''}" id="btn-forno" onclick="openPopup('forno')" style="--fusion-color:#EA580C;--fusion-bg:linear-gradient(135deg,#431407 0%,#7c2d12 50%,#9a3412 100%);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div class="appl-fusion-icon" style="background:rgba(234,88,12,0.25);">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><rect x="3" y="5" width="20" height="16" rx="3" stroke="#FB923C" stroke-width="1.5" fill="none"/><rect x="6" y="9" width="14" height="8" rx="1.5" stroke="#FB923C" stroke-width="1.2" fill="none"/><circle cx="8" cy="7.5" r="1" fill="#FB923C"/><circle cx="13" cy="7.5" r="1" fill="#FB923C"/><circle cx="18" cy="7.5" r="1" fill="#FB923C"/></svg>
        </div>
        <div class="appl-fusion-badge ${fornoOn?'badge-fusion-on':'badge-fusion-off'}">${fornoOn?'In funzione':'Inattivo'}</div>
      </div>
      <div class="appl-fusion-name">Forno</div>
      <div class="appl-fusion-brand">Siemens iQ700</div>
      <div class="appl-fusion-val" style="color:#FB923C;">${forno.temp}°C</div>
    </button>

    <!-- PIANO COTTURA -->
    <button class="appl-btn-fusion${piano.stato==='In funzione'?' appl-fusion-active':''}" id="btn-piano" onclick="openPopup('piano')" style="--fusion-color:#DC2626;--fusion-bg:linear-gradient(135deg,#450a0a 0%,#7f1d1d 50%,#991b1b 100%);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div class="appl-fusion-icon" style="background:rgba(220,38,38,0.25);">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><rect x="3" y="7" width="20" height="12" rx="3" stroke="#F87171" stroke-width="1.5" fill="none"/><circle cx="8.5" cy="13" r="2.5" stroke="#F87171" stroke-width="1.2" fill="none"/><circle cx="17.5" cy="13" r="2.5" stroke="#F87171" stroke-width="1.2" fill="none"/><circle cx="8.5" cy="13" r="0.8" fill="#F87171"/><circle cx="17.5" cy="13" r="0.8" fill="#F87171"/></svg>
        </div>
        <div class="appl-fusion-badge ${piano.stato==='In funzione'?'badge-fusion-on':'badge-fusion-off'}">${piano.stato==='In funzione'?'In funzione':'Inattivo'}</div>
      </div>
      <div class="appl-fusion-name">Piano Cottura</div>
      <div class="appl-fusion-brand">Siemens iQ700</div>
      <div class="appl-fusion-val" style="color:#F87171;">${piano.stato}</div>
    </button>

    <!-- LAVASTOVIGLIE -->
    <button class="appl-btn-fusion${lavastOn?' appl-fusion-active':''}" id="btn-lavast" onclick="openPopup('lavast')" style="--fusion-color:#0F766E;--fusion-bg:linear-gradient(135deg,#042f2e 0%,#134e4a 50%,#115e59 100%);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div class="appl-fusion-icon" style="background:rgba(20,184,166,0.25);">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><rect x="4" y="3" width="18" height="20" rx="3" stroke="#2DD4BF" stroke-width="1.5" fill="none"/><line x1="4" y1="8" x2="22" y2="8" stroke="#2DD4BF" stroke-width="1.2"/><circle cx="13" cy="15" r="4" stroke="#2DD4BF" stroke-width="1.2" fill="none"/><circle cx="13" cy="15" r="1.5" fill="#2DD4BF" opacity="0.5"/></svg>
        </div>
        <div class="appl-fusion-badge ${lavastOn?'badge-fusion-on':'badge-fusion-off'}">${lavastOn?'In funzione':'Inattivo'}</div>
      </div>
      <div class="appl-fusion-name">Lavastoviglie</div>
      <div class="appl-fusion-brand">Siemens</div>
      <div class="appl-fusion-val" style="color:#2DD4BF;">${lavastOn?lavast.avanz+'%':lavast.porta}</div>
    </button>

    <!-- LAVATRICE -->
    <button class="appl-btn-fusion${lavOn?' appl-fusion-active':''}" id="btn-lavatrice" onclick="openPopup('lavatrice')" style="--fusion-color:#7C3AED;--fusion-bg:linear-gradient(135deg,#2e1065 0%,#4c1d95 50%,#5b21b6 100%);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div class="appl-fusion-icon" style="background:rgba(139,92,246,0.25);">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><rect x="3" y="3" width="20" height="20" rx="3" stroke="#A78BFA" stroke-width="1.5" fill="none"/><circle cx="13" cy="14" r="5.5" stroke="#A78BFA" stroke-width="1.2" fill="none"/><circle cx="13" cy="14" r="2" fill="#A78BFA" opacity="0.4"/><circle cx="7" cy="7" r="1" fill="#A78BFA"/><circle cx="10" cy="7" r="1" fill="#A78BFA"/></svg>
        </div>
        <div class="appl-fusion-badge ${lavOn?'badge-fusion-on':'badge-fusion-off'}">${lavOn?'In funzione':'Inattivo'}</div>
      </div>
      <div class="appl-fusion-name">Lavatrice</div>
      <div class="appl-fusion-brand">Miele</div>
      <div class="appl-fusion-val" style="color:#A78BFA;">${lavatrice.residuo&&lavatrice.residuo!=='0'?lavatrice.residuo+' min':'--'}</div>
    </button>

    <!-- CONGELATORE -->
    <button class="appl-btn-fusion" id="btn-congel" onclick="openPopup('congel')" style="--fusion-color:#0284C7;--fusion-bg:linear-gradient(135deg,#082f49 0%,#0c4a6e 50%,#075985 100%);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div class="appl-fusion-icon" style="background:rgba(14,165,233,0.25);">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><rect x="4" y="2" width="18" height="22" rx="3" stroke="#38BDF8" stroke-width="1.5" fill="none"/><line x1="4" y1="12" x2="22" y2="12" stroke="#38BDF8" stroke-width="1.2"/><path d="M13 5L13 9M13 15L13 19" stroke="#38BDF8" stroke-width="1" stroke-linecap="round"/></svg>
        </div>
        <div class="appl-fusion-badge badge-fusion-blue">Attivo</div>
      </div>
      <div class="appl-fusion-name">Congelatore</div>
      <div class="appl-fusion-brand">Miele</div>
      <div class="appl-fusion-val" id="congel-temp-main" style="color:#38BDF8;font-size:22px;">${congel.temp}°C</div>
    </button>

  </div>
</div>

<!-- POPUP FORNO -->
<div class="popup-overlay" id="popup-forno" onclick="closeOnOverlay(event,'forno')">
  <div class="popup-box"><div class="popup-header">
    <div class="popup-header-left"><div class="popup-hicon" style="background:#FFF7ED;"><svg width="24" height="24" viewBox="0 0 26 26" fill="none"><rect x="3" y="5" width="20" height="16" rx="3" stroke="#EA580C" stroke-width="1.5" fill="none"/><rect x="6" y="9" width="14" height="8" rx="1.5" stroke="#EA580C" stroke-width="1.2" fill="none"/></svg></div><div><div class="popup-title">Forno</div><div class="popup-brand">Siemens iQ700</div></div></div>
    <button class="popup-close" onclick="closePopup('forno')">✕</button>
  </div><div class="popup-body">
    ${tr('Stato',forno.stato,fornoOn?'iv-orange':'')}
    ${tr('Temperatura attuale',forno.temp+'°C',parseFloat(forno.temp)>50?'iv-orange':'')}
    ${tr('Porta',forno.porta)}
    ${tr('Fine programma',forno.fine)}
    ${tr('Avanzamento',forno.avanz+'%')}
    <div class="progress-bar"><div class="progress-fill" style="width:${forno.avanz}%;background:#FF6B35;"></div></div>
    <div class="popup-section"><div class="popup-section-title">Programma</div>
      <div class="select-row"><span class="il">Programma</span>${fornoSelect()}</div>
      ${tr('Programma attivo',forno.activeProg)}
      <div class="info-row"><span class="il">Temperatura impostata</span>
        <div style="display:flex;align-items:center;gap:8px;">
          <button onclick="adjustForno(-5)" style="width:28px;height:28px;border-radius:8px;border:1px solid #E5E7EB;background:white;cursor:pointer;font-weight:700;">−</button>
          <span class="iv iv-orange" id="forno-setpoint">${forno.setpoint}°C</span>
          <button onclick="adjustForno(+5)" style="width:28px;height:28px;border-radius:8px;border:1px solid #E5E7EB;background:white;cursor:pointer;font-weight:700;">+</button>
        </div>
      </div>
    </div>
    <div class="popup-section"><div class="popup-section-title">Opzioni</div>
      <div class="toggle-row"><span class="toggle-label">Pre-riscaldamento rapido</span><button class="toggle-switch${forno.preheat?' on':''}" id="tog-forno-preheat" onclick="toggleSwitch('switch.forno_fast_pre_heat','tog-forno-preheat')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Blocco bambini</span><button class="toggle-switch${forno.lock?' on':''}" id="tog-forno-lock" onclick="toggleSwitch('switch.forno_blocco_bambini','tog-forno-lock')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Potenza</span><button class="toggle-switch${forno.power?' on':''}" id="tog-forno-power" onclick="toggleSwitch('switch.forno_potenza','tog-forno-power')"></button></div>
      ${tr('Illuminazione interna',forno.light)}
      ${tr('Connettività',forno.conn)}
      ${tr('Controllo remoto',forno.remote)}
      ${tr('Avvio remoto',forno.remoteStart)}
    </div>
    <div class="btn-row">
      <button class="action-btn btn-green" onclick="avviaForno()">▶ Avvia</button>
      <button class="action-btn btn-gray" onclick="callSvc('button','press',{entity_id:'button.forno_pause_program'})">⏸ Pausa</button>
      <button class="action-btn btn-blue" onclick="callSvc('button','press',{entity_id:'button.forno_resume_program'})">↩ Riprendi</button>
      <button class="action-btn btn-red" onclick="callSvc('button','press',{entity_id:'button.forno_stop_program'})">⏹ Stop</button>
    </div>
  </div></div>
</div>

<!-- POPUP PIANO COTTURA -->
<div class="popup-overlay" id="popup-piano" onclick="closeOnOverlay(event,'piano')">
  <div class="popup-box"><div class="popup-header">
    <div class="popup-header-left"><div class="popup-hicon" style="background:#FEF2F2;">🍳</div><div><div class="popup-title">Piano Cottura</div><div class="popup-brand">Siemens iQ700</div></div></div>
    <button class="popup-close" onclick="closePopup('piano')">✕</button>
  </div><div class="popup-body">
    ${tr('Stato',piano.stato,piano.stato==='In funzione'?'iv-orange':'')}
    ${tr('Connettività',piano.conn,piano.conn==='Connesso'?'iv-green':'iv-red')}
    <div class="popup-section"><div class="popup-section-title">Opzioni</div>
      <div class="toggle-row"><span class="toggle-label">Potenza</span><button class="toggle-switch${piano.power?' on':''}" id="tog-piano-power" onclick="toggleSwitch('switch.piano_cottura_potenza','tog-piano-power')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Blocco bambini</span><button class="toggle-switch${piano.lock?' on':''}" id="tog-piano-lock" onclick="toggleSwitch('switch.piano_cottura_blocco_bambini','tog-piano-lock')"></button></div>
    </div>
  </div></div>
</div>

<!-- POPUP LAVASTOVIGLIE -->
<div class="popup-overlay" id="popup-lavast" onclick="closeOnOverlay(event,'lavast')">
  <div class="popup-box"><div class="popup-header">
    <div class="popup-header-left"><div class="popup-hicon" style="background:#F0FDFA;">🫧</div><div><div class="popup-title">Lavastoviglie</div><div class="popup-brand">Siemens</div></div></div>
    <button class="popup-close" onclick="closePopup('lavast')">✕</button>
  </div><div class="popup-body">
    ${tr('Stato',lavast.stato,lavastOn?'iv-teal':'')}
    <div class="select-row" style="padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);"><span class="il">Programma</span>${lavastSelect()}</div>
    ${tr('Programma attivo',cleanProgram(S['select.lavastoviglie_active_program']?.state))}
    ${tr('Fine prevista',lavast.fine)}
    ${tr('Avanzamento',lavast.avanz+'%')}
    <div class="progress-bar"><div class="progress-fill" style="width:${lavast.avanz}%;background:#14B8A6;"></div></div>
    ${tr('Porta',lavast.porta,lavast.porta==='Aperta'?'iv-amber':'iv-green')}
    ${tr('Avvio differito',S['number.lavastoviglie_start_in_relative']?.state&&S['number.lavastoviglie_start_in_relative'].state!=='0'?S['number.lavastoviglie_start_in_relative'].state+' min':'--')}
    ${tr('Controllo remoto',lavast.remote)} ${tr('Avvio remoto',lavast.remoteStart)} ${tr('Connettività',lavast.conn,lavast.conn==='Connessa'?'iv-green':'iv-red')} ${tr('Illuminazione',lavast.light)}
    <div class="popup-section"><div class="popup-section-title">Opzioni</div>
      <div class="toggle-row"><span class="toggle-label">Zona intensiva</span><button class="toggle-switch${lavast.intense?' on':''}" id="tog-lavast-intense" onclick="toggleSwitch('switch.lavastoviglie_intensive_zone','tog-lavast-intense')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Asciugatura brillante</span><button class="toggle-switch${lavast.dry?' on':''}" id="tog-lavast-dry" onclick="toggleSwitch('switch.lavastoviglie_brilliance_dry','tog-lavast-dry')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Vario Speed Plus</span><button class="toggle-switch${lavast.speed?' on':''}" id="tog-lavast-speed" onclick="toggleSwitch('switch.lavastoviglie_vario_speed','tog-lavast-speed')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Silenzio on demand</span><button class="toggle-switch${lavast.silence?' on':''}" id="tog-lavast-silence" onclick="toggleSwitch('switch.lavastoviglie_silence_on_demand','tog-lavast-silence')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Mezzo carico</span><button class="toggle-switch${lavast.half?' on':''}" id="tog-lavast-half" onclick="toggleSwitch('switch.lavastoviglie_half_load','tog-lavast-half')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Igiene Plus</span><button class="toggle-switch${lavast.hygiene?' on':''}" id="tog-lavast-hygiene" onclick="toggleSwitch('switch.lavastoviglie_hygiene','tog-lavast-hygiene')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Potenza</span><button class="toggle-switch${lavast.power?' on':''}" id="tog-lavast-power" onclick="toggleSwitch('switch.lavastoviglie_potenza','tog-lavast-power')"></button></div>
    </div>
    <div class="btn-row"><button class="action-btn btn-red" onclick="callSvc('button','press',{entity_id:'button.lavastoviglie_stop_program'})">⏹ Stop</button></div>
  </div></div>
</div>

<!-- POPUP LAVATRICE -->
<div class="popup-overlay" id="popup-lavatrice" onclick="closeOnOverlay(event,'lavatrice')">
  <div class="popup-box"><div class="popup-header">
    <div class="popup-header-left"><div class="popup-hicon" style="background:#FAF5FF;">🌀</div><div><div class="popup-title">Lavatrice</div><div class="popup-brand">Miele</div></div></div>
    <button class="popup-close" onclick="closePopup('lavatrice')">✕</button>
  </div><div class="popup-body">
    ${tr('Stato',lavatrice.stato,lavOn?'iv-purple':'')}
    ${tr('Programma',lavatrice.prog)} ${tr('Tipo',lavatrice.tipo)} ${tr('Fase',lavatrice.fase)}
    ${tr('Temperatura',lavatrice.temp+'°C')} ${tr('Centrifuga',lavatrice.rpm+' rpm')}
    ${tr('Tempo residuo',lavatrice.residuo&&lavatrice.residuo!=='0'?lavatrice.residuo+' min':'--','iv-purple')}
    ${tr('Tempo trascorso',lavatrice.elapsed?lavatrice.elapsed+' min':'--')}
    ${tr('Fine prevista',lavatrice.fine)} ${tr('Ora inizio',lavatrice.start)}
    ${tr('Partenza programmata',lavatrice.scheduled)}
    ${tr('Sportello',lavatrice.porta,lavatrice.portaOn?'iv-amber':'iv-green')}
    ${tr('Consumo energia',lavatrice.energia?lavatrice.energia+' kWh':'--','iv-blue')}
    ${tr('Consumo acqua',lavatrice.acqua?lavatrice.acqua+' L':'--','iv-blue')}
    <div class="popup-section"><div class="popup-section-title">Connessione</div>
      ${tr('Controllo remoto',lavatrice.remote)} ${tr('Mobile Start',lavatrice.mobile)} ${tr('Smart Grid',lavatrice.smart)} ${tr('Info',lavatrice.info)}
      ${tr('Guasto',lavatrice.guasto?'⚠ Guasto rilevato':'Nessun guasto',lavatrice.guasto?'iv-red':'iv-green')}
    </div>
    <div class="popup-section"><div class="popup-section-title">Controlli</div>
      <div class="toggle-row"><span class="toggle-label">Accensione</span><button class="toggle-switch${lavatrice.power?' on':''}" id="tog-lavatrice-power" onclick="toggleSwitch('switch.lavabiancheria_accensione','tog-lavatrice-power')"></button></div>
    </div>
    <div class="btn-row">
      <button class="action-btn btn-green" onclick="callSvc('button','press',{entity_id:'button.lavabiancheria_start'})">▶ Avvia</button>
      <button class="action-btn btn-red" onclick="callSvc('button','press',{entity_id:'button.lavabiancheria_stop'})">⏹ Stop</button>
    </div>
  </div></div>
</div>

<!-- POPUP CONGELATORE -->
<div class="popup-overlay" id="popup-congel" onclick="closeOnOverlay(event,'congel')">
  <div class="popup-box"><div class="popup-header">
    <div class="popup-header-left"><div class="popup-hicon" style="background:#E0F2FE;">🧊</div><div><div class="popup-title">Congelatore</div><div class="popup-brand">Miele</div></div></div>
    <button class="popup-close" onclick="closePopup('congel')">✕</button>
  </div><div class="popup-body">
    ${tr('Temperatura',congel.temp+'°C','iv-cyan')}
    ${tr('Porta',congel.porta?'🔴 Aperta':'🟢 Chiusa')}
    ${tr('Connettività',congel.conn,congel.conn==='Connesso'?'iv-green':'iv-red')}
    <div class="popup-section"><div class="popup-section-title">Imposta temperatura</div>
      <div class="temp-ctrl">
        <button onclick="adjustCongel(-1)">−</button>
        <div class="temp-val" id="congel-setpoint" style="color:#0284C7;">${congel.temp}°C</div>
        <button onclick="adjustCongel(+1)">+</button>
      </div>
    </div>
    <div class="popup-section"><div class="popup-section-title">Opzioni</div>
      <div class="toggle-row"><span class="toggle-label">Potenza</span><button class="toggle-switch${congel.power?' on':''}" id="tog-congel-power" onclick="toggleSwitch('switch.congelatore_potenza','tog-congel-power')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Super congelatore</span><button class="toggle-switch${congel.super?' on':''}" id="tog-congel-super" onclick="toggleSwitch('switch.congelatore_modalita_super_congelatore','tog-congel-super')"></button></div>
      <div class="toggle-row"><span class="toggle-label">Assistente porta</span><button class="toggle-switch${congel.assistente?' on':''}" id="tog-congel-porta" onclick="toggleSwitch('switch.congelatore_assistente_porta_del_congelatore','tog-congel-porta')"></button></div>
      <div class="btn-row"><button class="action-btn btn-blue" onclick="callSvc('button','press',{entity_id:'button.congelatore_open_door'})">🔓 Apri porta</button></div>
    </div>
  </div></div>
</div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: CLIMA
   ═══════════════════════════════════════════════════════ */
function clima() {
  function splitCard(which) {
    const id     = `climate.${which}`;
    const suffix = which === 'sala' ? 'sala' : 'sopp';
    const color  = which === 'sala' ? '#2196F3' : '#8B5CF6';
    const label  = which === 'sala' ? '❄️ Split Sala' : '❄️ Split Soppalco';
    const s      = S[id] || {};
    const mode   = s.state || 'off';
    const intT   = fmtFloat(s.attributes?.current_temperature);
    const target = s.attributes?.temperature || '--';
    const extS   = which === 'sala' ? S['sensor.sala_outside_temperature'] : S['sensor.soppalco_outside_temperature'];
    const extT   = fmtFloat(extS?.state);
    const energy = fmtFloat(S[`sensor.${which}_daily_energy`]?.state, 2);
    const coolE  = fmtFloat(S[`sensor.${which}_daily_cooling_energy`]?.state, 2);
    const heatE  = fmtFloat(S[`sensor.${which}_daily_heating_energy`]?.state, 2);
    const nanoe  = S[`switch.${which}_nanoe`]?.state === 'on';
    const econavi= S[`switch.${which}_econavi`]?.state === 'on';
    const iauto  = S[`switch.${which}_iauto_x`]?.state === 'on';
    const aieco  = S[`switch.${which}_ai_eco`]?.state === 'on';
    const modes  = ['heat','cool','dry','fan','auto'];
    const modeMap= {heat:'heat',cool:'cool',dry:'dry',fan:'fan_only',auto:'auto'};
    const modeHA = {heat:'heat',cool:'cool',dry:'dry',fan_only:'fan',auto:'auto'};
    const btns   = modes.map(m => {
      const ha = modeMap[m]; const active = mode === ha;
      const cls = active ? ({heat:'m-amber',cool:'m-blue',dry:'m-purple',fan:'m-teal',auto:'m-amber'}[m]||'m-blue') : 'm-off';
      const lbl = {heat:'🔥 Caldo',cool:'❄️ Freddo',dry:'💧 Dry',fan:'🌀 Ventila',auto:'⚡ Auto'}[m];
      return `<button class="mode-btn-clima ${cls}" id="mode-${suffix}-${m}" onclick="setClimate('${id}','${ha}')">${lbl}</button>`;
    }).join('');

    return `
    <div class="col">
      <div class="card">
        <div class="split-header">
          <div class="split-title">${label}</div>
          <div class="split-badge" id="badge-${suffix}" style="${modeBadgeStyle(mode)}">${modeLabel(mode)}</div>
        </div>
        <div class="split-main">
          <div>
            <div class="split-temp-int" id="temp-int-${suffix}" style="color:${color};">${intT}°</div>
            <div class="split-temp-sub">temperatura interna</div>
          </div>
          <div class="thermo-ring" id="ring-${suffix}" style="border-color:${color};" onclick="openPopup('temp-${which}')">
            <div class="thermo-target-lbl">target</div>
            <div class="thermo-target-val" id="target-${suffix}" style="color:${color};">${target}°</div>
          </div>
        </div>
        <div class="mode-grid">${btns}
          <button class="mode-btn-clima m-red" onclick="callSvc('climate','turn_off',{entity_id:'${id}'})">⏻ Off</button>
        </div>
        <div class="toggle-row"><span class="toggle-label">Nanoe™ X</span><button class="toggle-switch${nanoe?' on':''}" id="tog-${suffix}-nanoe" onclick="toggleSwitch('switch.${which}_nanoe','tog-${suffix}-nanoe')"></button></div>
        <div class="toggle-row"><span class="toggle-label">ECONAVI</span><button class="toggle-switch${econavi?' on':''}" id="tog-${suffix}-econavi" onclick="toggleSwitch('switch.${which}_econavi','tog-${suffix}-econavi')"></button></div>
        <div class="toggle-row"><span class="toggle-label">iAuto-X</span><button class="toggle-switch${iauto?' on':''}" id="tog-${suffix}-iauto" onclick="toggleSwitch('switch.${which}_iauto_x','tog-${suffix}-iauto')"></button></div>
        <div class="toggle-row"><span class="toggle-label">AI Eco</span><button class="toggle-switch${aieco?' on':''}" id="tog-${suffix}-aieco" onclick="toggleSwitch('switch.${which}_ai_eco','tog-${suffix}-aieco')"></button></div>
      </div>
      <div class="card">
        <div class="section-lbl">Sensori & Energia oggi</div>
        <div class="info-row"><span class="il">Temp. esterna</span><span class="iv">${extT}°C</span></div>
        <div class="info-row"><span class="il">Energia totale</span><span class="iv" style="color:${color};font-weight:600;">${energy} kWh</span></div>
        <div class="info-row"><span class="il">Raffreddamento</span><span class="iv" style="color:${color};font-weight:600;">${coolE} kWh</span></div>
        <div class="info-row"><span class="il">Riscaldamento</span><span class="iv iv-orange">${heatE} kWh</span></div>
      </div>
    </div>`;
  }

  const pdcS   = S['water_heater.aquarea_tank'];
  const pdcT   = fmtFloat(pdcS?.attributes?.current_temperature, 0);
  const pdcExt = fmtFloat(S['sensor.aquarea_outside_temperature']?.state);
  const pdcMode= pdcS?.attributes?.operation_mode || pdcS?.state || '--';
  const pdcOn  = pdcS?.state !== 'off' && pdcS?.state !== 'unavailable';
  const tr     = (l,v,cls='') => `<div class="info-row"><span class="il">${l}</span><span class="iv${cls?' '+cls:''}">${v}</span></div>`;
  const sog    = { t: fmtFloat(S['sensor.piano_terra_a_temperatura']?.state), u: S['sensor.piano_terra_a_umidita']?.state||'--' };
  const pia    = { t: fmtFloat(S['sensor.primo_piano']?.state), u: S['sensor.primo_piano_b_umidita']?.state||'--' };
  const cam    = { t: fmtFloat(S['sensor.termostato_camera_da_letto_temperatura']?.state), u: S['sensor.termostato_camera_da_letto_umidita']?.state||'--' };
  const vmcOn  = S['switch.sonoff_s60zbtpf']?.state === 'on';
  const sogOff = getN('input_number.vmc_soglia_spegnimento', 26);
  const sogOn2 = getN('input_number.vmc_soglia_accensione', 25.5);
  const extT   = fmtFloat(S['sensor.aquarea_outside_temperature']?.state);

  return `
<div style="padding:20px 28px;">
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:auto 1fr;gap:12px;">
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;grid-column:1/-1;align-items:end;">
      <div><div class="page-title">🌡️ Clima</div><div class="col-label">Split Sala</div></div>
      <div class="col-label" style="align-self:end;">Split Soppalco</div>
      <div class="col-label" style="align-self:end;">PDC & Sensori</div>
    </div>
    ${splitCard('sala')}
    ${splitCard('soppalco')}
    <div class="col">
      <div class="card">
        <div class="split-header">
          <div class="split-title">🌊 PDC Aquarea</div>
          <div class="split-badge" style="${pdcOn?'background:#FFF7ED;color:#C2410C':'background:#F3F4F6;color:#6B7280'}">${pdcOn?'Attiva':'Inattiva'}</div>
        </div>
        <div style="font-size:44px;font-weight:800;letter-spacing:-2px;line-height:1;color:#FF6B35;margin-bottom:2px;">${pdcT}°C</div>
        <div style="font-size:11px;color:#9CA3AF;margin-bottom:10px;">Temperatura serbatoio</div>
        ${tr('Temp. esterna',pdcExt+'°C','iv-orange')}
        ${tr('Modalità',pdcMode)}
        ${tr('Stato',pdcS?.state||'--')}
      </div>
      <div class="card">
        <div class="section-lbl">Temperatura stanze</div>
        ${[['#FF6B35','Soggiorno',sog.t,sog.u],['#22C55E','1° Piano',pia.t,pia.u],['#2196F3','Camera da letto',cam.t,cam.u]].map(([c,n,t,u])=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);">
          <div style="display:flex;align-items:center;gap:8px;"><div style="width:9px;height:9px;border-radius:50%;background:${c};flex-shrink:0;"></div><div style="font-size:12px;font-weight:500;color:#374151;">${n}</div></div>
          <div style="text-align:right;"><div style="font-size:15px;font-weight:700;color:#111827;">${t}°C</div><div style="font-size:10px;color:#9CA3AF;">${u}% umid.</div></div>
        </div>`).join('')}
      </div>
      <div class="card" id="vmc-override-card">
        <div class="section-lbl">VMC — Controllo manuale</div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <div>
            <div style="font-size:13px;font-weight:600;color:#111827;">Presa Sonoff (VMC)</div>
            <div style="font-size:11px;margin-top:2px;color:${vmcOn?'#15803D':'#EF4444'};" id="vmc-stato-clima">${vmcOn?'● Accesa':'● Spenta'}</div>
          </div>
          <button class="toggle-switch${vmcOn?' on':''}" id="tog-vmc-override" onclick="toggleVMC()"></button>
        </div>
        <div style="background:#F9FAFB;border-radius:10px;padding:8px;font-size:11px;color:#6B7280;">
          Spegne &gt;${sogOff}°C · Accende &lt;${sogOn2}°C · Est. ora ${extT}°C
        </div>
        ${vmcOn?'':'<div style="background:#FEF3C7;border-radius:10px;padding:8px 10px;font-size:11px;color:#92400E;margin-top:8px;">⚠ Override manuale — l\'automazione potrebbe ripristinare</div>'}
      </div>
    </div>
  </div>
</div>
${['sala','soppalco'].map(w=>{
  const s=w==='sala';
  const col=s?'#2196F3':'#8B5CF6';
  const lbl=s?'Sala':'Soppalco';
  const t=S[`climate.${w}`]?.attributes?.temperature||22;
  return `<div class="popup-overlay" id="popup-temp-${w}" onclick="closeOnOverlay(event,'temp-${w}')">
    <div class="popup-box" style="max-width:340px;"><div class="popup-header">
      <div class="popup-title">❄️ Target ${lbl}</div>
      <button class="popup-close" onclick="closePopup('temp-${w}')">✕</button>
    </div><div class="popup-body">
      <div class="temp-ctrl">
        <button onclick="adjustTarget('${w}',-0.5)">−</button>
        <div class="temp-val" id="target-${s?'sala':'sopp'}-popup" style="color:${col};">${t}°</div>
        <button onclick="adjustTarget('${w}',+0.5)">+</button>
      </div>
    </div></div>
  </div>`;
}).join('')}`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: CONSUMI (riusa salfara_consumi logic)
   ═══════════════════════════════════════════════════════ */
function consumi() {
  const kpi = (id,col,lbl) => { const v=S[id]?.state; const n=parseFloat(v)||0; return `<div class="kpi-card" style="border-color:${col};"><div class="kpi-val" style="color:${col};" id="${id.split('.')[1]}">${n>=1000?(n/1000).toFixed(2)+' kW':Math.round(n)+' W'}</div><div class="kpi-lbl">${lbl}</div></div>`; };
  const kpiK= (id,col,lbl) => { const v=parseFloat(S[id]?.state)||0; return `<div class="kpi-card" style="border-color:${col};"><div class="kpi-val" style="color:${col};" id="${id.split('.')[1]}">${v.toFixed(2)} kWh</div><div class="kpi-lbl">${lbl}</div></div>`; };
  const ir  = (l,v,id) => `<div class="info-row"><span class="il">${l}</span><span class="iv" id="${id}">${v}</span></div>`;
  const soc = Math.round(parseFloat(S['sensor.growatt_batteria_soc']?.state)||0);
  const battC = soc>60?'#22C55E':soc>30?'#F59E0B':'#EF4444';
  const pvW = fmtW(S['sensor.growatt_pv_potenza_totale']?.state);
  const gW  = fmtW(S['sensor.growatt_potenza_da_rete']?.state);
  const hW  = fmtW(S['sensor.growatt_carico_locale']?.state);
  const bW  = fmtW(S['sensor.growatt_batteria_carica']?.state);

  return `
<div style="padding:16px 28px;height:calc(100vh - 52px);overflow:hidden;display:flex;flex-direction:column;gap:10px;">
  <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;flex-shrink:0;">
    ${kpi('sensor.growatt_pv_potenza_totale','#F59E0B','Solare ora')}
    <div class="kpi-card" style="border-color:#22C55E;"><div class="kpi-val" style="color:${battC};" id="kpi-batt-soc">${soc}%</div><div class="kpi-lbl">Batteria</div></div>
    ${kpi('sensor.growatt_carico_locale','#2196F3','Carico casa')}
    ${kpi('sensor.growatt_potenza_da_rete','#6B7280','Rete')}
    ${kpiK('sensor.growatt_energia_prodotta_oggi','#F59E0B','Prodotto oggi')}
    ${kpiK('sensor.growatt_energia_prelevata_rete_totale','#EF4444','Prelevato oggi')}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:1;min-height:0;overflow:hidden;">
    <div class="card" style="overflow:hidden;">
      <div style="font-size:12px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;">Flusso energetico</div>
      <div style="display:grid;grid-template-columns:1fr 80px 1fr;grid-template-rows:1fr 60px 1fr;gap:8px;width:200px;height:160px;align-items:center;justify-items:center;margin:0 auto;">
        <div></div>
        <div style="text-align:center;"><div style="font-size:10px;color:#9CA3AF;margin-bottom:2px;">Solare</div><div style="width:48px;height:48px;border-radius:50%;border:2px solid #F59E0B;display:flex;align-items:center;justify-content:center;background:white;"><div style="font-size:9px;font-weight:700;color:#F59E0B;" id="flow-pv">${pvW}</div></div></div>
        <div></div>
        <div style="text-align:center;"><div style="font-size:10px;color:#9CA3AF;margin-bottom:2px;">Rete</div><div style="width:48px;height:48px;border-radius:50%;border:2px solid #6B7280;display:flex;align-items:center;justify-content:center;background:white;"><div style="font-size:9px;font-weight:700;color:#6B7280;" id="flow-grid">${gW}</div></div></div>
        <div style="text-align:center;"><div style="width:54px;height:54px;border-radius:50%;border:3px solid #2196F3;display:flex;align-items:center;justify-content:center;background:white;box-shadow:0 2px 8px rgba(33,150,243,0.2);"><div style="text-align:center;"><div style="font-size:18px;">🏠</div><div style="font-size:9px;font-weight:700;color:#2196F3;" id="flow-home">${hW}</div></div></div></div>
        <div style="text-align:center;"><div style="font-size:10px;color:#9CA3AF;margin-bottom:2px;">Batteria</div><div style="width:48px;height:48px;border-radius:50%;border:2px solid ${battC};display:flex;align-items:center;justify-content:center;background:white;"><div style="font-size:9px;font-weight:700;color:${battC};" id="flow-batt-w">${bW}</div></div></div>
        <div></div><div></div><div></div>
      </div>
    </div>
    <div class="card">
      <div style="font-size:12px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Batteria Growatt</div>
      <div style="text-align:center;margin-bottom:8px;"><div style="font-size:34px;font-weight:800;color:${battC};letter-spacing:-2px;" id="batt-soc-big">${soc}%</div><div style="font-size:12px;color:#9CA3AF;">Stato di carica</div></div>
      <div style="height:6px;border-radius:3px;background:#F3F4F6;margin:8px 0 4px;overflow:hidden;"><div id="soc-fill" style="height:100%;border-radius:3px;width:${soc}%;background:linear-gradient(90deg,${battC},${battC}99);"></div></div>
      ${ir('Tensione',fmtFloat(S['sensor.growatt_batteria_tensione']?.state)+' V','batt-volt')}
      ${ir('Carica oggi',fmtFloat(S['sensor.growatt_batteria_carica_oggi']?.state,2)+' kWh','batt-carica')}
      ${ir('Scarica oggi',fmtFloat(S['sensor.growatt_batteria_scarica_oggi']?.state,2)+' kWh','batt-scarica')}
      ${ir('Potenza carica',fmtW(S['sensor.growatt_batteria_carica']?.state),'batt-pw-carica')}
      ${ir('Temperatura',fmtFloat(S['sensor.growatt_temperatura']?.state)+'°C','growatt-temp-cons')}
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;flex-shrink:0;">
    <div class="card">
      <div style="font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">☀️ Solare</div>
      ${ir('Potenza totale',fmtW(S['sensor.growatt_pv_potenza_totale']?.state),'pv-tot')}
      ${ir('PV1',fmtW(S['sensor.growatt_pv1_potenza']?.state),'pv1')}
      ${ir('PV2',fmtW(S['sensor.growatt_pv2_potenza']?.state),'pv2')}
      ${ir('Prodotto oggi',fmtFloat(S['sensor.growatt_energia_prodotta_oggi']?.state,2)+' kWh','pv-oggi')}
      ${ir('Prodotto totale',fmtFloat(S['sensor.growatt_energia_prodotta_totale']?.state,2)+' kWh','pv-tot-kwh')}
    </div>
    <div class="card">
      <div style="font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">🔌 Rete</div>
      ${ir('Da rete',fmtW(S['sensor.growatt_potenza_da_rete']?.state),'da-rete')}
      ${ir('Verso rete',fmtW(S['sensor.growatt_potenza_verso_rete']?.state),'verso-rete')}
      ${ir('Tensione L1',fmtFloat(S['sensor.growatt_tensione_rete_l1']?.state)+' V','rete-l1')}
      ${ir('Frequenza',fmtFloat(S['sensor.growatt_frequenza_rete']?.state,2)+' Hz','rete-freq')}
      ${ir('Ceduta totale',fmtFloat(S['sensor.growatt_energia_ceduta_rete_totale']?.state,2)+' kWh','ceduta')}
    </div>
    <div class="card">
      <div style="font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">🏠 Carichi</div>
      ${ir('Carico locale',fmtW(S['sensor.growatt_carico_locale']?.state),'carico-loc')}
      ${ir('Carico oggi',fmtFloat(S['sensor.growatt_carico_locale_oggi']?.state,2)+' kWh','carico-oggi')}
      ${ir('Presa VMC',fmtW(S['sensor.sonoff_s60zbtpf_potenza']?.state),'sonoff-w')}
      ${ir('Presa Shuko',fmtW(S['sensor.presa_shuko_smart_potenza']?.state),'shuko-w')}
      ${ir('Stato sistema',S['sensor.growatt_stato']?.state||'--','growatt-st')}
    </div>
    <div class="card">
      <div style="font-size:10px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">❄️ Split oggi</div>
      <div style="font-size:11px;font-weight:600;color:#2196F3;margin-bottom:4px;">Sala</div>
      ${ir('Totale',fmtFloat(S['sensor.sala_daily_energy']?.state,2)+' kWh','sala-e-tot')}
      ${ir('Raffredd.',fmtFloat(S['sensor.sala_daily_cooling_energy']?.state,2)+' kWh','sala-e-cool')}
      <div style="font-size:11px;font-weight:600;color:#8B5CF6;margin:6px 0 4px;">Soppalco</div>
      ${ir('Totale',fmtFloat(S['sensor.soppalco_daily_energy']?.state,2)+' kWh','sopp-e-tot')}
      ${ir('Raffredd.',fmtFloat(S['sensor.soppalco_daily_cooling_energy']?.state,2)+' kWh','sopp-e-cool')}
    </div>
  </div>
</div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: AUTOMAZIONI
   ═══════════════════════════════════════════════════════ */
function automazioni() {
  const vmcOn   = S['switch.sonoff_s60zbtpf']?.state === 'on';
  const salaOn  = S['climate.sala']?.state !== 'off';
  const soppOn  = S['climate.soppalco']?.state !== 'off';
  const nanoeS  = S['switch.sala_nanoe']?.state === 'on';
  const nanoeP  = S['switch.soppalco_nanoe']?.state === 'on';
  const dryS    = S['climate.sala']?.state === 'dry';
  const dryP    = S['climate.soppalco']?.state === 'dry';
  const dryAct  = dryS || dryP;
  const extT    = fmtFloat(S['sensor.aquarea_outside_temperature']?.state);
  const sogOff  = getN('input_number.vmc_soglia_spegnimento', 26);
  const sogOn2  = getN('input_number.vmc_soglia_accensione', 25.5);
  const dryOn   = getN('input_number.clima_dry_on', 60);
  const dryOff  = getN('input_number.clima_dry_off', 55);
  const humS    = S['sensor.termostato_camera_da_letto_umidita']?.state || '--';
  const humP    = S['sensor.primo_piano_b_umidita']?.state || '--';
  const climaAuto= S['automation.clima_salfara_controllo_intelligente'];
  const parAuto  = S['automation.parentesi_tramonto_spegni_all_1_00'];
  const ipadAuto = S['automation.ricarica_ipad'];
  const ipadPct  = Math.round(parseFloat(S['sensor.ipad_battery_level']?.state)||0);
  const ipadLow  = getN('input_number.ipad_soglia_ricarica', 20);
  const ipadHigh = getN('input_number.ipad_soglia_stop', 80);
  const lampOn   = S['switch.presa_parentesi']?.state === 'on';
  const sunsetT  = fmtTime(S['sensor.sun_next_setting']?.state);

  const statoRow = (cls, iconSvg, title, desc, active=true) => `
    <div class="stato ${cls}" style="animation:slide-in 0.25s ease;">
      <div class="stato-icon">${iconSvg}</div>
      <div class="stato-text">
        <div class="stato-title"><span class="ind ${active?'on':'off'}"></span>${title}</div>
        <div class="stato-desc">${desc}</div>
      </div>
    </div>`;

  const fanSvg = (on) => `<svg width="34" height="34" viewBox="0 0 36 36" fill="none">
    <g style="transform-origin:18px 18px;${on?'animation:fan-spin 2s linear infinite;':''}">
      ${[0,72,144,216,288].map(r=>`<ellipse cx="18" cy="11" rx="3.5" ry="6.5" fill="${on?'#22C55E':'#EF4444'}" opacity="${on?'0.6':'0.3'}" transform="rotate(${r} 18 18)"/>`).join('')}
      <circle cx="18" cy="18" r="3.5" fill="${on?'#22C55E':'#EF4444'}" opacity="${on?'0.3':'0.15'}"/>
      <circle cx="18" cy="18" r="2" fill="${on?'#22C55E':'#EF4444'}" opacity="${on?'1':'0.4'}"/>
    </g></svg>`;

  const nanoeSvg = `<svg width="28" height="28" viewBox="0 0 28 28" fill="none">
    <circle cx="14" cy="14" r="2.5" fill="#22C55E" opacity="0.9"/>
    <circle cx="14" cy="14" r="6" stroke="#22C55E" stroke-width="1" fill="none"><animate attributeName="r" values="5;8;5" dur="3s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.8;0.1;0.8" dur="3s" repeatCount="indefinite"/></circle>
    <circle cx="14" cy="14" r="10" stroke="#22C55E" stroke-width="0.7" fill="none"><animate attributeName="r" values="8;12;8" dur="3s" begin="0.5s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.4;0.05;0.4" dur="3s" begin="0.5s" repeatCount="indefinite"/></circle></svg>`;

  const humSvg = `<svg width="34" height="34" viewBox="0 0 32 32" fill="none">
    <path d="M16 5 Q20 11 20 16 A4 4 0 0 1 12 16 Q12 11 16 5Z" fill="#60A5FA" opacity="0.2" stroke="#2196F3" stroke-width="1.5"/>
    <circle cx="21" cy="11" r="1.5" fill="#60A5FA"><animate attributeName="cy" values="11;21;11" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0.8;0" dur="2s" repeatCount="indefinite"/></circle>
    <circle cx="11" cy="9" r="1.2" fill="#60A5FA"><animate attributeName="cy" values="9;19;9" dur="2s" begin="0.8s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0.7;0" dur="2s" begin="0.8s" repeatCount="indefinite"/></circle></svg>`;

  const salaModeLbl  = modeLabel(S['climate.sala']?.state||'off');
  const soppModeLbl  = modeLabel(S['climate.soppalco']?.state||'off');
  const salaAttr     = S['climate.sala']?.attributes||{};
  const soppAttr     = S['climate.soppalco']?.attributes||{};

  return `
<div style="padding:20px 28px;height:calc(100vh - 52px);overflow:hidden;display:grid;grid-template-columns:1.4fr 1fr 1fr;grid-template-rows:auto 1fr;gap:12px;align-items:start;">
  <div style="grid-column:1/-1;display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:12px;align-items:end;">
    <div><div class="page-title">🤖 Automazioni</div><div class="col-label">Clima Intelligente</div></div>
    <div class="col-label" style="align-self:end;">Parentesi & Relax</div>
    <div class="col-label" style="align-self:end;">Ricarica iPad</div>
  </div>

  <!-- CLIMA INTELLIGENTE -->
  <div class="card">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;">
      <div><div style="font-size:14px;font-weight:700;color:#111827;">Clima Intelligente</div><div style="font-size:11px;color:#9CA3AF;margin-top:2px;">VMC · Split Sala · Split Soppalco · Nanoe™ X</div></div>
      <button class="toggle-switch${climaAuto?.state==='on'?' on':''}" id="tog-clima" onclick="toggleAutomation('automation.clima_salfara_controllo_intelligente','tog-clima')"></button>
    </div>

    ${statoRow(vmcOn?'s-on':'s-off', fanSvg(vmcOn),
      vmcOn?'VMC — Ventola in funzione':'VMC — Ventola ferma',
      vmcOn?`Est. ${extT}°C < ${sogOn2}°C · ricambio aria attivo`:`Est. ${extT}°C > ${sogOff}°C · troppo caldo fuori`,
      vmcOn)}

    ${salaOn ? statoRow('s-blue',
      `<svg width="34" height="34" viewBox="0 0 26 26" fill="none"><path d="M13 3L13 23M3 13L23 13M6 6L20 20M20 6L6 20" stroke="#2196F3" stroke-width="1.8" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 13 13" to="360 13 13" dur="12s" repeatCount="indefinite"/></path><circle cx="13" cy="13" r="3" fill="#2196F3"/></svg>`,
      `Split Sala — ${salaModeLbl}`,
      `${fmtFloat(salaAttr.current_temperature)}°C · target ${salaAttr.temperature}°C`) : ''}

    ${salaOn && nanoeS ? `<div class="stato s-nanoe" style="animation:slide-in 0.25s ease;"><div class="stato-icon">${nanoeSvg}</div><div class="stato-text"><div class="stato-title"><span class="ind on"></span>Nanoe™ X Sala</div><div class="stato-desc">Aria purificata</div></div></div>` : ''}

    ${soppOn ? statoRow('s-purple',
      `<svg width="34" height="34" viewBox="0 0 26 26" fill="none"><path d="M13 4 Q17 10 17 14 A4 4 0 0 1 9 14 Q9 10 13 4Z" fill="#8B5CF6" opacity="0.2" stroke="#8B5CF6" stroke-width="1.5"/><circle cx="13" cy="13" r="2" fill="#8B5CF6"><animate attributeName="cy" values="13;11;13" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.8;0.3;0.8" dur="2s" repeatCount="indefinite"/></circle></svg>`,
      `Split Soppalco — ${soppModeLbl}`,
      `${fmtFloat(soppAttr.current_temperature)}°C · target ${soppAttr.temperature}°C`) : ''}

    ${soppOn && nanoeP ? `<div class="stato s-nanoe" style="animation:slide-in 0.25s ease;"><div class="stato-icon">${nanoeSvg}</div><div class="stato-text"><div class="stato-title"><span class="ind on"></span>Nanoe™ X Soppalco</div><div class="stato-desc">Aria purificata</div></div></div>` : ''}

    ${dryAct ? `<div class="stato s-humid" style="animation:slide-in 0.25s ease;"><div class="stato-icon">${humSvg}</div><div class="stato-text"><div class="stato-title"><span class="ind on"></span>Deumidificazione attiva</div><div class="stato-desc">${[humS!=='--'?`Camera ${humS}%`:'',humP!=='--'?`1° Piano ${humP}%`:''].filter(Boolean).join(' · ')} — obiettivo &lt;${dryOff}%</div></div></div>` : ''}

    <div style="margin-top:12px;padding-top:10px;border-top:0.5px solid rgba(0,0,0,0.07);display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#9CA3AF;">
      <div>Ultima: <strong style="color:#374151;">${fmtDate(climaAuto?.attributes?.last_triggered)}</strong></div>
      <button style="padding:4px 12px;border-radius:20px;background:#F0FDF4;color:#15803D;font-size:11px;font-weight:600;border:none;cursor:pointer;" onclick="triggerAutomation('automation.clima_salfara_controllo_intelligente')">▶ Esegui</button>
    </div>
  </div>

  <!-- PARENTESI + RELAX -->
  <div style="display:flex;flex-direction:column;gap:12px;">
    <div class="card">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;">
        <div><div style="font-size:14px;font-weight:700;color:#111827;">Parentesi — Tramonto</div><div style="font-size:11px;color:#9CA3AF;margin-top:2px;">Accende al tramonto, spegne all'orario</div></div>
        <button class="toggle-switch${parAuto?.state==='on'?' on':''}" onclick="toggleAutomation('automation.parentesi_tramonto_spegni_all_1_00','')"></button>
      </div>
      <div style="height:64px;border-radius:12px;overflow:hidden;position:relative;background:linear-gradient(180deg,#1e1b4b 0%,#312e81 45%,#f97316 75%,#fed7aa 100%);margin-bottom:10px;">
        <span style="position:absolute;color:rgba(255,255,255,0.85);font-size:7px;animation:breathe 3s ease-in-out infinite;" style="top:8px;left:12%;">●</span>
        <span style="position:absolute;top:8px;left:12%;color:rgba(255,255,255,0.85);font-size:7px;animation:breathe 3s ease-in-out infinite;">●</span>
        <span style="position:absolute;top:12px;left:38%;color:rgba(255,255,255,0.85);font-size:7px;animation:breathe 3s ease-in-out infinite 1s;">●</span>
        <span style="position:absolute;top:7px;left:62%;color:rgba(255,255,255,0.85);font-size:7px;animation:breathe 3s ease-in-out infinite 1.8s;">●</span>
        <span style="position:absolute;bottom:12px;left:50%;transform:translateX(-50%);font-size:15px;color:#FDE68A;animation:sun-desc 5s ease-in-out infinite alternate;">◐</span>
        <div style="position:absolute;top:8px;right:14px;">
          <svg width="18" height="24" viewBox="0 0 18 24" fill="none">
            <circle cx="9" cy="8" r="6.5" fill="#FEF3C7" stroke="#F59E0B" stroke-width="1.5"><animate attributeName="fill" values="#FEF3C7;#FDE68A;#FEF3C7" dur="2s" repeatCount="indefinite"/></circle>
            <rect x="6" y="13.5" width="6" height="2.5" rx="1" fill="#D97706" opacity="0.7"/>
            <line x1="9" y1="19" x2="9" y2="22" stroke="#D97706" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M4 4L2.5 2.5 M14 4L15.5 2.5 M2 8L0.5 8 M16 8L17.5 8" stroke="#FDE68A" stroke-width="1" stroke-linecap="round"><animate attributeName="opacity" values="0.3;1;0.3" dur="2s" repeatCount="indefinite"/></path>
          </svg>
        </div>
        <div style="position:absolute;bottom:0;left:0;right:0;height:12px;background:#EEEADF;border-radius:50% 50% 0 0/100% 100% 0 0;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:0.5px solid rgba(0,0,0,0.06);font-size:12px;"><span style="color:#9CA3AF;">Accensione</span><span style="font-weight:600;color:#D97706;">tramonto · ${sunsetT}</span></div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:0.5px solid rgba(0,0,0,0.06);font-size:12px;"><span style="color:#9CA3AF;">Spegnimento</span><span style="font-weight:600;">${fmtTime(S['input_datetime.parentesi_orario_spegnimento']?.state)}</span></div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:0.5px solid rgba(0,0,0,0.06);font-size:12px;"><span style="color:#9CA3AF;">Stato lampada</span><span style="display:flex;align-items:center;gap:5px;font-weight:600;color:${lampOn?'#D97706':'#9CA3AF'};"><span class="ind ${lampOn?'warm':'idle'}"></span>${lampOn?'Accesa':'Spenta'}</span></div>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div><div style="font-size:14px;font-weight:700;color:#111827;">Relax Mode</div><div style="font-size:11px;color:#9CA3AF;margin-top:2px;">Spotify · Luce · Clima silenzioso</div></div>
        <button style="padding:5px 14px;border-radius:20px;background:#5B21B6;color:white;font-size:11px;font-weight:600;border:none;cursor:pointer;" onclick="triggerAutomation('automation.relax_mode')">▶ Attiva</button>
      </div>
      <div style="background:#FAF5FF;border-radius:12px;padding:10px 14px;display:flex;align-items:center;gap:10px;position:relative;overflow:hidden;">
        <span style="position:absolute;top:4px;right:8px;font-size:11px;color:#8B5CF6;animation:note-drift 2.5s ease-in-out infinite;">♪</span>
        <span style="position:absolute;top:8px;right:20px;font-size:11px;color:#8B5CF6;animation:note-drift 2.5s ease-in-out infinite 0.9s;">♫</span>
        <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><rect x="3" y="9" width="6" height="8" rx="1" fill="#8B5CF6" opacity="0.7"/><path d="M9 7L17 4L17 22L9 19Z" fill="#8B5CF6"/><path d="M19 8Q22 13 19 18" stroke="#8B5CF6" stroke-width="1.5" stroke-linecap="round" fill="none"><animate attributeName="opacity" values="0.3;1;0.3" dur="2s" repeatCount="indefinite"/></path></svg>
        <div><div style="font-size:12px;font-weight:700;color:#5B21B6;">Spotify → Echo Dot</div><div style="font-size:10px;color:#7C3AED;opacity:0.8;margin-top:1px;">musica + clima silenzioso</div></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:0.5px solid rgba(0,0,0,0.06);margin-top:8px;font-size:12px;"><span style="color:#9CA3AF;">Lampada Parentesi</span><span style="font-weight:600;color:${lampOn?'#D97706':'#9CA3AF'};">${lampOn?'già accesa':'spenta'}</span></div>
    </div>
  </div>

  <!-- IPAD -->
  <div class="card">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;">
      <div><div style="font-size:14px;font-weight:700;color:#111827;">Ricarica iPad</div><div style="font-size:11px;color:#9CA3AF;margin-top:2px;">Zona sicura ${ipadLow}–${ipadHigh}%</div></div>
      <button class="toggle-switch${ipadAuto?.state==='on'?' on':''}" onclick="toggleAutomation('automation.ricarica_ipad','')"></button>
    </div>
    <div style="display:flex;align-items:center;gap:12px;padding:8px 0;">
      <div style="position:relative;width:52px;height:28px;border:2px solid #22C55E;border-radius:6px;padding:3px;display:flex;align-items:center;">
        <div style="height:100%;border-radius:3px;background:#22C55E;animation:batt-fill 3s ease-in-out infinite alternate;"></div>
        <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="none"><path d="M6 1L2 7H5L4 13L8 7H5Z" fill="#22C55E"><animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite"/></path></svg>
        </div>
        <div style="position:absolute;right:-6px;top:50%;transform:translateY(-50%);width:4px;height:11px;background:#22C55E;border-radius:0 3px 3px 0;"></div>
      </div>
      <div>
        <div style="font-size:24px;font-weight:800;letter-spacing:-1px;line-height:1;color:#15803D;" id="ipad-pct">${ipadPct}%</div>
        <div style="font-size:10px;color:#9CA3AF;margin-top:2px;" id="ipad-sub">zona sicura (${ipadLow}–${ipadHigh}%)</div>
      </div>
    </div>
    <div style="position:relative;height:8px;background:#F3F4F6;border-radius:4px;margin:6px 0;">
      <div id="ipad-bar-fill" style="height:100%;border-radius:4px;background:#22C55E;width:${ipadPct}%;transition:width 0.5s ease;"></div>
      <div style="position:absolute;top:-4px;left:${ipadLow}%;width:2px;height:16px;background:#EF4444;border-radius:1px;"></div>
      <div style="position:absolute;top:-4px;left:${ipadHigh}%;width:2px;height:16px;background:#F59E0B;border-radius:1px;"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:#9CA3AF;margin-bottom:10px;">
      <span>0%</span><span style="color:#EF4444;font-weight:600;">${ipadLow}%</span>
      <span style="color:#22C55E;font-weight:600;">${ipadPct}%</span>
      <span style="color:#F59E0B;font-weight:600;">${ipadHigh}%</span><span>100%</span>
    </div>
    ${ipadPct < ipadLow ? statoRow('s-on','','Batteria bassa','Presa iPad accesa — ricarica in corso') :
      ipadPct > ipadHigh ? statoRow('s-idle','','Batteria carica','Presa iPad spenta — stop ricarica') :
      `<div class="stato s-idle"><div class="stato-text"><div class="stato-title"><span class="ind idle"></span>Zona sicura</div><div class="stato-desc">Nessuna azione necessaria</div></div></div>`}
    <div style="margin-top:12px;padding-top:10px;border-top:0.5px solid rgba(0,0,0,0.07);display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#9CA3AF;">
      <div>Ultima: <strong style="color:#374151;">${fmtDate(ipadAuto?.attributes?.last_triggered)}</strong></div>
    </div>
  </div>
</div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: STATISTICHE
   ═══════════════════════════════════════════════════════ */
function statistiche() {
  const kpiCard = (id, col, lbl) => {
    const v = parseFloat(S[id]?.state)||0;
    const txt = id.includes('potenza')||id.includes('carico') ? (v>=1000?(v/1000).toFixed(2)+' kW':Math.round(v)+' W') : v.toFixed(2)+' kWh';
    return `<div class="kpi-card" style="border-color:${col};"><div class="kpi-val" style="color:${col};">${txt}</div><div class="kpi-lbl">${lbl}</div></div>`;
  };
  const chartCard = (id, title, sub) => `
    <div class="chart-card">
      <div class="chart-header"><div><div class="chart-title">${title}</div><div class="chart-sub">${sub}</div></div></div>
      <div class="chart-wrap"><div class="loading" id="load-${id}"><div class="spinner"></div>Caricamento...</div><canvas id="chart-${id}" style="display:none;"></canvas></div>
    </div>`;

  return `
<div style="padding:14px 28px;height:calc(100vh - 52px);overflow-y:auto;overflow-x:hidden;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
    <div class="page-title">📊 Statistiche</div>
    <div class="period-selector">
      <button class="period-btn active" onclick="setPeriod(1,this)">Oggi</button>
      <button class="period-btn" onclick="setPeriod(7,this)">7 giorni</button>
      <button class="period-btn" onclick="setPeriod(30,this)">30 giorni</button>
      <button class="period-btn" onclick="setPeriod(90,this)">3 mesi</button>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:10px;">
    ${kpiCard('sensor.growatt_energia_prodotta_oggi','#D97706','Energia prodotta')}
    ${kpiCard('sensor.growatt_energia_prelevata_rete_totale','#DC2626','Prelevata dalla rete')}
    ${kpiCard('sensor.growatt_energia_ceduta_rete_totale','#15803D','Ceduta alla rete')}
    ${kpiCard('sensor.growatt_carico_locale_oggi','#1D4ED8','Consumo casa')}
    ${kpiCard('sensor.sala_daily_energy','#6D28D9','Consumo split')}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
    ${chartCard('solare','☀️ Produzione solare','Growatt — kWh')}
    ${chartCard('batt','🔋 Batteria SOC','Growatt — %')}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
    ${chartCard('temp','🌡️ Temperature stanze','Soggiorno · 1° Piano · Camera')}
    ${chartCard('umid','💧 Umidità stanze','Soggiorno · 1° Piano · Camera')}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px;">
    ${chartCard('cucina','🔥 Forno & Piano cottura','Consumo stimato — W')}
    ${chartCard('lavaggio','🫧 Lavastoviglie & Lavatrice','Consumo stimato — W')}
    ${chartCard('prese','🌬️ VMC & Presa Shuko','Consumo reale misurato — W')}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
    ${chartCard('rete','🔌 Rete elettrica','Prelevata vs Ceduta')}
    ${chartCard('sala','❄️ Energia Split Sala','Riscaldamento · Raffreddamento')}
    ${chartCard('sopp','❄️ Energia Split Soppalco','Riscaldamento · Raffreddamento')}
  </div>
</div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: SISTEMA
   ═══════════════════════════════════════════════════════ */
function sistema() {
  const tr = (l,v,cls='') => `<div class="info-row"><span class="il">${l}</span><span class="iv${cls?' '+cls:''}">${v}</span></div>`;
  const rpiOn   = S['binary_sensor.rpi_power_status']?.state === 'on';
  const wanOn   = S['binary_sensor.internetgatewaydevicev2_fritz_box_5690_pro_stato_della_wan']?.state === 'on';
  const cloudOn = S['binary_sensor.remote_ui']?.state === 'on';
  const updBadge = (id, label) => { const s=S[id]?.state; const cls=s==='on'?'badge-available':s==='off'?'badge-uptodate':'badge-uptodate'; const txt=s==='on'?'Disponibile':s==='off'?'Aggiornato':'--'; return `<div class="update-row"><span style="font-size:12px;color:#374151;font-weight:500;">${label}</span><span class="update-badge ${cls}">${txt}</span></div>`; };
  const battRow = (fillId, pctId, name, val) => { const pct=Math.round(parseFloat(val)||0); const c=pct>50?'#22C55E':pct>20?'#F59E0B':'#EF4444'; return `<div class="batt-row"><div class="batt-name">${name}</div><div class="batt-track"><div class="batt-fill" id="${fillId}" style="width:${pct}%;background:${c};"></div></div><div class="batt-pct" id="${pctId}" style="color:${c};">${pct}%</div></div>`; };
  const connDev = (name, icon, bg, on) => `<div class="device-row"><div class="device-icon" style="background:${bg};">${icon}</div><div class="device-name">${name}</div><div class="device-stato"><span class="ind ${on?'on':'off'}"></span><span style="color:${on?'#15803D':'#B91C1C'};">${on?'Connesso':'Non connesso'}</span></div></div>`;
  const toner   = Math.round(parseFloat(S['sensor.hp_laser_mfp_137fnw_black_toner_s_n_crum_210806a4b0b']?.state)||0);
  const tonerC  = toner>30?'#1C2333':toner>10?'#F59E0B':'#EF4444';
  const repTemp = fmtFloat(S['sensor.fritz_repeater_6000_temperatura_cpu']?.state);
  const cs = (id, def=0) => Math.round(parseFloat(S[id]?.state)||def);
  const csTot   = cs('sensor.consumo_stimato_forno')+cs('sensor.consumo_stimato_piano_cottura')+cs('sensor.consumo_stimato_lavastoviglie')+cs('sensor.consumo_stimato_lavatrice')+90+cs('sensor.sonoff_s60zbtpf_potenza')+cs('sensor.presa_shuko_smart_potenza');

  return `
<div style="padding:16px 28px;height:calc(100vh - 52px);overflow:hidden;display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:auto 1fr;gap:10px;align-items:start;">
  <div style="grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;align-items:end;">
    <div><div class="page-title" style="font-size:22px;">⚙️ Sistema</div><div class="col-label">Raspberry Pi & HA</div></div>
    <div class="col-label" style="align-self:end;">Rete Fritz!Box</div>
    <div class="col-label" style="align-self:end;">Dispositivi & Batterie</div>
  </div>

  <!-- COL 1 -->
  <div style="display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;">
    <div class="card">
      <div style="display:flex;align-items:center;gap:12px;padding:6px 0;margin-bottom:2px;">
        <div style="width:48px;height:48px;border-radius:50%;background:${rpiOn?'#F0FDF4':'#FEF2F2'};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="${rpiOn?'#22C55E':'#EF4444'}" stroke-width="1.5" fill="none"/><path d="M12 8v4l3 3" stroke="${rpiOn?'#22C55E':'#EF4444'}" stroke-width="1.5" stroke-linecap="round"/></svg>
        </div>
        <div style="flex:1;"><div style="font-size:16px;font-weight:700;color:#111827;">Raspberry Pi</div><div style="font-size:11px;color:#9CA3AF;margin-top:2px;">Home Assistant OS</div></div>
        <div style="display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:${rpiOn?'#15803D':'#B91C1C'};"><span class="ind ${rpiOn?'on':'off'}"></span>${rpiOn?'Online':'Offline'}</div>
      </div>
      ${tr('IP locale','192.168.188.43')}
      ${tr('Versione Core','2026.3.1','iv-blue')}
      ${tr('Cloud Nabu Casa',cloudOn?'● Online':'● Offline',cloudOn?'iv-green':'iv-red')}
    </div>
    <div class="card">
      <div class="card-title" style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;">Backup automatici</div>
      ${tr('Stato manager',S['sensor.backup_backup_manager_state']?.state||'--')}
      ${tr('Ultimo riuscito',fmtDate(S['sensor.backup_last_successful_automatic_backup']?.state),'iv-green')}
      ${tr('Prossimo backup',fmtDate(S['sensor.backup_next_scheduled_automatic_backup']?.state),'iv-blue')}
    </div>
    <div class="card">
      <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Aggiornamenti sistema</div>
      ${updBadge('update.home_assistant_core_update','Home Assistant Core')}
      ${updBadge('update.home_assistant_supervisor_update','Supervisor')}
      ${updBadge('update.home_assistant_operating_system_update','OS')}
      ${updBadge('update.hacs_update','HACS')}
      ${updBadge('update.file_editor_update','File Editor')}
    </div>
  </div>

  <!-- COL 2 -->
  <div style="display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;">
    <div class="card">
      <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Connessione WAN</div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);font-size:12px;"><span style="color:#9CA3AF;">Stato WAN</span><span style="display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:${wanOn?'#15803D':'#B91C1C'};"><span class="ind ${wanOn?'on':'off'}"></span>${wanOn?'Online':'Offline'}</span></div>
      ${tr('IP esterno',S['sensor.internetgatewaydevicev2_fritz_box_5690_pro_ip_esterno']?.state||'--','iv-blue')}
      ${tr('Download',fmtSpeed(S['sensor.internetgatewaydevicev2_fritz_box_5690_pro_velocita_di_scaricamento']?.state),'iv-green')}
      ${tr('Upload',fmtSpeed(S['sensor.internetgatewaydevicev2_fritz_box_5690_pro_velocita_di_caricamento']?.state),'iv-blue')}
    </div>
    <div class="card">
      <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Fritz Repeater 6000</div>
      ${tr('Temperatura CPU',repTemp+'°C',parseFloat(repTemp)>70?'iv-red':'')}
      ${tr('Ultimo riavvio',fmtDate(S['sensor.fritz_repeater_6000_ultimo_riavvio']?.state))}
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="action-btn btn-blue" style="flex:1;" onclick="callSvc('button','press',{entity_id:'button.fritz_repeater_6000_riconnetti'})">↩ Riconnetti</button>
        <button class="action-btn btn-gray" style="flex:1;" onclick="callSvc('button','press',{entity_id:'button.fritz_repeater_6000_riavvia'})">↺ Riavvia</button>
      </div>
    </div>
    <div class="card">
      <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Stampante HP LaserJet</div>
      ${tr('Stato',S['sensor.hp_laser_mfp_137fnw']?.state||'--')}
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:12px;"><span style="color:#9CA3AF;">Toner nero</span><span style="font-weight:600;color:${tonerC};">${toner}%</span></div>
      <div style="height:5px;background:#F3F4F6;border-radius:3px;overflow:hidden;"><div style="height:100%;border-radius:3px;background:${tonerC};width:${toner}%;transition:width 0.5s ease;"></div></div>
    </div>
    <div class="card">
      <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Growatt — Inverter</div>
      ${tr('Stato',S['sensor.growatt_stato']?.state||'--')}
      ${tr('Temperatura',fmtFloat(S['sensor.growatt_temperatura']?.state)+'°C')}
      ${tr('Tensione L1',fmtFloat(S['sensor.growatt_tensione_rete_l1']?.state)+' V')}
      ${tr('Frequenza rete',fmtFloat(S['sensor.growatt_frequenza_rete']?.state,2)+' Hz')}
    </div>
  </div>

  <!-- COL 3 -->
  <div style="display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:0;">
    <div class="card">
      <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Batterie sensori Zigbee</div>
      ${battRow('batt-fill-soggiorno','batt-pct-soggiorno','Soggiorno',S['sensor.piano_terra_a_stato_della_batteria']?.state)}
      ${battRow('batt-fill-piano','batt-pct-piano','1° Piano',S['sensor.primo_piano_b_stato_della_batteria']?.state)}
      ${battRow('batt-fill-camera','batt-pct-camera','Camera da letto',S['sensor.termostato_camera_da_letto_batteria']?.state)}
    </div>
    <div class="card">
      <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Connettività elettrodomestici</div>
      ${connDev('Forno Siemens','🔥','#FFF7ED',S['binary_sensor.forno_connettivita']?.state==='on')}
      ${connDev('Piano cottura','🍳','#FEF2F2',S['binary_sensor.piano_cottura_connettivita']?.state==='on')}
      ${connDev('Lavastoviglie Siemens','🫧','#F0FDFA',S['binary_sensor.lavastoviglie_connettivita']?.state==='on')}
      ${connDev('Congelatore Miele','🧊','#E0F2FE',S['binary_sensor.congelatore_connettivita']?.state==='on')}
      ${connDev('PDC Aquarea','🌊','#FFF7ED',S['water_heater.aquarea_tank']?.state!=='unavailable'&&S['water_heater.aquarea_tank']?.state!=='unknown')}
    </div>
    <div class="card">
      <div style="font-size:11px;font-weight:600;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">Consumi stimati ora</div>
      ${[['Forno','sensor.consumo_stimato_forno'],['Piano cottura','sensor.consumo_stimato_piano_cottura'],['Lavastoviglie','sensor.consumo_stimato_lavastoviglie'],['Lavatrice','sensor.consumo_stimato_lavatrice']].map(([l,id])=>{const v=cs(id);return `<div class="info-row"><span class="il">${l}</span><span class="iv" style="${v>0?'color:#C2410C;font-weight:600;':''}">${v} W</span></div>`;}).join('')}
      <div class="info-row"><span class="il">Congelatore</span><span class="iv">90 W</span></div>
      <div class="info-row"><span class="il">VMC (reale)</span><span class="iv iv-blue">${cs('sensor.sonoff_s60zbtpf_potenza')} W</span></div>
      <div class="info-row"><span class="il">Presa Shuko (reale)</span><span class="iv iv-blue">${cs('sensor.presa_shuko_smart_potenza')} W</span></div>
      <div style="border-top:1px solid rgba(0,0,0,0.08);padding-top:8px;margin-top:4px;display:flex;justify-content:space-between;font-size:12px;">
        <span style="color:#9CA3AF;">Totale stimato</span>
        <span style="font-weight:800;font-size:14px;color:#1C2333;">${csTot} W</span>
      </div>
    </div>
  </div>
</div>`;
}

/* ═══════════════════════════════════════════════════════
   VIEW: IMPOSTAZIONI
   ═══════════════════════════════════════════════════════ */
function impostazioni() {
  const sliderRow = (key, lbl, entity, unit, min, max, step, def, color='#1C2333', plus=false) => {
    const v = getN(entity, def);
    return `<div class="slider-row">
      <div class="slider-header"><span class="slider-label">${lbl}</span><span class="slider-value" id="val-${key}" style="color:${color};">${plus&&v>0?'+':''}${v}${unit}</span></div>
      <input type="range" id="sl-${key}" min="${min}" max="${max}" step="${step}" value="${v}"
        oninput="updateSlider('${key}','${unit}','${entity}',${plus})"
        onchange="saveSlider('${entity}',this.value)">
    </div>`;
  };
  const mv = S['input_select.modalita_casa']?.state || 'Auto';
  const bypassClima= S['input_boolean.bypass_clima']?.state === 'on';
  const bypassIpad = S['input_boolean.bypass_ipad']?.state === 'on';
  const tpVal = S['input_datetime.parentesi_orario_spegnimento']?.state?.substring(0,5) || '01:00';
  const refs  = [['Temp. esterna','sensor.aquarea_outside_temperature','°C'],['Temp. soggiorno','sensor.piano_terra_a_temperatura','°C'],['Umidità soggiorno','sensor.piano_terra_a_umidita','%'],['Umidità 1° piano','sensor.primo_piano_b_umidita','%'],['Umidità camera','sensor.termostato_camera_da_letto_umidita','%'],['Batteria iPad','sensor.ipad_battery_level','%']];

  return `
<div style="padding:20px 28px;">
  <div class="page-title" style="margin-bottom:20px;">⚙️ Impostazioni</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;align-items:start;">

    <!-- COL 1 -->
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div class="card">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:8px;">🏠 Modalità casa</div>
        <div style="font-size:12px;color:#9CA3AF;margin-bottom:10px;">Controlla come lavorano tutte le automazioni</div>
        <div style="display:flex;gap:6px;">
          <button class="mode-btn${mv==='Auto'?' active-auto':''}" id="mode-auto" onclick="setModalita('Auto')">✓ Auto</button>
          <button class="mode-btn${mv==='Manuale'?' active-manuale':''}" id="mode-manuale" onclick="setModalita('Manuale')">✋ Manuale</button>
          <button class="mode-btn${mv==='Vacanza'?' active-vacanza':''}" id="mode-vacanza" onclick="setModalita('Vacanza')">✈ Vacanza</button>
        </div>
        ${mv!=='Auto'?`<div style="background:#FEF3C7;border-radius:10px;padding:8px 10px;font-size:11px;color:#92400E;margin-top:10px;" id="alert-modalita">⚠ Modalità ${mv} — le automazioni sono in pausa</div>`:''}
      </div>
      <div class="card">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:14px;">🌬️ VMC — Soglie temperatura</div>
        ${sliderRow('vmc-off','Soglia spegnimento','input_number.vmc_soglia_spegnimento','°C',20,35,0.5,26,'#EF4444')}
        ${sliderRow('vmc-on','Soglia accensione','input_number.vmc_soglia_accensione','°C',20,35,0.5,25.5,'#22C55E')}
      </div>
      <div class="card">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:14px;">🌡️ Split — Temperatura</div>
        ${sliderRow('target','Target (obiettivo)','input_number.clima_temp_target','°C',18,30,0.5,24,'#2196F3')}
        ${sliderRow('cool','Accende in cool sopra','input_number.clima_soglia_raffreddamento','°C',20,30,0.5,25,'#2196F3')}
        ${sliderRow('heat','Accende in heat sotto','input_number.clima_soglia_riscaldamento','°C',18,26,0.5,23,'#EA580C')}
        ${sliderRow('estate','Soglia estate (est. >)','input_number.clima_soglia_estate','°C',10,25,1,18,'#F59E0B')}
        ${sliderRow('inverno','Soglia inverno (est. <)','input_number.clima_soglia_inverno','°C',5,20,1,16,'#8B5CF6')}
      </div>
    </div>

    <!-- COL 2 -->
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div class="card">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:14px;">💧 Split — Soglie umidità (Dry)</div>
        ${sliderRow('dry-on','Attiva dry sopra','input_number.clima_dry_on','%',40,80,1,60,'#2196F3')}
        ${sliderRow('dry-off','Disattiva dry sotto','input_number.clima_dry_off','%',40,80,1,55,'#22C55E')}
      </div>
      <div class="card">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:14px;">📱 Ricarica iPad</div>
        ${sliderRow('ipad-low','Avvia ricarica sotto','input_number.ipad_soglia_ricarica','%',5,50,5,20,'#EF4444')}
        ${sliderRow('ipad-high','Stop ricarica sopra','input_number.ipad_soglia_stop','%',50,100,5,80,'#22C55E')}
      </div>
      <div class="card">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:14px;">💡 Parentesi — Orari</div>
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);">
          <span style="font-size:13px;color:#374151;font-weight:500;">Orario spegnimento</span>
          <input type="time" id="tp-parentesi" value="${tpVal}" onchange="saveTime('input_datetime.parentesi_orario_spegnimento',this.value)">
        </div>
        ${sliderRow('offset','Offset tramonto','input_number.parentesi_offset_tramonto',' min',0,60,5,10,'#F59E0B',true)}
      </div>
    </div>

    <!-- COL 3 -->
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div class="card">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:8px;">🔒 Bypass automazioni</div>
        <div style="font-size:12px;color:#9CA3AF;margin-bottom:12px;">Disattiva singole automazioni per interventi manuali</div>
        <div class="toggle-row">
          <div><div class="toggle-label">Modalità manuale clima</div><div style="font-size:11px;color:#9CA3AF;margin-top:2px;">Sospende l'automazione VMC e split</div></div>
          <button class="toggle-switch${bypassClima?' on':''}" id="tog-bypass-clima" onclick="toggleBoolean('input_boolean.bypass_clima','tog-bypass-clima','alert-bypass-clima')"></button>
        </div>
        ${bypassClima?`<div style="background:#FEF3C7;border-radius:10px;padding:8px;font-size:11px;color:#92400E;margin:4px 0 8px;" id="alert-bypass-clima">⚠ Clima in modalità manuale</div>`:'<div id="alert-bypass-clima"></div>'}
        <div class="toggle-row">
          <div><div class="toggle-label">Pausa ricarica iPad</div><div style="font-size:11px;color:#9CA3AF;margin-top:2px;">Disattiva la gestione automatica della presa iPad</div></div>
          <button class="toggle-switch${bypassIpad?' on':''}" id="tog-bypass-ipad" onclick="toggleBoolean('input_boolean.bypass_ipad','tog-bypass-ipad','alert-bypass-ipad')"></button>
        </div>
        ${bypassIpad?`<div style="background:#FEF3C7;border-radius:10px;padding:8px;font-size:11px;color:#92400E;margin-top:4px;" id="alert-bypass-ipad">⚠ Ricarica iPad in pausa</div>`:'<div id="alert-bypass-ipad"></div>'}
      </div>
      <div class="card">
        <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:8px;">📊 Valori sensori ora</div>
        <div style="font-size:12px;color:#9CA3AF;margin-bottom:10px;">Riferimento per calibrare le soglie</div>
        ${refs.map(([l,id,u])=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:0.5px solid rgba(0,0,0,0.06);font-size:12px;"><span style="color:#9CA3AF;">${l}</span><span style="font-weight:600;">${fmtFloat(S[id]?.state)}${u}</span></div>`).join('')}
      </div>
    </div>
  </div>
</div>
<div class="save-toast" id="save-toast">✓ Salvato</div>`;
}
