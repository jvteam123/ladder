/* ================================================================
   OPEN PLAY / HOST A GAME — Reclub-style discovery & RSVP
   ------------------------------------------------------------------
   This module is intentionally separate from the core ladder engine
   (script.js). It adds two new tabs — Discover and Host — for
   posting/finding open play games across devices.

   DATA LAYER: `OpenPlayAPI` below is a MOCK backend (localStorage,
   single device only) so the full UI can be built and clicked through
   today. Every method is async and shaped exactly like the future
   Supabase calls will be, so swapping the body of each method for a
   real `supabase.from(...)` call is a drop-in change — no UI code
   needs to change. See OPEN_PLAY_DESIGN.md for the real schema.
   ================================================================ */

(function(){

/* ---------------- MOCK BACKEND (swap for Supabase later) ---------------- */

const OP_KEYS = { user: 'op_user_v1', events: 'op_events_v1', rsvps: 'op_rsvps_v1' };

function opRead(key, fallback){
  try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch(e){ return fallback; }
}
function opWrite(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} }

const OpenPlayAPI = {
  // ----- auth (mock: local display-name profile; real version = Supabase Auth) -----
  async getCurrentUser(){
    return opRead(OP_KEYS.user, null);
  },
  async signIn(displayName){
    const user = { id: uid('user'), display_name: displayName.trim(), created_at: Date.now() };
    opWrite(OP_KEYS.user, user);
    return user;
  },
  async signOut(){
    localStorage.removeItem(OP_KEYS.user);
  },

  // ----- events -----
  async listEvents(){
    const events = opRead(OP_KEYS.events, []);
    const rsvps = opRead(OP_KEYS.rsvps, []);
    return events
      .filter(e => e.status !== 'cancelled')
      .map(e => ({ ...e, rsvp_count: rsvps.filter(r => r.event_id === e.id && r.status === 'confirmed').length }))
      .sort((a,b) => new Date(a.start_time) - new Date(b.start_time));
  },
  async createEvent(payload, host){
    const events = opRead(OP_KEYS.events, []);
    const event = {
      id: uid('evt'),
      host_id: host.id,
      host_name: host.display_name,
      status: 'open',
      created_at: Date.now(),
      ...payload
    };
    events.push(event);
    opWrite(OP_KEYS.events, events);
    return event;
  },
  async cancelEvent(eventId){
    const events = opRead(OP_KEYS.events, []);
    const ev = events.find(e => e.id === eventId);
    if(ev) ev.status = 'cancelled';
    opWrite(OP_KEYS.events, events);
  },

  // ----- rsvps -----
  async listRsvpsForEvent(eventId){
    return opRead(OP_KEYS.rsvps, []).filter(r => r.event_id === eventId && r.status === 'confirmed');
  },
  async myRsvpForEvent(eventId, userId){
    return opRead(OP_KEYS.rsvps, []).find(r => r.event_id === eventId && r.player_id === userId && r.status === 'confirmed') || null;
  },
  async rsvp(eventId, user){
    const rsvps = opRead(OP_KEYS.rsvps, []);
    const existing = rsvps.find(r => r.event_id === eventId && r.player_id === user.id);
    if(existing){ existing.status = 'confirmed'; }
    else{ rsvps.push({ id: uid('rsvp'), event_id: eventId, player_id: user.id, player_name: user.display_name, status: 'confirmed', created_at: Date.now() }); }
    opWrite(OP_KEYS.rsvps, rsvps);
  },
  async cancelRsvp(eventId, user){
    const rsvps = opRead(OP_KEYS.rsvps, []);
    const existing = rsvps.find(r => r.event_id === eventId && r.player_id === user.id);
    if(existing) existing.status = 'cancelled';
    opWrite(OP_KEYS.rsvps, rsvps);
  }
};
window.OpenPlayAPI = OpenPlayAPI; // exposed for later real-backend swap / debugging

/* ---------------- local UI state ---------------- */
const opUI = { user: null, events: [], loading: true, hostDraft: null };

async function opBoot(){
  opUI.user = await OpenPlayAPI.getCurrentUser();
  opUI.events = await OpenPlayAPI.listEvents();
  opUI.loading = false;
}

/* ---------------- nav wiring ---------------- */
function opAddNavSections(){
  if(!window.NAV_SECTIONS) return;
  const already = NAV_SECTIONS.some(s => s.id === 'discover');
  if(already) return;
  NAV_SECTIONS.push(
    { id: 'discover', label: 'Discover', desc: 'Find open play near you',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' },
    { id: 'host', label: 'Host', desc: 'Post an open play game',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>' }
  );
}

// Wrap the core renderActiveView so 'discover' / 'host' render without touching script.js
const _coreRenderActiveView = window.renderActiveView;
window.renderActiveView = function(){
  if(state && (state.tab === 'discover' || state.tab === 'host')){
    const target = document.getElementById('view');
    if(state.tab === 'discover') renderDiscoverView(target);
    else renderHostView(target);
    return;
  }
  return _coreRenderActiveView.apply(this, arguments);
};

/* ---------------- shared bits ---------------- */
function fmtWhen(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}

function signInPrompt(afterLabel){
  return `
    <div class="op-signin-card">
      <div class="op-signin-title">Sign in to ${esc(afterLabel)}</div>
      <div class="op-signin-sub">Just a display name for now — this stands in for real account sign-in once the backend is connected.</div>
      <input type="text" id="opSignInName" class="op-input" placeholder="Your name" maxlength="40" />
      <button class="btn btn-primary btn-block" data-action="op-sign-in">Continue</button>
    </div>`;
}

/* ---------------- DISCOVER view ---------------- */
function renderDiscoverView(el){
  if(opUI.loading){
    el.innerHTML = `<div class="op-empty">Loading open play…</div>`;
    return;
  }
  if(!opUI.user){
    el.innerHTML = `<div class="op-wrap">${signInPrompt('browse open play')}</div>`;
    return;
  }

  const events = opUI.events.filter(e => e.status === 'open');

  el.innerHTML = `
    <div class="op-wrap">
      <div class="op-header">
        <div>
          <div class="op-h-title">Discover</div>
          <div class="op-h-sub">Open play games posted by the community</div>
        </div>
        <button class="btn btn-primary btn-sm" data-action="tab" data-tab="host">+ Host</button>
      </div>
      ${events.length === 0 ? `
        <div class="op-empty">
          No open games posted yet.<br/>Be the first — tap <b>Host</b> to post one.
        </div>
      ` : `
        <div class="op-event-list">
          ${events.map(opEventCard).join('')}
        </div>
      `}
    </div>
  `;
}

function opEventCard(ev){
  const full = ev.max_players && ev.rsvp_count >= ev.max_players;
  return `
    <div class="op-card" data-action="op-open-event" data-id="${ev.id}">
      <div class="op-card-top">
        <div class="op-card-title">${esc(ev.title)}</div>
        ${full ? '<span class="op-badge op-badge-full">Full</span>' : '<span class="op-badge op-badge-open">Open</span>'}
      </div>
      <div class="op-card-row">📍 ${esc(ev.location_name)}</div>
      <div class="op-card-row">🗓️ ${fmtWhen(ev.start_time)}</div>
      <div class="op-card-row">👥 ${ev.rsvp_count || 0}${ev.max_players ? ' / ' + ev.max_players : ''} players · hosted by ${esc(ev.host_name)}</div>
    </div>
  `;
}

async function opOpenEventDetail(eventId){
  const ev = opUI.events.find(e => e.id === eventId);
  if(!ev) return;
  const myRsvp = await OpenPlayAPI.myRsvpForEvent(eventId, opUI.user.id);
  const isHost = ev.host_id === opUI.user.id;
  const full = ev.max_players && ev.rsvp_count >= ev.max_players && !myRsvp;

  openModal(`
    <div class="modal-title">${esc(ev.title)}</div>
    <div class="modal-sub">Hosted by ${esc(ev.host_name)}</div>
    <div class="op-detail-rows">
      <div class="op-detail-row">📍 <span>${esc(ev.location_name)}</span></div>
      <div class="op-detail-row">🗓️ <span>${fmtWhen(ev.start_time)}</span></div>
      <div class="op-detail-row">👥 <span>${ev.rsvp_count || 0}${ev.max_players ? ' / ' + ev.max_players : ''} players</span></div>
      ${(ev.skill_min || ev.skill_max) ? `<div class="op-detail-row">🎯 <span>Rating ${ev.skill_min || '—'}–${ev.skill_max || '—'}</span></div>` : ''}
      ${ev.fee_amount ? `<div class="op-detail-row">💵 <span>${esc(String(ev.fee_amount))}${ev.fee_note ? ' — ' + esc(ev.fee_note) : ''}</span></div>` : ''}
    </div>
    <div class="op-detail-actions">
      ${isHost
        ? `<button class="op-btn-danger" data-action="op-cancel-event" data-id="${ev.id}">Cancel this event</button>`
        : myRsvp
          ? `<button class="btn btn-ghost btn-block" data-action="op-leave-event" data-id="${ev.id}">Leave / Cancel RSVP</button>`
          : `<button class="btn btn-primary btn-block" data-action="op-join-event" data-id="${ev.id}" ${full ? 'disabled' : ''}>${full ? 'Event Full' : 'Join'}</button>`
      }
      <button class="btn btn-ghost btn-block" data-action="op-share-event" data-id="${ev.id}">Copy shareable link</button>
      <button class="btn btn-ghost btn-block" data-action="modal-close">Close</button>
    </div>
  `);
}

/* ---------------- HOST view ---------------- */
function renderHostView(el){
  if(opUI.loading){
    el.innerHTML = `<div class="op-empty">Loading…</div>`;
    return;
  }
  if(!opUI.user){
    el.innerHTML = `<div class="op-wrap">${signInPrompt('host a game')}</div>`;
    return;
  }

  const myEvents = opUI.events.filter(e => e.host_id === opUI.user.id && e.status === 'open');

  el.innerHTML = `
    <div class="op-wrap">
      <div class="op-header">
        <div>
          <div class="op-h-title">Host a Game</div>
          <div class="op-h-sub">Post an open play — others can discover and join</div>
        </div>
      </div>

      <form id="opHostForm" class="op-form">
        <label class="op-label">Title
          <input class="op-input" name="title" placeholder="Saturday Morning Open Play" required />
        </label>
        <label class="op-label">Location
          <input class="op-input" name="location_name" placeholder="Marian Lakeview Park Subd" required />
        </label>
        <div class="op-form-row">
          <label class="op-label">Date
            <input class="op-input" type="date" name="date" required />
          </label>
          <label class="op-label">Time
            <input class="op-input" type="time" name="time" required />
          </label>
        </div>
        <div class="op-form-row">
          <label class="op-label">Max players
            <input class="op-input" type="number" name="max_players" min="2" max="64" value="8" />
          </label>
          <label class="op-label">Fee (optional)
            <input class="op-input" name="fee_amount" placeholder="₱300" />
          </label>
        </div>
        <div class="op-form-row">
          <label class="op-label">Min rating (optional)
            <input class="op-input" type="number" step="0.1" name="skill_min" placeholder="3.0" />
          </label>
          <label class="op-label">Max rating (optional)
            <input class="op-input" type="number" step="0.1" name="skill_max" placeholder="4.5" />
          </label>
        </div>
        <button type="submit" class="btn btn-primary btn-block" data-action="op-noop">Post Open Play</button>
      </form>

      ${myEvents.length ? `
        <div class="op-h-title" style="margin-top:22px;">Your posted games</div>
        <div class="op-event-list">${myEvents.map(opEventCard).join('')}</div>
      ` : ''}
    </div>
  `;

  const form = document.getElementById('opHostForm');
  if(form){
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      const fd = new FormData(form);
      const date = fd.get('date'), time = fd.get('time');
      if(!date || !time){ toast('Pick a date and time.', 'error'); return; }
      const start_time = new Date(`${date}T${time}`).toISOString();
      const payload = {
        title: (fd.get('title') || '').trim() || 'Open Play',
        location_name: (fd.get('location_name') || '').trim(),
        start_time,
        max_players: Number(fd.get('max_players')) || null,
        fee_amount: (fd.get('fee_amount') || '').trim() || null,
        skill_min: fd.get('skill_min') ? Number(fd.get('skill_min')) : null,
        skill_max: fd.get('skill_max') ? Number(fd.get('skill_max')) : null,
      };
      const ev = await OpenPlayAPI.createEvent(payload, opUI.user);
      opUI.events = await OpenPlayAPI.listEvents();
      toast('Open play posted!', 'success');
      state.tab = 'discover';
      saveAll(); renderAll();
      setTimeout(() => opOpenEventDetail(ev.id), 200);
    });
  }
}

/* ---------------- click delegation for open-play actions ---------------- */
document.addEventListener('click', async function(e){
  const t = e.target.closest('[data-action]');
  if(!t) return;
  const action = t.dataset.action;
  if(!action || action.indexOf('op-') !== 0) return;

  switch(action){
    case 'op-sign-in': {
      const input = document.getElementById('opSignInName');
      const name = input ? input.value.trim() : '';
      if(!name){ toast('Enter a name to continue.', 'error'); return; }
      opUI.user = await OpenPlayAPI.signIn(name);
      toast(`Welcome, ${name}!`, 'success');
      renderActiveView();
      break;
    }
    case 'op-open-event': {
      await opOpenEventDetail(t.dataset.id);
      break;
    }
    case 'op-join-event': {
      await OpenPlayAPI.rsvp(t.dataset.id, opUI.user);
      opUI.events = await OpenPlayAPI.listEvents();
      toast("You're in! RSVP confirmed.", 'success');
      closeModal();
      renderActiveView();
      break;
    }
    case 'op-leave-event': {
      await OpenPlayAPI.cancelRsvp(t.dataset.id, opUI.user);
      opUI.events = await OpenPlayAPI.listEvents();
      toast('RSVP cancelled.', 'success');
      closeModal();
      renderActiveView();
      break;
    }
    case 'op-cancel-event': {
      await OpenPlayAPI.cancelEvent(t.dataset.id);
      opUI.events = await OpenPlayAPI.listEvents();
      toast('Event cancelled.', 'success');
      closeModal();
      renderActiveView();
      break;
    }
    case 'op-share-event': {
      const url = `${location.origin}${location.pathname}#open-play=${t.dataset.id}`;
      try{
        await navigator.clipboard.writeText(url);
        toast('Link copied — share it in your group chat!', 'success');
      }catch(err){
        toast(url, 'default');
      }
      break;
    }
  }
});

/* ---------------- boot ---------------- */
opAddNavSections();
opBoot().then(() => {
  // If the user is already sitting on Discover/Host when data finishes loading, re-render.
  if(window.state && (state.tab === 'discover' || state.tab === 'host')) renderActiveView();
});

})();
