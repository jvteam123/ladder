/* ================================================================
   OPEN PLAY / HOST A GAME — Reclub-style discovery & RSVP
   ------------------------------------------------------------------
   This module is intentionally separate from the core ladder engine
   (script.js). It adds two new tabs — Discover and Host — for
   posting/finding open play games across devices.

   DATA LAYER: `OpenPlayAPI` below is backed by Firebase — Firestore
   for data (live, cross-device, realtime via onSnapshot) and Firebase
   Auth (Google sign-in) for identity. See firebase-init.js for the
   project config / SDK setup that this file depends on.
   ================================================================ */

(function(){

/* ---------------- LIVE BACKEND (Firebase Auth + Firestore) ---------------- */

const EVENTS_COL = 'openPlayEvents';
const RSVPS_COL  = 'openPlayRsvps';

function fbReady(){ return !!(window.fbAuth && window.fbDb); }

function rsvpDocId(eventId, uid){ return eventId + '_' + uid; }

function mapAuthUser(u){
  if(!u) return null;
  return {
    id: u.uid,
    display_name: u.displayName || (u.email ? u.email.split('@')[0] : 'Player'),
    avatar_url: u.photoURL || null,
  };
}

const OpenPlayAPI = {
  // ----- auth (Firebase Auth, Google sign-in) -----
  async getCurrentUser(){
    if(!fbReady()) return null;
    return mapAuthUser(window.fbAuth.currentUser);
  },
  onAuthChange(cb){
    if(!fbReady()) return function(){};
    return window.fbAuth.onAuthStateChanged(function(u){ cb(mapAuthUser(u)); });
  },
  async signInWithGoogle(){
    if(!fbReady()) throw new Error('Sign-in isn\u2019t available right now.');
    try{
      const cred = await window.fbAuth.signInWithPopup(window.fbGoogleProvider);
      return mapAuthUser(cred.user);
    }catch(err){
      // Popups get blocked in some mobile browsers / in-app webviews —
      // fall back to a full-page redirect instead of failing silently.
      const popupIssue = err && (
        err.code === 'auth/popup-blocked' ||
        err.code === 'auth/popup-closed-by-user' ||
        err.code === 'auth/cancelled-popup-request' ||
        err.code === 'auth/operation-not-supported-in-this-environment'
      );
      if(popupIssue && err.code !== 'auth/popup-closed-by-user'){
        await window.fbAuth.signInWithRedirect(window.fbGoogleProvider);
        return null; // page will reload once the redirect flow completes
      }
      throw err;
    }
  },
  async signOut(){
    if(!fbReady()) return;
    await window.fbAuth.signOut();
  },

  // ----- events (live, cross-device via Firestore) -----
  subscribeEvents(onChange, onError){
    if(!fbReady()){ onError && onError(new Error('Firebase not configured.')); return function(){}; }
    return window.fbDb.collection(EVENTS_COL)
      .orderBy('start_time', 'asc')
      .onSnapshot(function(snap){
        onChange(snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); }));
      }, function(err){
        console.error('Open Play events listener error:', err);
        onError && onError(err);
      });
  },
  async createEvent(payload, host){
    const event = Object.assign({
      host_id: host.id,
      host_name: host.display_name,
      host_photo_url: host.avatar_url || null,
      status: 'open',
      rsvp_count: 0,
      created_at: firebase.firestore.FieldValue.serverTimestamp(),
    }, payload);
    const ref = await window.fbDb.collection(EVENTS_COL).add(event);
    return Object.assign({ id: ref.id }, event);
  },
  async cancelEvent(eventId){
    await window.fbDb.collection(EVENTS_COL).doc(eventId).update({ status: 'cancelled' });
  },

  // ----- rsvps -----
  // Returns the caller's live rsvp row (confirmed OR waitlist) — anything
  // that still holds a place in line — or null if they're not in the event.
  async myRsvpForEvent(eventId, userId){
    if(!userId) return null;
    const snap = await window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, userId)).get();
    if(!snap.exists) return null;
    const data = snap.data();
    return (data.status === 'confirmed' || data.status === 'waitlist') ? Object.assign({ id: snap.id }, data) : null;
  },
  // All rsvp rows for an event (any status), sorted oldest-first — used by
  // the host's "Manage joiners" screen. Sorted client-side to avoid needing
  // a composite Firestore index.
  async listRsvpsForEvent(eventId){
    const snap = await window.fbDb.collection(RSVPS_COL).where('event_id', '==', eventId).get();
    const rows = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
    rows.sort(function(a, b){
      const ta = a.created_at && a.created_at.toMillis ? a.created_at.toMillis() : 0;
      const tb = b.created_at && b.created_at.toMillis ? b.created_at.toMillis() : 0;
      return ta - tb;
    });
    return rows;
  },
  // Joins the event. If it's full, the player is placed on the waitlist
  // instead (like Reclub) rather than being turned away outright. Returns
  // the resulting status: 'confirmed' or 'waitlist'.
  async rsvp(eventId, user){
    const eventRef = window.fbDb.collection(EVENTS_COL).doc(eventId);
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, user.id));
    let resultStatus = 'confirmed';
    await window.fbDb.runTransaction(async function(tx){
      const eventSnap = await tx.get(eventRef);
      if(!eventSnap.exists) throw new Error('This event no longer exists.');
      const ev = eventSnap.data();
      const rsvpSnap = await tx.get(rsvpRef);
      const existing = rsvpSnap.exists ? rsvpSnap.data() : null;
      if(existing && (existing.status === 'confirmed' || existing.status === 'waitlist')){
        resultStatus = existing.status;
        return;
      }
      const isFull = ev.max_players && (ev.rsvp_count || 0) >= ev.max_players;
      resultStatus = isFull ? 'waitlist' : 'confirmed';
      tx.set(rsvpRef, {
        event_id: eventId,
        player_id: user.id,
        player_name: user.display_name,
        player_photo_url: user.avatar_url || null,
        status: resultStatus,
        created_at: (existing && existing.created_at) ? existing.created_at : firebase.firestore.FieldValue.serverTimestamp(),
      });
      if(resultStatus === 'confirmed'){
        tx.update(eventRef, { rsvp_count: (ev.rsvp_count || 0) + 1 });
      }
    });
    return resultStatus;
  },
  // Player cancels their own spot (confirmed or waitlisted).
  async cancelRsvp(eventId, user){
    await OpenPlayAPI._releaseSpot(eventId, user.id, 'cancelled');
  },
  // Host removes a joiner from their event (kick). Distinct status from a
  // self-cancel so the host can tell the difference if needed later.
  async removeJoiner(eventId, playerId){
    await OpenPlayAPI._releaseSpot(eventId, playerId, 'removed');
  },
  // Host manually confirms someone off the waitlist (out of order is fine —
  // mirrors Reclub's "confirm joiner" host action).
  async confirmJoiner(eventId, playerId){
    const eventRef = window.fbDb.collection(EVENTS_COL).doc(eventId);
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, playerId));
    await window.fbDb.runTransaction(async function(tx){
      const eventSnap = await tx.get(eventRef);
      if(!eventSnap.exists) throw new Error('This event no longer exists.');
      const ev = eventSnap.data();
      const rsvpSnap = await tx.get(rsvpRef);
      if(!rsvpSnap.exists || rsvpSnap.data().status !== 'waitlist') return;
      if(ev.max_players && (ev.rsvp_count || 0) >= ev.max_players){
        throw new Error('Event is full — remove a player first.');
      }
      tx.update(rsvpRef, { status: 'confirmed' });
      tx.update(eventRef, { rsvp_count: (ev.rsvp_count || 0) + 1 });
    });
  },
  // Shared helper: marks a joiner's rsvp as cancelled/removed, frees their
  // seat if they held a confirmed spot, then bumps the next waitlisted
  // player into it automatically (like Reclub).
  async _releaseSpot(eventId, playerId, newStatus){
    const eventRef = window.fbDb.collection(EVENTS_COL).doc(eventId);
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, playerId));
    let freedSeat = false;
    await window.fbDb.runTransaction(async function(tx){
      const rsvpSnap = await tx.get(rsvpRef);
      if(!rsvpSnap.exists) return;
      const cur = rsvpSnap.data();
      if(cur.status !== 'confirmed' && cur.status !== 'waitlist') return;
      freedSeat = cur.status === 'confirmed';
      tx.update(rsvpRef, { status: newStatus });
      if(freedSeat){
        const eventSnap = await tx.get(eventRef);
        if(eventSnap.exists){
          const ev = eventSnap.data();
          tx.update(eventRef, { rsvp_count: Math.max(0, (ev.rsvp_count || 0) - 1) });
        }
      }
    });
    if(freedSeat) await OpenPlayAPI._promoteNextFromWaitlist(eventId);
  },
  // Bumps the longest-waiting waitlisted player into a newly-freed seat.
  async _promoteNextFromWaitlist(eventId){
    const rows = await OpenPlayAPI.listRsvpsForEvent(eventId);
    const waitlisted = rows.filter(function(r){ return r.status === 'waitlist'; });
    if(!waitlisted.length) return;
    const next = waitlisted[0];
    const eventRef = window.fbDb.collection(EVENTS_COL).doc(eventId);
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(next.id);
    await window.fbDb.runTransaction(async function(tx){
      const eventSnap = await tx.get(eventRef);
      if(!eventSnap.exists) return;
      const ev = eventSnap.data();
      if(ev.max_players && (ev.rsvp_count || 0) >= ev.max_players) return;
      const rsvpSnap = await tx.get(rsvpRef);
      if(!rsvpSnap.exists || rsvpSnap.data().status !== 'waitlist') return;
      tx.update(rsvpRef, { status: 'confirmed' });
      tx.update(eventRef, { rsvp_count: (ev.rsvp_count || 0) + 1 });
    });
  }
};
window.OpenPlayAPI = OpenPlayAPI; // exposed for later use / debugging

/* ---------------- local UI state ---------------- */
const opUI = { user: null, authReady: false, events: [], eventsReady: false, error: null };
Object.defineProperty(opUI, 'loading', { get: function(){ return !opUI.authReady || !opUI.eventsReady; } });

let opUnsubEvents = null;

function maybeRerenderOpenPlay(){
  if(window.state && (state.tab === 'discover' || state.tab === 'host')) renderActiveView();
}

function opHandleSharedLink(){
  if(opUI._sharedLinkHandled) return;
  const m = (location.hash || '').match(/open-play=([^&]+)/);
  if(!m) return;
  opUI._sharedLinkHandled = true;
  const eventId = decodeURIComponent(m[1]);
  // Small delay so this runs after script.js's own boot (which restores
  // the last-used tab from storage and would otherwise clobber the
  // Discover tab switch below).
  setTimeout(function(){
    const ev = opUI.events.find(function(e){ return e.id === eventId; });
    if(window.state){ state.tab = 'discover'; saveAll(); renderAll(); }
    if(ev){
      setTimeout(function(){ opOpenEventDetail(eventId); }, 150);
    } else {
      toast('This open play link is no longer available.', 'error');
    }
  }, 500);
}

function opBoot(){
  // Catch the tail end of a signInWithRedirect() fallback, if one happened.
  if(fbReady() && window.fbAuth.getRedirectResult){
    window.fbAuth.getRedirectResult().catch(function(err){ console.warn('Google redirect sign-in error:', err); });
  }

  OpenPlayAPI.onAuthChange(function(user){
    opUI.user = user;
    opUI.authReady = true;
    maybeRerenderOpenPlay();
  });

  opUnsubEvents = OpenPlayAPI.subscribeEvents(function(events){
    opUI.events = events;
    opUI.eventsReady = true;
    opUI.error = null;
    maybeRerenderOpenPlay();
    opHandleSharedLink();
  }, function(err){
    opUI.eventsReady = true;
    opUI.error = err;
    maybeRerenderOpenPlay();
  });
}

/* ---------------- nav wiring ---------------- */
function opAddNavSections(){
  if(!window.NAV_SECTIONS) return;
  const already = NAV_SECTIONS.some(function(s){ return s.id === 'discover'; });
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

const GOOGLE_G_SVG = '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34 5.1 29.3 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.4-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34 5.1 29.3 3 24 3c-7.7 0-14.4 4.4-17.7 10.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 36.6 26.7 37.5 24 37.5c-5.3 0-9.7-3.4-11.3-8.1l-6.5 5C9.5 40.5 16.2 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.8l6.2 5.2C39.4 37.5 45 32 45 24c0-1.4-.1-2.7-.4-3.5z"/></svg>';

// Normalizes a host-entered location link so bare domains ("maps.app.goo.gl/xyz")
// still work as a real href, not just full "https://..." URLs.
function opNormalizeUrl(u){
  u = (u || '').trim();
  if(!u) return '';
  if(!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}
// The link a tap on the location name should open: the host's own link if
// they gave one, otherwise a Google Maps search built from the venue name —
// so location is always tappable, even when no explicit link was set.
function opLocationHref(ev){
  if(ev.location_link) return opNormalizeUrl(ev.location_link);
  if(!ev.location_name) return '';
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(ev.location_name);
}
function opLocationLinkHtml(ev, labelHtml){
  const href = opLocationHref(ev);
  if(!href) return labelHtml;
  return `<a href="${esc(href)}" target="_blank" rel="noopener" class="op-location-link" onclick="event.stopPropagation()">${labelHtml}</a>`;
}
// Host actions (confirm/remove a joiner) write to a document owned by a
// *different* user (their rsvp row), which Firestore security rules must
// explicitly allow via a host-of-the-event check. If that rule isn't in
// place yet, Firestore rejects the write with 'permission-denied' — this
// turns that specific case into an actionable message instead of a vague
// "could not remove" toast.
function opFriendlyError(err, fallback){
  if(err && err.code === 'permission-denied'){
    return 'Your Firestore rules don\u2019t yet allow hosts to manage joiners \u2014 see the rules snippet in the setup notes.';
  }
  return (err && err.message) ? err.message : fallback;
}

function signInPrompt(afterLabel){
  return `
    <div class="op-signin-card">
      <div class="op-signin-title">Sign in to ${esc(afterLabel)}</div>
      <div class="op-signin-sub">Sign in with Google to browse open play games, RSVP, or host your own.</div>
      <button class="op-google-btn" data-action="op-sign-in">${GOOGLE_G_SVG}<span>Continue with Google</span></button>
    </div>`;
}

function opAuthChip(){
  if(opUI.user){
    const avatar = opUI.user.avatar_url
      ? `<img class="op-user-avatar" src="${esc(opUI.user.avatar_url)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="op-user-avatar op-user-avatar-fallback">${esc((opUI.user.display_name || '?').charAt(0).toUpperCase())}</div>`;
    return `
      <div class="op-user-chip">
        ${avatar}
        <span class="op-user-name">${esc(opUI.user.display_name)}</span>
        <button class="op-user-signout" data-action="op-sign-out" title="Sign out">Sign out</button>
      </div>`;
  }
  return `
    <div class="op-user-chip op-user-chip-guest">
      <span class="op-user-name">Browsing as guest</span>
      <button class="op-google-btn op-google-btn-sm" data-action="op-sign-in">${GOOGLE_G_SVG}<span>Sign in</span></button>
    </div>`;
}

/* ---------------- DISCOVER view ---------------- */
function renderDiscoverView(el){
  if(!fbReady()){
    el.innerHTML = `<div class="op-wrap"><div class="op-empty">Open Play isn\u2019t configured yet.<br/>Check the Firebase setup in firebase-init.js.</div></div>`;
    return;
  }
  if(opUI.loading){
    el.innerHTML = `<div class="op-wrap"><div class="op-empty">Loading open play\u2026</div></div>`;
    return;
  }
  if(opUI.error){
    el.innerHTML = `<div class="op-wrap"><div class="op-empty">Couldn\u2019t load open play games right now.<br/>Check your connection and try again.</div></div>`;
    return;
  }

  const events = opUI.events.filter(function(e){ return e.status === 'open'; });

  el.innerHTML = `
    <div class="op-wrap">
      <div class="op-header">
        <div>
          <div class="op-h-title">Discover</div>
          <div class="op-h-sub">Open play games posted by the community</div>
        </div>
        <button class="btn btn-primary btn-sm" data-action="tab" data-tab="host">+ Host</button>
      </div>
      ${opAuthChip()}
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
      <div class="op-card-row">📍 ${opLocationLinkHtml(ev, esc(ev.location_name))}</div>
      <div class="op-card-row">🗓️ ${fmtWhen(ev.start_time)}</div>
      <div class="op-card-row">👥 ${ev.rsvp_count || 0}${ev.max_players ? ' / ' + ev.max_players : ''} players · hosted by ${esc(ev.host_name)}</div>
    </div>
  `;
}

async function opOpenEventDetail(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  const myRsvp = opUI.user ? await OpenPlayAPI.myRsvpForEvent(eventId, opUI.user.id) : null;
  const isHost = !!opUI.user && ev.host_id === opUI.user.id;
  const full = ev.max_players && (ev.rsvp_count || 0) >= ev.max_players;

  let actionButton;
  if(isHost){
    actionButton = `
      <button class="btn btn-ghost btn-block" data-action="op-manage-joiners" data-id="${ev.id}">Manage joiners</button>
      <button class="op-btn-danger" data-action="op-confirm-cancel-event" data-id="${ev.id}">Cancel this event</button>`;
  } else if(myRsvp && myRsvp.status === 'waitlist'){
    actionButton = `
      <div class="op-status-note op-status-waitlist">You're on the waitlist — you'll be confirmed automatically if a spot opens up.</div>
      <button class="btn btn-ghost btn-block" data-action="op-leave-event" data-id="${ev.id}">Leave waitlist</button>`;
  } else if(myRsvp){
    actionButton = `
      <div class="op-status-note op-status-confirmed">You're in ✓</div>
      <button class="btn btn-ghost btn-block" data-action="op-leave-event" data-id="${ev.id}">Leave / Cancel RSVP</button>`;
  } else if(!opUI.user){
    actionButton = `<button class="btn btn-primary btn-block" data-action="op-sign-in-to-join" data-id="${ev.id}">${full ? 'Sign in to Join Waitlist' : 'Sign in to Join'}</button>`;
  } else {
    actionButton = `<button class="btn btn-primary btn-block" data-action="op-join-event" data-id="${ev.id}">${full ? 'Join Waitlist' : 'Join'}</button>`;
  }

  openModal(`
    <div class="modal-title">${esc(ev.title)}</div>
    <div class="modal-sub">Hosted by ${esc(ev.host_name)}</div>
    <div class="op-detail-rows">
      <div class="op-detail-row">📍 ${opLocationLinkHtml(ev, `<span>${esc(ev.location_name)}</span>`)}</div>
      <div class="op-detail-row">🗓️ <span>${fmtWhen(ev.start_time)}</span></div>
      <div class="op-detail-row">👥 <span>${ev.rsvp_count || 0}${ev.max_players ? ' / ' + ev.max_players : ''} players${full ? ' · waitlist open' : ''}</span></div>
      ${(ev.skill_min || ev.skill_max) ? `<div class="op-detail-row">🎯 <span>Rating ${ev.skill_min || '—'}–${ev.skill_max || '—'}</span></div>` : ''}
      ${ev.fee_amount ? `<div class="op-detail-row">💵 <span>${esc(String(ev.fee_amount))}${ev.fee_note ? ' — ' + esc(ev.fee_note) : ''}</span></div>` : ''}
    </div>
    ${ev.details ? `<div class="op-detail-block"><div class="op-detail-block-title">Details</div><div class="op-detail-block-body">${esc(ev.details)}</div></div>` : ''}
    ${ev.rules ? `<div class="op-detail-block"><div class="op-detail-block-title">Rules</div><div class="op-detail-block-body">${esc(ev.rules)}</div></div>` : ''}
    <div class="op-detail-actions">
      ${actionButton}
      <button class="btn btn-ghost btn-block" data-action="op-share-event" data-id="${ev.id}">Copy shareable link</button>
      <button class="btn btn-ghost btn-block" data-action="modal-close">Close</button>
    </div>
  `);
}

/* ---------------- MANAGE JOINERS (host) ---------------- */
async function opRenderManageJoiners(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  openModal(`<div class="modal-title">Manage joiners</div><div class="op-empty" style="padding:24px;">Loading\u2026</div>`);
  let rows;
  try{
    rows = await OpenPlayAPI.listRsvpsForEvent(eventId);
  }catch(err){
    console.error(err);
    openModal(`<div class="modal-title">Manage joiners</div><div class="op-empty">Couldn\u2019t load joiners. Please try again.</div><div class="modal-actions"><button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button></div>`);
    return;
  }
  const confirmed = rows.filter(function(r){ return r.status === 'confirmed'; });
  const waitlist = rows.filter(function(r){ return r.status === 'waitlist'; });
  const removed = rows.filter(function(r){ return r.status === 'removed' || r.status === 'cancelled'; });

  function joinerRow(r, opts){
    opts = opts || {};
    const avatar = r.player_photo_url
      ? `<img class="op-user-avatar" src="${esc(r.player_photo_url)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="op-user-avatar op-user-avatar-fallback">${esc((r.player_name || '?').charAt(0).toUpperCase())}</div>`;
    return `
      <div class="op-joiner-row">
        ${avatar}
        <span class="op-joiner-name">${esc(r.player_name || 'Player')}</span>
        <div class="op-joiner-actions">
          ${opts.confirmable ? `<button class="op-mini-btn op-mini-btn-primary" data-action="op-confirm-joiner" data-id="${ev.id}" data-player="${esc(r.player_id)}">Confirm</button>` : ''}
          ${opts.removable ? `<button class="op-mini-btn op-mini-btn-danger" data-action="op-confirm-remove-joiner" data-id="${ev.id}" data-player="${esc(r.player_id)}" data-name="${esc(r.player_name || 'this player')}">Remove</button>` : ''}
          ${opts.tag ? `<span class="op-badge op-badge-muted">${opts.tag}</span>` : ''}
        </div>
      </div>`;
  }

  openModal(`
    <div class="modal-title">Manage joiners</div>
    <div class="modal-sub">${esc(ev.title)}</div>

    <div class="op-h-title" style="font-size:14px; margin-top:14px;">Confirmed (${confirmed.length}${ev.max_players ? ' / ' + ev.max_players : ''})</div>
    ${confirmed.length ? `<div class="op-joiner-list">${confirmed.map(function(r){ return joinerRow(r, { removable: true }); }).join('')}</div>` : `<div class="op-empty" style="padding:16px;">No one has joined yet.</div>`}

    <div class="op-h-title" style="font-size:14px; margin-top:18px;">Waitlist (${waitlist.length})</div>
    ${waitlist.length ? `<div class="op-joiner-list">${waitlist.map(function(r){ return joinerRow(r, { confirmable: true, removable: true }); }).join('')}</div>` : `<div class="op-empty" style="padding:16px;">No one is waitlisted.</div>`}

    ${removed.length ? `
      <div class="op-h-title" style="font-size:14px; margin-top:18px;">Removed / cancelled</div>
      <div class="op-joiner-list">${removed.map(function(r){ return joinerRow(r, { tag: r.status === 'removed' ? 'Removed' : 'Cancelled' }); }).join('')}</div>
    ` : ''}

    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button>
    </div>
  `);
}

function opConfirmRemoveJoiner(eventId, playerId, playerName){
  openModal(`
    <div class="modal-title">Remove ${esc(playerName)}?</div>
    <div class="modal-sub">They'll lose their spot. If someone is on the waitlist, they'll be confirmed automatically.</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="op-manage-joiners" data-id="${eventId}">Never mind</button>
      <button class="op-btn-danger" data-action="op-remove-joiner" data-id="${eventId}" data-player="${esc(playerId)}">Yes, remove</button>
    </div>
  `);
}

function opConfirmCancelEvent(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  const rsvpNote = ev.rsvp_count
    ? `<strong style="color:var(--loss);">${ev.rsvp_count} player${ev.rsvp_count!==1?'s':''} already RSVP'd</strong> — they'll lose their spot.`
    : `No one has RSVP'd yet, so no one else will be affected.`;
  openModal(`
    <div class="modal-title">⚠️ Cancel "${esc(ev.title)}"?</div>
    <div class="modal-sub" style="line-height:1.6;">
      This removes the event from Discover for everyone. ${rsvpNote} This can't be undone.
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="op-open-event" data-id="${ev.id}">Never mind</button>
      <button class="op-btn-danger" data-action="op-cancel-event" data-id="${ev.id}">Yes, cancel event</button>
    </div>
  `);
}

/* ---------------- HOST view ---------------- */
function renderHostView(el){
  if(!fbReady()){
    el.innerHTML = `<div class="op-wrap"><div class="op-empty">Open Play isn\u2019t configured yet.<br/>Check the Firebase setup in firebase-init.js.</div></div>`;
    return;
  }
  if(opUI.loading){
    el.innerHTML = `<div class="op-wrap"><div class="op-empty">Loading\u2026</div></div>`;
    return;
  }
  if(!opUI.user){
    el.innerHTML = `<div class="op-wrap">${signInPrompt('host a game')}</div>`;
    return;
  }

  const myEvents = opUI.events.filter(function(e){ return e.host_id === opUI.user.id && e.status === 'open'; });

  el.innerHTML = `
    <div class="op-wrap">
      <div class="op-header">
        <div>
          <div class="op-h-title">Host a Game</div>
          <div class="op-h-sub">Post an open play — others can discover and join</div>
        </div>
      </div>
      ${opAuthChip()}

      <form id="opHostForm" class="op-form">
        <label class="op-label">Title
          <input class="op-input" name="title" placeholder="Saturday Morning Open Play" required />
        </label>
        <label class="op-label">Location
          <input class="op-input" name="location_name" placeholder="Marian Lakeview Park Subd" required />
        </label>
        <label class="op-label">Location link (optional)
          <input class="op-input" type="url" name="location_link" placeholder="Paste a Google Maps / Waze link" />
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
        <label class="op-label">Details (optional)
          <textarea class="op-input op-textarea" name="details" placeholder="Format, courts, parking, what to bring\u2026"></textarea>
        </label>
        <label class="op-label">Rules (optional)
          <textarea class="op-input op-textarea" name="rules" placeholder="e.g. Bring your own paddle, rotate every game, 10-min no-show grace period\u2026"></textarea>
        </label>
        <button type="submit" class="btn btn-primary btn-block">Post Open Play</button>
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
      const submitBtn = form.querySelector('button[type="submit"]');
      const fd = new FormData(form);
      const date = fd.get('date'), time = fd.get('time');
      if(!date || !time){ toast('Pick a date and time.', 'error'); return; }
      const start_time = new Date(`${date}T${time}`).toISOString();
      const payload = {
        title: (fd.get('title') || '').trim() || 'Open Play',
        location_name: (fd.get('location_name') || '').trim(),
        location_link: (fd.get('location_link') || '').trim() || null,
        start_time,
        max_players: Number(fd.get('max_players')) || null,
        fee_amount: (fd.get('fee_amount') || '').trim() || null,
        skill_min: fd.get('skill_min') ? Number(fd.get('skill_min')) : null,
        skill_max: fd.get('skill_max') ? Number(fd.get('skill_max')) : null,
        details: (fd.get('details') || '').trim() || null,
        rules: (fd.get('rules') || '').trim() || null,
      };
      if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Posting\u2026'; }
      try{
        const ev = await OpenPlayAPI.createEvent(payload, opUI.user);
        toast('Open play posted!', 'success');
        state.tab = 'discover';
        saveAll(); renderAll();
        setTimeout(function(){ opOpenEventDetail(ev.id); }, 200);
      }catch(err){
        console.error(err);
        toast('Could not post this event. Please try again.', 'error');
        if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Post Open Play'; }
      }
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
      if(t.disabled) return;
      t.disabled = true;
      try{
        const user = await OpenPlayAPI.signInWithGoogle();
        if(user){
          toast(`Welcome, ${user.display_name}!`, 'success');
          opUI.user = user;
          renderActiveView();
        }
      }catch(err){
        console.error(err);
        const msg = (err && err.code === 'auth/popup-closed-by-user')
          ? 'Sign-in was cancelled.'
          : 'Sign-in failed. Please try again.';
        toast(msg, 'error');
      }finally{
        t.disabled = false;
      }
      break;
    }
    case 'op-sign-out': {
      await OpenPlayAPI.signOut();
      toast('Signed out.', 'default');
      renderActiveView();
      break;
    }
    case 'op-sign-in-to-join': {
      if(t.disabled) return;
      t.disabled = true;
      const eventId = t.dataset.id;
      try{
        const user = await OpenPlayAPI.signInWithGoogle();
        if(user){
          opUI.user = user;
          toast(`Welcome, ${user.display_name}!`, 'success');
          await opOpenEventDetail(eventId); // reopen — Join is now available
        }
      }catch(err){
        console.error(err);
        const msg = (err && err.code === 'auth/popup-closed-by-user')
          ? 'Sign-in was cancelled.'
          : 'Sign-in failed. Please try again.';
        toast(msg, 'error');
      }finally{
        t.disabled = false;
      }
      break;
    }
    case 'op-open-event': {
      await opOpenEventDetail(t.dataset.id);
      break;
    }
    case 'op-join-event': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        const status = await OpenPlayAPI.rsvp(t.dataset.id, opUI.user);
        toast(status === 'waitlist' ? "Event's full — you're on the waitlist." : "You're in! RSVP confirmed.", 'success');
        closeModal();
        renderActiveView();
      }catch(err){
        console.error(err);
        toast(err && err.message ? err.message : 'Could not RSVP. Please try again.', 'error');
      }finally{
        t.disabled = false;
      }
      break;
    }
    case 'op-leave-event': {
      try{
        await OpenPlayAPI.cancelRsvp(t.dataset.id, opUI.user);
        toast('RSVP cancelled.', 'success');
        closeModal();
        renderActiveView();
      }catch(err){
        console.error(err);
        toast('Could not cancel RSVP. Please try again.', 'error');
      }
      break;
    }
    case 'op-confirm-cancel-event': {
      opConfirmCancelEvent(t.dataset.id);
      break;
    }
    case 'op-cancel-event': {
      try{
        await OpenPlayAPI.cancelEvent(t.dataset.id);
        toast('Event cancelled.', 'success');
        closeModal();
        renderActiveView();
      }catch(err){
        console.error(err);
        toast('Could not cancel this event. Please try again.', 'error');
      }
      break;
    }
    case 'op-manage-joiners': {
      await opRenderManageJoiners(t.dataset.id);
      break;
    }
    case 'op-confirm-joiner': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        await OpenPlayAPI.confirmJoiner(t.dataset.id, t.dataset.player);
        toast('Joiner confirmed.', 'success');
        await opRenderManageJoiners(t.dataset.id);
        renderActiveView();
      }catch(err){
        console.error(err);
        toast(opFriendlyError(err, 'Could not confirm this joiner.'), 'error');
        t.disabled = false;
      }
      break;
    }
    case 'op-confirm-remove-joiner': {
      opConfirmRemoveJoiner(t.dataset.id, t.dataset.player, t.dataset.name);
      break;
    }
    case 'op-remove-joiner': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        await OpenPlayAPI.removeJoiner(t.dataset.id, t.dataset.player);
        toast('Joiner removed.', 'success');
        await opRenderManageJoiners(t.dataset.id);
        renderActiveView();
      }catch(err){
        console.error(err);
        toast(opFriendlyError(err, 'Could not remove this joiner.'), 'error');
        t.disabled = false;
      }
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
opBoot();

})();
