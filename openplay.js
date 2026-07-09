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
const USERNAMES_COL = 'usernames';
const DEVICES_COL = 'deviceRegistrations';

// Anti-spam / anti-abuse limits. Enforced here client-side for a good UX,
// but since a determined user can bypass client code, mirror these in
// Firestore security rules too (see notes near OpenPlayAPI.createEvent /
// registerWithUsernamePassword below) for real enforcement.
const MAX_OPEN_EVENTS_PER_HOST = 2;   // "spam hosting" guard
const MAX_PAST_EVENTS_PER_HOST = 2;   // auto-pruned, oldest-first
const MAX_ACCOUNTS_PER_DEVICE  = 2;   // "spam registration" guard
const USERNAME_EMAIL_SUFFIX = '@ladder-users.local'; // synthetic email so Firebase's email/password auth can be driven by a plain username

function fbReady(){ return !!(window.fbAuth && window.fbDb); }

function rsvpDocId(eventId, uid){ return eventId + '_' + uid; }

/* ---------------- CHAT (Supabase Postgres + Realtime) ----------------
   Identity/events/RSVPs stay on Firebase (above); chat lives in Supabase,
   used purely for Realtime-over-Postgres. Requires the supabase-js UMD
   build loaded on the page BEFORE this file:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>

   The anon key below is the public "anon" key, not a secret - it is
   meant to ship in client code. Real access control has to live in the
   database via Row Level Security (RLS) policies. See the SQL comment
   below the ChatAPI/ChatMembership objects for the tables + policies
   this feature expects.

   NOTE ON AUTH: this app's identity system is Firebase Auth, not
   Supabase Auth, so Supabase/RLS has no Supabase session tied to the
   Firebase user, and can't cryptographically verify who is asking.
   To gate chat to "people the host has confirmed" anyway, this file
   mirrors a small membership list into Supabase (open_play_confirmed_
   participants) every time a host confirms/removes someone in Firestore,
   and the chat table's INSERT policy requires (event_id, user_id) to be
   present in that list. That stops anyone who *isn't* a confirmed
   participant from posting at all, without any new server.

   Residual limitation, by design (see the "lightweight, no server"
   option): the client still supplies its own user_id on each request,
   and nothing here cryptographically proves that a given browser really
   is that Firebase user. So the check is "does this look like a
   confirmed participant" rather than "is this provably that person" -
   someone who already knew another confirmed participant's Firebase uid
   could still post under it. Closing that gap needs real identity
   verification (Supabase Auth, or a small server/Edge Function that
   checks the Firebase ID token) - flag if you want that upgrade later.
   Reads (SELECT) are left open to anyone who has the event id, same as
   before, since restricting reads by identity has the same limitation. */

const SUPABASE_URL = 'https://wxnjlhmqbgxhsnmcjyzi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4bmpsaG1xYmd4aHNubWNqeXppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MzU3MzcsImV4cCI6MjA5OTExMTczN30.HOkM0L36F-L80LMqjrZxXFtt0DopXvh4BsLNjn7FAtQ';
const CHAT_TABLE = 'open_play_chat_messages';
const MEMBERSHIP_TABLE = 'open_play_confirmed_participants';
const CHAT_HISTORY_LIMIT = 200;

let sbClient = null;
function sbReady(){
  if(sbClient) return true;
  if(!window.supabase || !window.supabase.createClient) return false;
  sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

const ChatAPI = {
  async loadRecent(eventId){
    if(!sbReady()) return [];
    const { data, error } = await sbClient
      .from(CHAT_TABLE)
      .select('*')
      .eq('event_id', eventId)
      .order('created_at', { ascending: true })
      .limit(CHAT_HISTORY_LIMIT);
    if(error){ console.error('[chat] load failed', error); return []; }
    return data || [];
  },
  async send(eventId, user, body){
    if(!sbReady()) throw new Error('Chat isn\u2019t available right now.');
    const { error } = await sbClient.from(CHAT_TABLE).insert({
      event_id: String(eventId),
      user_id: user.id,
      user_name: user.display_name || 'Player',
      avatar_url: user.avatar_url || null,
      body: body,
    });
    if(error) throw error;
  },
  // Subscribes to new inserts for one event's chat. Returns a channel
  // handle to pass to unsubscribe() when the chat view closes.
  subscribe(eventId, onInsert){
    if(!sbReady()) return null;
    return sbClient
      .channel('open-play-chat-' + eventId)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: CHAT_TABLE,
        filter: 'event_id=eq.' + eventId,
      }, function(payload){ onInsert(payload.new); })
      .subscribe();
  },
  unsubscribe(channel){
    if(channel && sbClient) sbClient.removeChannel(channel);
  },
};

// Mirrors "who the host has confirmed" into Supabase so the chat table's
// RLS policy can require it. Called right after the corresponding
// Firestore write succeeds (see call sites in OpenPlayAPI below). Every
// method is best-effort: chat membership syncing must never break the
// underlying RSVP/host action if Supabase happens to be unreachable, so
// failures are logged, not thrown.
const ChatMembership = {
  async add(eventId, userId, userName, avatarUrl, role){
    if(!sbReady() || !eventId || !userId) return;
    try{
      const { error } = await sbClient.from(MEMBERSHIP_TABLE).upsert({
        event_id: String(eventId),
        user_id: userId,
        user_name: userName || null,
        avatar_url: avatarUrl || null,
        role: role || 'participant',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'event_id,user_id' });
      if(error) console.error('[chat] membership add failed', error);
    }catch(err){ console.error('[chat] membership add failed', err); }
  },
  async remove(eventId, userId){
    if(!sbReady() || !eventId || !userId) return;
    try{
      const { error } = await sbClient.from(MEMBERSHIP_TABLE)
        .delete().eq('event_id', String(eventId)).eq('user_id', userId);
      if(error) console.error('[chat] membership remove failed', error);
    }catch(err){ console.error('[chat] membership remove failed', err); }
  },
  async removeAllForEvent(eventId){
    if(!sbReady() || !eventId) return;
    try{
      const { error } = await sbClient.from(MEMBERSHIP_TABLE)
        .delete().eq('event_id', String(eventId));
      if(error) console.error('[chat] membership cleanup failed', error);
    }catch(err){ console.error('[chat] membership cleanup failed', err); }
  },
};

/* --- SQL to run once in the Supabase project's SQL editor ---------------

-- If you already ran the earlier version of this SQL (a single open
-- chat table), run this first to swap in the stricter policy:
--   drop policy if exists "anyone can post chat" on open_play_chat_messages;

create table if not exists open_play_chat_messages (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  user_id text not null,
  user_name text not null,
  avatar_url text,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists open_play_chat_messages_event_idx
  on open_play_chat_messages (event_id, created_at);

create table if not exists open_play_confirmed_participants (
  event_id text not null,
  user_id text not null,
  user_name text,
  avatar_url text,
  role text not null default 'participant',
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

alter table open_play_chat_messages enable row level security;
alter table open_play_confirmed_participants enable row level security;

-- Reads stay open to anyone who has the event id (same limitation as
-- before: there's no verified identity to restrict reads by).
create policy "anyone can read chat" on open_play_chat_messages
  for select using (true);

-- Writes now require the (event_id, user_id) pair to be a confirmed
-- participant — this is the actual "host has to confirm you" gate.
create policy "confirmed participants can post chat" on open_play_chat_messages
  for insert with check (
    char_length(body) between 1 and 500
    and exists (
      select 1 from open_play_confirmed_participants p
      where p.event_id = open_play_chat_messages.event_id
        and p.user_id = open_play_chat_messages.user_id
    )
  );

-- The membership table itself is synced by trusted client code (Firestore
-- security rules already gate who can confirm/remove a joiner), so it's
-- readable/writable the same way the old fully-open chat table was.
create policy "membership readable" on open_play_confirmed_participants
  for select using (true);
create policy "membership syncable" on open_play_confirmed_participants
  for insert with check (true);
create policy "membership syncable update" on open_play_confirmed_participants
  for update using (true);
create policy "membership syncable delete" on open_play_confirmed_participants
  for delete using (true);

alter publication supabase_realtime add table open_play_chat_messages;
--------------------------------------------------------------------- */

// Persistent per-browser identifier used only to rate-limit how many
// accounts can be *registered* from one device — not used for tracking,
// ads, or anything beyond this spam guard. Falls back to null (guard
// skipped) if storage is unavailable, e.g. private browsing.
function opGetDeviceId(){
  try{
    let id = localStorage.getItem('op_device_id');
    if(!id){
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2));
      localStorage.setItem('op_device_id', id);
    }
    return id;
  }catch(err){
    return null;
  }
}

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

  // ----- auth (Firebase Auth, username + password) -----
  // Firebase's email/password auth is reused under the hood: the chosen
  // username is mapped to a synthetic, non-routable email address so
  // people never have to type or manage a real email for this. A
  // `usernames` collection enforces uniqueness (case-insensitive) and a
  // `deviceRegistrations` collection caps how many accounts a single
  // device can create, as a lightweight guard against spam sign-ups.
  //
  // NOTE: these checks happen client-side before the writes, so they stop
  // normal spam but not a determined attacker calling the Firebase SDK
  // directly. For airtight enforcement, mirror MAX_ACCOUNTS_PER_DEVICE and
  // username-uniqueness in Firestore security rules, or move registration
  // behind a Cloud Function.
  async registerWithUsernamePassword(username, password, displayName){
    if(!fbReady()) throw new Error('Sign-up isn\u2019t available right now.');
    const clean = (username || '').trim().toLowerCase();
    if(!/^[a-z0-9_]{3,20}$/.test(clean)){
      throw new Error('Username must be 3\u201320 characters: letters, numbers, underscore only.');
    }
    if(!password || password.length < 6){
      throw new Error('Password must be at least 6 characters.');
    }
    const cleanName = (displayName || '').trim();
    if(!cleanName){
      throw new Error('Enter your name.');
    }

    const deviceId = opGetDeviceId();
    const deviceRef = deviceId ? window.fbDb.collection(DEVICES_COL).doc(deviceId) : null;
    if(deviceRef){
      const deviceSnap = await deviceRef.get();
      const count = deviceSnap.exists ? (deviceSnap.data().accountCount || 0) : 0;
      if(count >= MAX_ACCOUNTS_PER_DEVICE){
        throw new Error('This device has already created the maximum number of accounts (' + MAX_ACCOUNTS_PER_DEVICE + '). Sign in to an existing account instead.');
      }
    }

    const usernameRef = window.fbDb.collection(USERNAMES_COL).doc(clean);
    const usernameSnap = await usernameRef.get();
    if(usernameSnap.exists){
      throw new Error('That username is taken. Try another.');
    }

    const email = clean + USERNAME_EMAIL_SUFFIX;
    let cred;
    try{
      cred = await window.fbAuth.createUserWithEmailAndPassword(email, password);
    }catch(err){
      if(err && err.code === 'auth/email-already-in-use') throw new Error('That username is taken. Try another.');
      throw err;
    }
    await cred.user.updateProfile({ displayName: cleanName });

    // Reserve the username and record the device registration. Best-effort:
    // if these fail after the account was created, the account still works,
    // it just won't count against future device/username checks.
    try{
      await usernameRef.set({
        uid: cred.user.uid,
        created_at: firebase.firestore.FieldValue.serverTimestamp(),
      });
      if(deviceRef){
        await deviceRef.set({
          accountCount: firebase.firestore.FieldValue.increment(1),
          uids: firebase.firestore.FieldValue.arrayUnion(cred.user.uid),
          last_seen: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    }catch(err){
      console.warn('Post-registration bookkeeping failed:', err);
    }

    return mapAuthUser(cred.user);
  },
  async signInWithUsernamePassword(username, password){
    if(!fbReady()) throw new Error('Sign-in isn\u2019t available right now.');
    const clean = (username || '').trim().toLowerCase();
    if(!clean || !password) throw new Error('Enter your username and password.');
    const email = clean + USERNAME_EMAIL_SUFFIX;
    try{
      const cred = await window.fbAuth.signInWithEmailAndPassword(email, password);
      return mapAuthUser(cred.user);
    }catch(err){
      if(err && (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential')){
        throw new Error('Incorrect username or password.');
      }
      throw err;
    }
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
  // Counts a host's currently-open events — used both to show "X / 2 open
  // games" in the UI and as a last-moment guard right before writing, so a
  // second tab / double-tap can't slip past the limit shown in the form.
  async countOpenEventsForHost(hostId){
    const snap = await window.fbDb.collection(EVENTS_COL)
      .where('host_id', '==', hostId)
      .where('status', '==', 'open')
      .get();
    return snap.size;
  },
  async createEvent(payload, host){
    // Spam-hosting guard: cap how many *open* events one host can have live
    // at once. (Also mirrored in the Host form UI so people see the limit
    // before they fill out the form — see MAX_OPEN_EVENTS_PER_HOST.)
    const openCount = await OpenPlayAPI.countOpenEventsForHost(host.id);
    if(openCount >= MAX_OPEN_EVENTS_PER_HOST){
      throw new Error('You already have ' + MAX_OPEN_EVENTS_PER_HOST + ' open games posted. Cancel one before posting another.');
    }
    const event = Object.assign({
      host_id: host.id,
      host_name: host.display_name,
      host_photo_url: host.avatar_url || null,
      status: 'open',
      rsvp_count: 0,
      created_at: firebase.firestore.FieldValue.serverTimestamp(),
    }, payload);
    const ref = await window.fbDb.collection(EVENTS_COL).add(event);
    ChatMembership.add(ref.id, host.id, host.display_name, host.avatar_url, 'host');
    return Object.assign({ id: ref.id }, event);
  },
  async cancelEvent(eventId){
    await window.fbDb.collection(EVENTS_COL).doc(eventId).update({ status: 'cancelled' });
  },
  // Host edits details of an event they've already posted (title, location,
  // time, capacity, fee, skill range, details/rules). Doesn't touch rsvps.
  async updateEvent(eventId, payload){
    await window.fbDb.collection(EVENTS_COL).doc(eventId).update(payload);
  },
  // Permanently removes an event and its rsvps. Used by the auto-cleanup
  // that keeps only the MAX_PAST_EVENTS_PER_HOST most recent past events
  // per host (see opCleanupOldPastEvents below) — old events just age out
  // instead of piling up forever.
  async deleteEvent(eventId){
    const rsvpsSnap = await window.fbDb.collection(RSVPS_COL).where('event_id', '==', eventId).get();
    const batch = window.fbDb.batch();
    rsvpsSnap.docs.forEach(function(d){ batch.delete(d.ref); });
    batch.delete(window.fbDb.collection(EVENTS_COL).doc(eventId));
    await batch.commit();
    ChatMembership.removeAllForEvent(eventId);
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
  // Joins the event. Every new joiner lands on the waitlist first, no
  // matter how many open spots there are — the host has to confirm each
  // one from "Manage joiners" before they hold a real seat. Returns the
  // resulting status: 'confirmed' (already were, e.g. a re-tap) or 'waitlist'.
  async rsvp(eventId, user){
    const eventRef = window.fbDb.collection(EVENTS_COL).doc(eventId);
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, user.id));
    let resultStatus = 'waitlist';
    await window.fbDb.runTransaction(async function(tx){
      const eventSnap = await tx.get(eventRef);
      if(!eventSnap.exists) throw new Error('This event no longer exists.');
      const rsvpSnap = await tx.get(rsvpRef);
      const existing = rsvpSnap.exists ? rsvpSnap.data() : null;
      if(existing && (existing.status === 'confirmed' || existing.status === 'waitlist')){
        resultStatus = existing.status;
        return;
      }
      resultStatus = 'waitlist';
      tx.set(rsvpRef, {
        event_id: eventId,
        player_id: user.id,
        player_name: user.display_name,
        player_photo_url: user.avatar_url || null,
        status: resultStatus,
        paid: false,
        created_at: (existing && existing.created_at) ? existing.created_at : firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
    return resultStatus;
  },
  // Player REQUESTS to leave — this no longer cancels the spot outright.
  // It just flags the rsvp so the host sees it in Manage joiners and can
  // approve it (which is what actually frees the seat).
  async requestLeave(eventId, user){
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, user.id));
    await rsvpRef.update({ leave_requested: true });
  },
  // Player changes their mind before the host approves the leave request.
  async cancelLeaveRequest(eventId, user){
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, user.id));
    await rsvpRef.update({ leave_requested: false });
  },
  // Host approves a pending leave request — this is the step that actually
  // releases the seat (mirrors _releaseSpot's normal cancel behavior).
  async approveLeave(eventId, playerId){
    await OpenPlayAPI._releaseSpot(eventId, playerId, 'cancelled');
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
    let confirmedRsvp = null;
    await window.fbDb.runTransaction(async function(tx){
      const eventSnap = await tx.get(eventRef);
      if(!eventSnap.exists) throw new Error('This event no longer exists.');
      const ev = eventSnap.data();
      const rsvpSnap = await tx.get(rsvpRef);
      if(!rsvpSnap.exists || rsvpSnap.data().status !== 'waitlist') return;
      // The host occupies one of the max_players slots too — unless the
      // host opted out of counting toward the cap — so a joiner can only
      // be confirmed while (confirmed joiners + host, if counted) < max.
      const hostCounts = ev.host_counts_toward_max !== false;
      if(ev.max_players && ((ev.rsvp_count || 0) + (hostCounts ? 1 : 0)) >= ev.max_players){
        throw new Error('Event is full — remove a player or move one to the waitlist first.');
      }
      tx.update(rsvpRef, { status: 'confirmed' });
      tx.update(eventRef, { rsvp_count: (ev.rsvp_count || 0) + 1 });
      confirmedRsvp = rsvpSnap.data();
    });
    if(confirmedRsvp){
      ChatMembership.add(eventId, playerId, confirmedRsvp.player_name, confirmedRsvp.player_photo_url, 'participant');
    }
  },
  // Host moves a confirmed joiner back to the waitlist — e.g. to free a
  // seat for someone else, or because the joiner hasn't paid. This does
  // NOT auto-promote anyone; the host confirms whoever they choose next.
  async moveToWaitlist(eventId, playerId){
    const eventRef = window.fbDb.collection(EVENTS_COL).doc(eventId);
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, playerId));
    let moved = false;
    await window.fbDb.runTransaction(async function(tx){
      const rsvpSnap = await tx.get(rsvpRef);
      const eventSnap = await tx.get(eventRef);
      if(!rsvpSnap.exists || rsvpSnap.data().status !== 'confirmed') return;
      tx.update(rsvpRef, { status: 'waitlist' });
      moved = true;
      if(eventSnap.exists){
        const ev = eventSnap.data();
        const updates = { rsvp_count: Math.max(0, (ev.rsvp_count || 0) - 1) };
        // A sub host who's no longer confirmed can't keep the role.
        if(ev.sub_host_id === playerId){
          updates.sub_host_id = null;
          updates.sub_host_name = null;
          updates.sub_host_photo_url = null;
        }
        tx.update(eventRef, updates);
      }
    });
    if(moved) ChatMembership.remove(eventId, playerId);
  },
  // Host toggles a joiner's payment status. Every joiner starts unpaid.
  async markPaid(eventId, playerId, paid){
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, playerId));
    await rsvpRef.update({ paid: !!paid });
  },
  // Host designates a confirmed joiner as "sub host" — someone who can help
  // run the event (e.g. manage joiners) if the host isn't around. Stored on
  // the event doc itself since there's only ever one at a time.
  async setSubHost(eventId, playerId, playerName, photoUrl){
    await window.fbDb.collection(EVENTS_COL).doc(eventId).update({
      sub_host_id: playerId,
      sub_host_name: playerName || null,
      sub_host_photo_url: photoUrl || null,
    });
  },
  async clearSubHost(eventId){
    await window.fbDb.collection(EVENTS_COL).doc(eventId).update({
      sub_host_id: null,
      sub_host_name: null,
      sub_host_photo_url: null,
    });
  },
  // Shared helper: marks a joiner's rsvp as cancelled/removed, and frees
  // their seat if they held a confirmed spot. No one is auto-promoted from
  // the waitlist into that freed seat — the host confirms who's next.
  async _releaseSpot(eventId, playerId, newStatus){
    const eventRef = window.fbDb.collection(EVENTS_COL).doc(eventId);
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, playerId));
    let freedSeat = false;
    await window.fbDb.runTransaction(async function(tx){
      // Firestore transactions require ALL reads before ANY writes, so both
      // gets happen up front regardless of which branch below needs them.
      const rsvpSnap = await tx.get(rsvpRef);
      const eventSnap = await tx.get(eventRef);
      if(!rsvpSnap.exists) return;
      const cur = rsvpSnap.data();
      if(cur.status !== 'confirmed' && cur.status !== 'waitlist') return;
      freedSeat = cur.status === 'confirmed';
      tx.update(rsvpRef, { status: newStatus });
      if(eventSnap.exists){
        const ev = eventSnap.data();
        const updates = {};
        if(freedSeat) updates.rsvp_count = Math.max(0, (ev.rsvp_count || 0) - 1);
        // A departing/removed player who was the sub host can't keep the role.
        if(ev.sub_host_id === playerId){
          updates.sub_host_id = null;
          updates.sub_host_name = null;
          updates.sub_host_photo_url = null;
        }
        if(Object.keys(updates).length) tx.update(eventRef, updates);
      }
    });
    // Only a *confirmed* seat implied chat membership — someone leaving
    // the waitlist was never added to the confirmed-participants list.
    if(freedSeat) ChatMembership.remove(eventId, playerId);
  }
};
window.OpenPlayAPI = OpenPlayAPI; // exposed for later use / debugging

/* ---------------- local UI state ---------------- */
const opUI = { user: null, authReady: false, events: [], eventsReady: false, error: null,
  // Discover tab's date filter — { preset: 'all' | 'today' | 'tomorrow' | 'week' | 'weekend' | 'date', date: 'YYYY-MM-DD' | '' }
  discoverFilter: { preset: 'all', date: '' } };
Object.defineProperty(opUI, 'loading', { get: function(){ return !opUI.authReady || !opUI.eventsReady; } });

let opUnsubEvents = null;

// Keeps only the MAX_PAST_EVENTS_PER_HOST most recent *past* events for the
// signed-in host, deleting older ones automatically (see deleteEvent). Runs
// at most once per sign-in (guarded by opCleanupDoneFor) since the event
// list can re-fire on every Firestore snapshot update.
let opCleanupDoneFor = null;
async function opCleanupOldPastEvents(){
  if(!opUI.user || !opUI.eventsReady) return false;
  if(opCleanupDoneFor === opUI.user.id) return false; // already checked this session
  opCleanupDoneFor = opUI.user.id;
  // Use the same time-based "ended" definition as the Host view's Past
  // games list (opIsEnded, which respects end_time) so a game in progress
  // isn't pruned as if it were already over.
  const past = opUI.events.filter(function(e){
    if(e.host_id !== opUI.user.id) return false;
    return opIsEnded(e);
  });
  past.sort(function(a, b){ return new Date(b.start_time) - new Date(a.start_time); }); // newest first
  const toDelete = past.slice(MAX_PAST_EVENTS_PER_HOST);
  let deletedAny = false;
  for(const ev of toDelete){
    try{ await OpenPlayAPI.deleteEvent(ev.id); deletedAny = true; }
    catch(err){ console.warn('Auto-cleanup: could not delete old open-play event', ev.id, err); }
  }
  return deletedAny;
}

function maybeRerenderOpenPlay(){
  if(window.state && (state.tab === 'discover' || state.tab === 'host')) renderActiveView();
}

// Nothing in Firestore changes when an event's start_time simply arrives —
// there's no write, no onSnapshot event, nothing to trigger a rerender.
// Without this, the Open -> Happening flip (and Happening -> back to normal
// once the assumed duration passes) would only ever show up after some
// unrelated rerender happened to fire. Poll once a minute instead so the
// Discover badges stay accurate on their own while the tab is open.
setInterval(function(){ maybeRerenderOpenPlay(); }, 60 * 1000);

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
  // firebase-init.js runs synchronously right before this script, so
  // window.fbAuth/window.fbDb are normally set by the time we get here.
  // But if that init failed (blocked network to Firebase, bad config,
  // an ad/privacy blocker, etc.) fbReady() stays false forever and the
  // old one-shot check below silently left Discover/Host stuck on
  // "Loading..." with no explanation. Poll briefly instead, and if it's
  // still not ready after a few seconds, surface a real error so it's
  // obvious what's wrong instead of spinning indefinitely.
  let bootAttempts = 0;
  const BOOT_MAX_ATTEMPTS = 20; // ~10s at 500ms
  (function tryBoot(){
    if(fbReady()){
      opBootReady();
      return;
    }
    bootAttempts++;
    if(bootAttempts >= BOOT_MAX_ATTEMPTS){
      console.error('Open Play: Firebase never became ready (window.fbAuth/window.fbDb missing). Check firebase-init.js and your network — Firebase requests may be blocked.');
      opUI.authReady = true;
      opUI.eventsReady = true;
      opUI.error = new Error('Couldn\u2019t connect to the live backend. Check your connection and reload \u2014 if this keeps happening, Firebase requests may be blocked on this network/browser.');
      maybeRerenderOpenPlay();
      return;
    }
    setTimeout(tryBoot, 500);
  })();
}

function opBootReady(){
  // Catch the tail end of a signInWithRedirect() fallback, if one happened.
  if(window.fbAuth.getRedirectResult){
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

  // Extra safety net: even with fbReady() true, onAuthStateChanged or
  // onSnapshot could still never fire (e.g. Firestore/Auth requests
  // blocked by network policy or a browser extension). Don't let either
  // one hang the UI forever — flip a clear error after a timeout if
  // still waiting.
  setTimeout(function(){
    let changed = false;
    if(!opUI.authReady){ opUI.authReady = true; changed = true; }
    if(!opUI.eventsReady){
      opUI.eventsReady = true;
      opUI.error = opUI.error || new Error('Taking too long to connect. Check your connection and reload.');
      changed = true;
    }
    if(changed) maybeRerenderOpenPlay();
  }, 12000);
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
// By default the host occupies one of the max_players slots too (they're
// playing too), so "filled" = confirmed joiners + 1, and a max_players of 8
// really only leaves 7 spots open to joiners. Hosts can opt out of this via
// the "count yourself as one of the max players" checkbox when posting/
// editing an event (ev.host_counts_toward_max === false) — in that case the
// max only caps joiners, and the host plays on top of it.
function opHostCountsTowardMax(ev){ return ev.host_counts_toward_max !== false; }
function opFilledCount(ev){ return (ev.rsvp_count || 0) + (opHostCountsTowardMax(ev) ? 1 : 0); }
function opIsFull(ev){ return !!ev.max_players && opFilledCount(ev) >= ev.max_players; }
function opAvailable(ev){ return ev.max_players ? Math.max(0, ev.max_players - opFilledCount(ev)) : null; }

// Events now capture a real end_time from the host (see the Host/Edit
// forms), but older events created before that field existed only have
// start_time — for those we fall back to the old assumed-duration guess
// so they don't just show as permanently "Happening".
const OP_ASSUMED_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours, legacy fallback only
function opEndTimeMs(ev){
  if(ev.end_time){
    const end = new Date(ev.end_time).getTime();
    if(!isNaN(end)) return end;
  }
  const start = ev.start_time ? new Date(ev.start_time).getTime() : NaN;
  return isNaN(start) ? NaN : start + OP_ASSUMED_DURATION_MS;
}
function opIsHappeningNow(ev){
  if(!ev.start_time) return false;
  const start = new Date(ev.start_time).getTime();
  if(isNaN(start)) return false;
  const end = opEndTimeMs(ev);
  const now = Date.now();
  return now >= start && now < end;
}
function opIsEnded(ev){
  if(!ev.start_time) return false;
  const end = opEndTimeMs(ev);
  if(isNaN(end)) return false;
  return Date.now() >= end;
}
// Single source of truth for the four-state status badge: Happening and
// Ended are time-based and take priority over the capacity-based Open/Full,
// since "is it on right now / already over" is more relevant in the moment
// than whether there's still room.
function opEventStatus(ev){
  if(opIsHappeningNow(ev)) return 'happening';
  if(opIsEnded(ev)) return 'ended';
  return opIsFull(ev) ? 'full' : 'open';
}
const OP_STATUS_BADGES = {
  open:      '<span class="op-badge op-badge-open">Open</span>',
  full:      '<span class="op-badge op-badge-full">Full</span>',
  happening: '<span class="op-badge op-badge-happening">Happening</span>',
  ended:     '<span class="op-badge op-badge-ended">Ended</span>'
};
// Label for the "Confirmed (...)" header on Manage joiners / Participants.
// confirmedCount is the number of non-host confirmed joiners; the host is
// always shown as playing regardless of whether they count toward the cap.
function opConfirmedHeaderLabel(ev, confirmedCount){
  const total = confirmedCount + 1;
  if(!ev.max_players) return String(total);
  return opHostCountsTowardMax(ev)
    ? `${total} / ${ev.max_players} — host included`
    : `${total} playing · ${confirmedCount} / ${ev.max_players} spots — host doesn\u2019t count toward max`;
}

function fmtWhen(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}
// Same as fmtWhen but appends the end time too, when the event has one:
// "Sat, Jul 12 · 6:00 PM – 8:00 PM". Falls back to fmtWhen for older events
// that only have a start_time.
function fmtWhenRange(ev){
  const start = fmtWhen(ev.start_time);
  if(!ev.end_time) return start;
  const endD = new Date(ev.end_time);
  if(isNaN(endD)) return start;
  return start + ' – ' + endD.toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' });
}

/* ---------------- Discover: date/time filter (Reclub-style) ---------------- */
function opLocalDateKey(d){
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function opStartOfDay(d){ const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
// Returns true if event `ev` falls within the currently-selected discover
// date filter. Unscheduled/invalid start times always pass through so they
// don't just vanish from the list.
function opMatchesDiscoverFilter(ev, filter){
  if(!ev.start_time) return true;
  const d = new Date(ev.start_time);
  if(isNaN(d)) return true;
  const dayMs = 24 * 60 * 60 * 1000;
  const today = opStartOfDay(new Date());
  const evDay = opStartOfDay(d);
  switch(filter.preset){
    case 'today':
      return evDay.getTime() === today.getTime();
    case 'tomorrow':
      return evDay.getTime() === today.getTime() + dayMs;
    case 'week': {
      const end = new Date(today.getTime() + 7 * dayMs);
      return evDay.getTime() >= today.getTime() && evDay.getTime() < end.getTime();
    }
    case 'weekend': {
      const dow = today.getDay(); // 0 = Sun ... 6 = Sat
      const daysUntilSat = (6 - dow + 7) % 7;
      const sat = new Date(today.getTime() + daysUntilSat * dayMs);
      const sun = new Date(sat.getTime() + dayMs);
      return evDay.getTime() === sat.getTime() || evDay.getTime() === sun.getTime();
    }
    case 'date':
      return !filter.date || opLocalDateKey(evDay) === filter.date;
    default: // 'all'
      return true;
  }
}
function opDiscoverFilterBar(){
  const f = opUI.discoverFilter;
  const chips = [
    { preset: 'all', label: 'All' },
    { preset: 'today', label: 'Today' },
    { preset: 'tomorrow', label: 'Tomorrow' },
    { preset: 'week', label: 'This week' },
    { preset: 'weekend', label: 'This weekend' },
  ];
  return `
    <div class="op-filter-bar">
      <div class="op-filter-chips">
        ${chips.map(function(c){
          return `<button type="button" class="op-filter-chip${f.preset === c.preset ? ' active' : ''}" data-action="op-discover-filter" data-preset="${c.preset}">${c.label}</button>`;
        }).join('')}
        <label class="op-filter-chip op-filter-chip-date${f.preset === 'date' ? ' active' : ''}">
          📅 ${f.preset === 'date' && f.date ? esc(f.date) : 'Pick a date'}
          <input type="date" id="opDiscoverDateInput" value="${f.preset === 'date' ? esc(f.date) : ''}" />
        </label>
      </div>
    </div>
  `;
}

const GOOGLE_G_SVG = '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.9 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34 5.1 29.3 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.4-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34 5.1 29.3 3 24 3c-7.7 0-14.4 4.4-17.7 10.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 36.6 26.7 37.5 24 37.5c-5.3 0-9.7-3.4-11.3-8.1l-6.5 5C9.5 40.5 16.2 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.8l6.2 5.2C39.4 37.5 45 32 45 24c0-1.4-.1-2.7-.4-3.5z"/></svg>';

// Google blocks its sign-in flow (popup AND redirect) inside recognized
// in-app browsers — the webviews Facebook, Instagram, Messenger, TikTok,
// LinkedIn, Line, Snapchat, etc. open when someone taps a shared link
// without leaving their app. Trying to sign in there just fails with
// "This browser or app may not be secure". So: detect those webviews up
// front and route the person to their real browser instead of attempting
// (and failing) the Google popup.
function opInAppBrowserInfo(){
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua) && !window.MSStream;
  const KNOWN = [
    { name: 'Facebook', re: /FBAN|FBAV|FB_IAB/i },
    { name: 'Messenger', re: /MessengerForiOS/i },
    { name: 'Instagram', re: /Instagram/i },
    { name: 'TikTok', re: /BytedanceWebview|Tiktok|MusicalLite/i },
    { name: 'LinkedIn', re: /LinkedInApp/i },
    { name: 'Twitter\/X', re: /Twitter/i },
    { name: 'Line', re: /\bLine\// },
    { name: 'WeChat', re: /MicroMessenger/i },
    { name: 'Snapchat', re: /Snapchat/i },
  ];
  let appName = null;
  for(let i = 0; i < KNOWN.length; i++){ if(KNOWN[i].re.test(ua)){ appName = KNOWN[i].name; break; } }
  return { isAndroid: isAndroid, isIOS: isIOS, appName: appName, isInApp: !!appName };
}

// Best-effort escape to the system default browser. Android's "intent://"
// scheme reliably hands the URL to the phone's normal browser even from
// inside a Chromium-based in-app webview. iOS gives web pages no reliable
// way to force Safari open from inside another app's webview, so there we
// try window.open() (works in some in-app browsers) and otherwise fall
// back to "copy the link" + manual instructions.
function opOpenInSystemBrowser(url, info){
  info = info || opInAppBrowserInfo();
  if(info.isAndroid){
    const noScheme = url.replace(/^https?:\/\//, '');
    window.location.href = 'intent://' + noScheme + '#Intent;scheme=https;action=android.intent.action.VIEW;end;';
    return;
  }
  window.open(url, '_blank');
}

function opInAppBrowserPrompt(){
  const info = opInAppBrowserInfo();
  const url = location.href;
  const iosNote = info.isIOS
    ? ' If it doesn\u2019t open automatically, tap the ••• or share icon at the top of the screen and choose "Open in Safari" (or "Open in Browser").'
    : '';
  openModal(`
    <div class="modal-title">Open in your browser to sign in</div>
    <div class="modal-sub">Google sign-in doesn\u2019t work inside ${esc(info.appName || 'this app')}\u2019s built-in browser.${iosNote}</div>
    <div class="modal-actions">
      <button class="btn btn-primary btn-block" data-action="op-open-in-browser" data-url="${esc(url)}">Open in Browser</button>
      <button class="btn btn-ghost btn-block" data-action="op-copy-current-link" data-url="${esc(url)}">Copy link instead</button>
      <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
    </div>
  `);
}

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

// Which tab (login/register) the *inline* username+password form on the
// full-page sign-in prompt (Host view) is showing. Separate from the modal
// version's state (opModalAuth below) since both can exist at different times.
let opInlineAuthMode = 'login';

// Shared markup for the username/password tabs + form. `formId` lets the
// inline (Host view) and modal (Join flow) instances coexist without id
// clashes; `mode` is 'login' or 'register'; `tabAction`/`submitAction` are
// the data-action values the click/submit wiring below listens for.
function opAuthFormHtml(formId, mode, tabAction){
  const isRegister = mode === 'register';
  return `
    <div class="op-auth-tabs">
      <button type="button" class="op-auth-tab ${!isRegister ? 'active' : ''}" data-action="${tabAction}" data-mode="login">Sign in</button>
      <button type="button" class="op-auth-tab ${isRegister ? 'active' : ''}" data-action="${tabAction}" data-mode="register">Create account</button>
    </div>
    <form id="${formId}" class="op-form" novalidate>
      ${isRegister ? `
      <label class="op-label">Name
        <input class="op-input" name="display_name" autocomplete="name" placeholder="Your name" required minlength="1" maxlength="40" />
      </label>` : ''}
      <label class="op-label">Username
        <input class="op-input" name="username" autocomplete="username" placeholder="letters, numbers, underscore" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" />
      </label>
      <label class="op-label">Password
        <input class="op-input" type="password" name="password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="At least 6 characters" required minlength="6" />
      </label>
      ${isRegister ? `
      <label class="op-label">Confirm password
        <input class="op-input" type="password" name="confirm_password" autocomplete="new-password" placeholder="Retype your password" required minlength="6" />
      </label>` : ''}
      <div class="op-auth-error" id="${formId}Error"></div>
      <button type="submit" class="btn btn-primary btn-block">${isRegister ? 'Create account' : 'Sign in'}</button>
    </form>`;
}

function signInPrompt(afterLabel){
  return `
    <div class="op-signin-card">
      <div class="op-signin-title">Sign in to ${esc(afterLabel)}</div>
      <div class="op-signin-sub">Sign in with Google, or use a username and password.</div>
      <button class="op-google-btn" data-action="op-sign-in">${GOOGLE_G_SVG}<span>Continue with Google</span></button>
      <div class="op-signin-divider"><span>or</span></div>
      ${opAuthFormHtml('opInlineAuthForm', opInlineAuthMode, 'op-inline-auth-tab')}
    </div>`;
}

// Wires the submit handler for the inline (Host view) username/password
// form. Safe to call unconditionally after any render — no-ops if the form
// isn't in the DOM (i.e. the user is already signed in).
function opWireInlineAuthForm(){
  const form = document.getElementById('opInlineAuthForm');
  if(!form) return;
  const errEl = document.getElementById('opInlineAuthFormError');
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    await opSubmitAuthForm(form, errEl, opInlineAuthMode, function(){ renderActiveView(); });
  });
}

// Shared submit logic for both the inline and modal username/password
// forms: registers or signs in, shows a friendly inline error on failure,
// and on success updates opUI.user + calls onSuccess to move on.
async function opSubmitAuthForm(form, errEl, mode, onSuccess){
  if(errEl){ errEl.style.display = 'none'; errEl.textContent = ''; }
  const fd = new FormData(form);
  const username = (fd.get('username') || '').trim();
  const password = fd.get('password') || '';
  const displayName = (fd.get('display_name') || '').trim();
  const submitBtn = form.querySelector('button[type="submit"]');
  const busyLabel = mode === 'register' ? 'Creating\u2026' : 'Signing in\u2026';
  const idleLabel = mode === 'register' ? 'Create account' : 'Sign in';
  if(mode === 'register'){
    if(!displayName){
      if(errEl){ errEl.textContent = 'Enter your name.'; errEl.style.display = 'block'; }
      return;
    }
    const confirmPassword = fd.get('confirm_password') || '';
    if(password !== confirmPassword){
      if(errEl){ errEl.textContent = 'Passwords don\u2019t match.'; errEl.style.display = 'block'; }
      return;
    }
  }
  if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = busyLabel; }
  try{
    const user = mode === 'register'
      ? await OpenPlayAPI.registerWithUsernamePassword(username, password, displayName)
      : await OpenPlayAPI.signInWithUsernamePassword(username, password);
    opUI.user = user;
    toast(`Welcome, ${user.display_name}!`, 'success');
    onSuccess(user);
  }catch(err){
    console.error(err);
    if(errEl){ errEl.textContent = (err && err.message) ? err.message : 'Something went wrong. Please try again.'; errEl.style.display = 'block'; }
    if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = idleLabel; }
  }
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
      <button class="op-google-btn op-google-btn-sm" data-action="op-open-auth-modal" data-after="sign in">${GOOGLE_G_SVG}<span>Sign in</span></button>
    </div>`;
}

/* ---------------- modal sign-in (Google + username/password) ----------------
   Used from places that only have room for a single "Sign in" button (the
   guest chip, the Join flow) rather than the full inline form used in the
   Host view. Reopens itself on tab switch since openModal() just replaces
   the modal's HTML wholesale. */
const opModalAuth = { mode: 'login', afterLabel: 'continue', onSuccess: null };

function opModalAuthHtml(){
  return `
    <div class="op-signin-title">Sign in to ${esc(opModalAuth.afterLabel)}</div>
    <div class="op-signin-sub">Sign in with Google, or use a username and password.</div>
    <button class="op-google-btn" data-action="op-sign-in-modal">${GOOGLE_G_SVG}<span>Continue with Google</span></button>
    <div class="op-signin-divider"><span>or</span></div>
    ${opAuthFormHtml('opModalAuthForm', opModalAuth.mode, 'op-modal-auth-tab')}
    <button class="btn btn-ghost btn-block" data-action="modal-close" style="margin-top:10px;">Cancel</button>`;
}

function opWireModalAuthForm(){
  const form = document.getElementById('opModalAuthForm');
  if(!form) return;
  const errEl = document.getElementById('opModalAuthFormError');
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    await opSubmitAuthForm(form, errEl, opModalAuth.mode, function(user){
      closeModal();
      if(typeof opModalAuth.onSuccess === 'function') opModalAuth.onSuccess(user);
      else renderActiveView();
    });
  });
}

// afterLabel: short phrase for "Sign in to ___" (e.g. "join this game").
// onSuccess(user): called after a successful sign-in/register, instead of
// the default plain re-render — e.g. to reopen an event detail modal.
function opOpenAuthModal(afterLabel, onSuccess){
  opModalAuth.afterLabel = afterLabel || 'continue';
  opModalAuth.onSuccess = onSuccess || null;
  opModalAuth.mode = 'login';
  openModal(opModalAuthHtml());
  opWireModalAuthForm();
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

  // status === 'open' just means the host hasn't cancelled it — it stays
  // 'open' forever unless they do, so we also need to check the time-based
  // opIsEnded() here or games whose end time has already passed would keep
  // showing up in Discover indefinitely.
  const allOpen = opUI.events.filter(function(e){ return e.status === 'open' && !opIsEnded(e); });
  const events = allOpen
    .filter(function(e){ return opMatchesDiscoverFilter(e, opUI.discoverFilter); })
    .sort(function(a, b){ return new Date(a.start_time || 0) - new Date(b.start_time || 0); });

  const emptyMsg = allOpen.length === 0
    ? `No open games posted yet.<br/>Be the first — tap <b>Host</b> to post one.`
    : `No open games match this filter.<br/>Try a different date, or tap <b>All</b> to see everything.`;

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
      ${opDiscoverFilterBar()}
      ${events.length === 0 ? `
        <div class="op-empty">
          ${emptyMsg}
        </div>
      ` : `
        <div class="op-event-list">
          ${events.map(opEventCard).join('')}
        </div>
      `}
    </div>
  `;

  const dateInput = document.getElementById('opDiscoverDateInput');
  if(dateInput){
    dateInput.addEventListener('change', function(){
      if(dateInput.value){
        opUI.discoverFilter = { preset: 'date', date: dateInput.value };
      } else {
        opUI.discoverFilter = { preset: 'all', date: '' };
      }
      renderActiveView();
    });
  }
}

function opEventCard(ev){
  const badge = OP_STATUS_BADGES[opEventStatus(ev)];
  return `
    <div class="op-card" data-action="op-open-event" data-id="${ev.id}">
      <div class="op-card-top">
        <div class="op-card-title">${esc(ev.title)}</div>
        ${badge}
      </div>
      <div class="op-card-row">📍 ${opLocationLinkHtml(ev, esc(ev.location_name))}</div>
      <div class="op-card-row">🗓️ ${fmtWhenRange(ev)}</div>
      <div class="op-card-row">👥 ${opFilledCount(ev)}${ev.max_players ? ' / ' + ev.max_players : ''} players${opHostCountsTowardMax(ev) ? ' (incl. host)' : ''}</div>
      ${ev.fee_amount ? `<div class="op-card-row">💵 ${esc(String(ev.fee_amount))}${ev.fee_note ? ' — ' + esc(ev.fee_note) : ''}</div>` : ''}
    </div>
  `;
}

async function opOpenEventDetail(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  const myRsvp = opUI.user ? await OpenPlayAPI.myRsvpForEvent(eventId, opUI.user.id) : null;
  const isHost = !!opUI.user && ev.host_id === opUI.user.id;
  const isSubHost = !!opUI.user && !isHost && ev.sub_host_id === opUI.user.id;
  const full = opIsFull(ev);
  const ended = opIsEnded(ev);

  let actionButton;
  if(isHost){
    actionButton = `
      <button class="btn btn-ghost" data-action="op-manage-joiners" data-id="${ev.id}">Manage Participants</button>
      <button class="btn btn-ghost" data-action="op-edit-event" data-id="${ev.id}">Edit event</button>
      ${ended
        ? `<button class="op-btn-danger" data-action="op-confirm-delete-event" data-id="${ev.id}">Delete this event</button>`
        : `<button class="op-btn-danger" data-action="op-confirm-cancel-event" data-id="${ev.id}">Cancel this event</button>`}`;
  } else if(myRsvp && myRsvp.leave_requested){
    actionButton = `
      <div class="op-status-note op-status-waitlist">Leave request sent — waiting for the host to confirm.</div>
      <button class="btn btn-ghost" data-action="op-cancel-leave-request" data-id="${ev.id}">Cancel leave request</button>`;
  } else if(myRsvp && myRsvp.status === 'waitlist'){
    actionButton = `
      <div class="op-status-note op-status-waitlist">You're on the waitlist — the host still needs to confirm you.</div>
      <button class="btn btn-ghost" data-action="op-request-leave" data-id="${ev.id}">Request to leave waitlist</button>`;
  } else if(myRsvp){
    actionButton = `
      <div class="op-status-note op-status-confirmed">You're in ✓ · ${myRsvp.paid ? 'Paid' : 'Unpaid'}</div>
      <button class="btn btn-ghost" data-action="op-request-leave" data-id="${ev.id}">Request to leave</button>`;
  } else if(ended){
    // Game's already over — joining/waitlisting no longer makes sense.
    actionButton = `<div class="op-status-note op-status-ended">This game has ended.</div>`;
  } else if(!opUI.user){
    actionButton = `<button class="btn btn-primary" data-action="op-sign-in-to-join" data-id="${ev.id}">${full ? 'Sign in to Join Waitlist' : 'Sign in to Request to Join'}</button>`;
  } else {
    actionButton = `<button class="btn btn-primary" data-action="op-join-event" data-id="${ev.id}">${full ? 'Join Waitlist' : 'Request to Join'}</button>`;
  }
  const subHostButton = isSubHost
    ? `<button class="btn btn-ghost" data-action="op-manage-joiners" data-id="${ev.id}">Manage Participants (sub host)</button>`
    : '';
  const participantsButton = (!isHost && !isSubHost)
    ? `<button class="btn btn-ghost" data-action="op-view-participants" data-id="${ev.id}">View participants</button>`
    : '';
  const canChat = isHost || isSubHost || (!!myRsvp && myRsvp.status !== 'waitlist' && !myRsvp.leave_requested);
  const chatButton = canChat
    ? `<button class="btn btn-ghost" data-action="op-open-chat" data-id="${ev.id}">\ud83d\udcac Event Chat</button>`
    : '';

  openModal(`
    <div class="modal-title">${esc(ev.title)}</div>
    <div class="modal-sub">Hosted by ${esc(ev.host_name)}</div>
    <div class="op-detail-rows">
      <div class="op-detail-row">📍 ${opLocationLinkHtml(ev, `<span>${esc(ev.location_name)}</span>`)}</div>
      <div class="op-detail-row">🗓️ <span>${fmtWhenRange(ev)}</span></div>
      <div class="op-detail-row">👥 <span>${opFilledCount(ev)}${ev.max_players ? ' / ' + ev.max_players : ''} players${opHostCountsTowardMax(ev) ? ' (incl. host)' : ''}${full ? ' · waitlist open' : ''}</span></div>
      ${(ev.skill_min || ev.skill_max) ? `<div class="op-detail-row">🎯 <span>Rating ${ev.skill_min || '—'}–${ev.skill_max || '—'}</span></div>` : ''}
      ${ev.fee_amount ? `<div class="op-detail-row">💵 <span>${esc(String(ev.fee_amount))}${ev.fee_note ? ' — ' + esc(ev.fee_note) : ''}</span></div>` : ''}
      ${ev.sub_host_name ? `<div class="op-detail-row">🙋 <span>Sub host: ${esc(ev.sub_host_name)}</span></div>` : ''}
    </div>
    ${ev.details ? `<div class="op-detail-block"><div class="op-detail-block-title">Details</div><div class="op-detail-block-body">${esc(ev.details)}</div></div>` : ''}
    ${ev.rules ? `<div class="op-detail-block"><div class="op-detail-block-title">Rules</div><div class="op-detail-block-body">${esc(ev.rules)}</div></div>` : ''}
    <div class="op-detail-actions">
      ${actionButton}
      ${subHostButton}
      ${participantsButton}
      ${chatButton}
      <button class="btn btn-ghost" data-action="op-share-event" data-id="${ev.id}">Copy shareable link</button>
      <button class="btn btn-ghost" data-action="modal-close">Close</button>
    </div>
  `);
}

/* ---------------- CHAT VIEW ---------------- */
let opChatChannel = null;

function opChatCleanup(){
  if(opChatChannel){ ChatAPI.unsubscribe(opChatChannel); opChatChannel = null; }
}

// The chat modal can be left in several ways (Back button, the generic
// modal-close handler in script.js, tapping the overlay, Esc...) and we
// don't own most of those code paths. Rather than hook each one, watch
// for the message list leaving the DOM and unsubscribe then.
function opWatchChatCleanup(container){
  if(!container || !window.MutationObserver) return;
  const obs = new MutationObserver(function(){
    if(!document.body.contains(container)){
      opChatCleanup();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function opChatTime(iso){
  try{
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }catch(err){ return ''; }
}

function opChatMessageEl(m, isMine){
  const wrap = document.createElement('div');
  wrap.className = 'op-chat-msg' + (isMine ? ' op-chat-msg-mine' : '');
  wrap.innerHTML = `
    ${!isMine ? `<div class="op-chat-msg-author">${esc(m.user_name || 'Player')}</div>` : ''}
    <div class="op-chat-bubble">${esc(m.body || '')}</div>
    <div class="op-chat-msg-time">${esc(opChatTime(m.created_at))}</div>`;
  return wrap;
}

async function opRenderEventChat(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  if(!opUI.user){
    opOpenAuthModal('join the chat', function(){ opRenderEventChat(eventId); });
    return;
  }

  opChatCleanup();

  openModal(`
    <div class="modal-title">${esc(ev.title)} · Chat</div>
    <div class="modal-sub">Only shown to people in this game — chat itself isn\u2019t private, see note in code</div>
    <div class="op-chat-messages" id="opChatMessages"><div class="op-empty" style="padding:24px;">Loading messages\u2026</div></div>
    <form class="op-chat-form" id="opChatForm">
      <input type="text" class="op-input op-chat-input" id="opChatInput" placeholder="Message the group\u2026" maxlength="500" autocomplete="off" />
      <button type="submit" class="btn btn-primary op-chat-send">Send</button>
    </form>
    <button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}" style="margin-top:8px;">Back</button>
  `);

  const listEl = document.getElementById('opChatMessages');
  opWatchChatCleanup(listEl);
  if(!sbReady()){
    if(listEl) listEl.innerHTML = `<div class="op-empty">Chat isn\u2019t available right now.</div>`;
    return;
  }

  function appendMessage(m){
    if(!listEl) return;
    const nearBottom = (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight) < 60;
    const emptyNote = listEl.querySelector('.op-empty');
    if(emptyNote) emptyNote.remove();
    listEl.appendChild(opChatMessageEl(m, !!(opUI.user && m.user_id === opUI.user.id)));
    if(nearBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  const messages = await ChatAPI.loadRecent(eventId);
  if(listEl){
    listEl.innerHTML = '';
    if(!messages.length){
      listEl.innerHTML = `<div class="op-empty" style="padding:24px;">No messages yet \u2014 say hi \ud83d\udc4b</div>`;
    } else {
      messages.forEach(appendMessage);
    }
    listEl.scrollTop = listEl.scrollHeight;
  }

  opChatChannel = ChatAPI.subscribe(eventId, appendMessage);

  const form = document.getElementById('opChatForm');
  if(form){
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      const input = document.getElementById('opChatInput');
      const body = (input.value || '').trim();
      if(!body) return;
      const btn = form.querySelector('.op-chat-send');
      if(btn) btn.disabled = true;
      input.value = '';
      try{
        await ChatAPI.send(eventId, opUI.user, body);
      }catch(err){
        toast(opFriendlyError(err, 'Message didn\u2019t send \u2014 try again.'), 'error');
        input.value = body;
      }
      if(btn) btn.disabled = false;
      input.focus();
    });
  }
}

/* ---------------- PARTICIPANTS (read-only, for joiners) ---------------- */
async function opRenderParticipants(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  openModal(`<div class="modal-title">Participants</div><div class="op-empty" style="padding:24px;">Loading\u2026</div>`);
  let rows;
  try{
    rows = await OpenPlayAPI.listRsvpsForEvent(eventId);
  }catch(err){
    console.error(err);
    openModal(`<div class="modal-title">Participants</div><div class="op-empty">Couldn\u2019t load participants. Please try again.</div><div class="modal-actions"><button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button></div>`);
    return;
  }
  const confirmed = rows.filter(function(r){ return r.status === 'confirmed'; });
  const waitlist = rows.filter(function(r){ return r.status === 'waitlist'; });

  function readOnlyRow(r){
    const avatar = r.player_photo_url
      ? `<img class="op-user-avatar" src="${esc(r.player_photo_url)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="op-user-avatar op-user-avatar-fallback">${esc((r.player_name || '?').charAt(0).toUpperCase())}</div>`;
    const isSubHost = r.player_id && ev.sub_host_id === r.player_id;
    return `
      <div class="op-joiner-row">
        ${avatar}
        <span class="op-joiner-name">${esc(r.player_name || 'Player')}</span>
        ${isSubHost ? '<span class="op-badge op-badge-subhost">Sub host</span>' : ''}
      </div>`;
  }

  openModal(`
    <div class="modal-title">Participants</div>
    <div class="modal-sub">${esc(ev.title)}</div>

    <div class="op-h-title" style="font-size:14px; margin-top:14px;">Confirmed (${opConfirmedHeaderLabel(ev, confirmed.length)})</div>
    <div class="op-joiner-list">
      ${readOnlyRow({ player_name: (ev.host_name || 'Host') + ' (Host)', player_photo_url: ev.host_photo_url })}
      ${confirmed.map(readOnlyRow).join('')}
    </div>

    <div class="op-h-title" style="font-size:14px; margin-top:18px;">Waitlist (${waitlist.length})</div>
    ${waitlist.length ? `<div class="op-joiner-list">${waitlist.map(readOnlyRow).join('')}</div>` : `<div class="op-empty" style="padding:16px;">No one is waiting.</div>`}

    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button>
    </div>
  `);
}

/* ---------------- EDIT EVENT (host) ---------------- */
function opRenderEditEvent(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  const d = ev.start_time ? new Date(ev.start_time) : null;
  const dateVal = (d && !isNaN(d)) ? d.toISOString().slice(0, 10) : '';
  const timeVal = (d && !isNaN(d)) ? (String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0')) : '';
  const endD = ev.end_time ? new Date(ev.end_time) : null;
  const endTimeVal = (endD && !isNaN(endD)) ? (String(endD.getHours()).padStart(2,'0') + ':' + String(endD.getMinutes()).padStart(2,'0')) : '';

  openModal(`
    <div class="modal-title">Edit event</div>
    <form id="opEditForm" class="op-form">
      <label class="op-label">Title
        <input class="op-input" name="title" value="${esc(ev.title || '')}" required />
      </label>
      <label class="op-label">Location
        <input class="op-input" name="location_name" value="${esc(ev.location_name || '')}" required />
      </label>
      <label class="op-label">Location link (optional)
        <input class="op-input" type="url" name="location_link" value="${esc(ev.location_link || '')}" placeholder="Paste a Google Maps / Waze link" />
      </label>
      <div class="op-form-row">
        <label class="op-label">Date
          <input class="op-input" type="date" name="date" value="${esc(dateVal)}" required />
        </label>
        <label class="op-label">Start time
          <input class="op-input" type="time" name="time" value="${esc(timeVal)}" required />
        </label>
      </div>
      <div class="op-form-row">
        <label class="op-label">End time
          <input class="op-input" type="time" name="end_time" value="${esc(endTimeVal)}" required />
        </label>
      </div>
      <div class="op-form-row">
        <label class="op-label">Max players
          <input class="op-input" type="number" name="max_players" min="2" max="64" value="${ev.max_players || 8}" />
        </label>
        <label class="op-label">Fee (optional)
          <input class="op-input" name="fee_amount" value="${esc(ev.fee_amount || '')}" placeholder="₱300" />
        </label>
      </div>
      <label class="op-checkbox-row">
        <input type="checkbox" name="host_counts_toward_max" ${opHostCountsTowardMax(ev) ? 'checked' : ''} />
        Count yourself as one of the max players
      </label>
      <div class="op-form-row">
        <label class="op-label">Min rating (optional)
          <input class="op-input" type="number" step="0.1" name="skill_min" value="${ev.skill_min != null ? ev.skill_min : ''}" placeholder="3.0" />
        </label>
        <label class="op-label">Max rating (optional)
          <input class="op-input" type="number" step="0.1" name="skill_max" value="${ev.skill_max != null ? ev.skill_max : ''}" placeholder="4.5" />
        </label>
      </div>
      <label class="op-label">Details (optional)
        <textarea class="op-input op-textarea" name="details">${esc(ev.details || '')}</textarea>
      </label>
      <label class="op-label">Rules (optional)
        <textarea class="op-input op-textarea" name="rules">${esc(ev.rules || '')}</textarea>
      </label>
      <div class="modal-actions" style="margin-top:4px;">
        <button type="button" class="btn btn-ghost" data-action="op-open-event" data-id="${ev.id}">Cancel</button>
        <button type="submit" class="btn btn-primary">Save changes</button>
      </div>
    </form>
  `);

  const form = document.getElementById('opEditForm');
  if(form){
    opWireLocationLinkPaste(form);
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      const fd = new FormData(form);
      const date = fd.get('date'), time = fd.get('time'), endTime = fd.get('end_time');
      if(!date || !time){ toast('Pick a date and time.', 'error'); return; }
      if(!endTime){ toast('Pick an end time.', 'error'); return; }
      const start_time = new Date(`${date}T${time}`).toISOString();
      let end_time = new Date(`${date}T${endTime}`).toISOString();
      // An end time earlier than the start time almost always means the
      // game runs past midnight (e.g. 10:00 PM \u2013 12:30 AM) rather than a
      // mistake, so roll it over to the next day instead of rejecting it.
      if(new Date(end_time) <= new Date(start_time)){
        const nextDay = new Date(`${date}T${endTime}`);
        nextDay.setDate(nextDay.getDate() + 1);
        end_time = nextDay.toISOString();
      }
      const payload = {
        title: (fd.get('title') || '').trim() || 'Open Play',
        location_name: (fd.get('location_name') || '').trim(),
        location_link: (fd.get('location_link') || '').trim() || null,
        start_time: start_time,
        end_time: end_time,
        max_players: Number(fd.get('max_players')) || null,
        fee_amount: (fd.get('fee_amount') || '').trim() || null,
        host_counts_toward_max: fd.get('host_counts_toward_max') === 'on',
        skill_min: fd.get('skill_min') ? Number(fd.get('skill_min')) : null,
        skill_max: fd.get('skill_max') ? Number(fd.get('skill_max')) : null,
        details: (fd.get('details') || '').trim() || null,
        rules: (fd.get('rules') || '').trim() || null,
      };
      if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Saving\u2026'; }
      try{
        await OpenPlayAPI.updateEvent(ev.id, payload);
        toast('Event updated.', 'success');
        await opOpenEventDetail(ev.id);
      }catch(err){
        console.error(err);
        toast('Could not save changes. Please try again.', 'error');
        if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Save changes'; }
      }
    });
  }
}

/* ---------------- MANAGE JOINERS (host) ---------------- */
async function opRenderManageJoiners(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  openModal(`<div class="modal-title">Manage Participants</div><div class="op-empty" style="padding:24px;">Loading\u2026</div>`);
  let rows;
  try{
    rows = await OpenPlayAPI.listRsvpsForEvent(eventId);
  }catch(err){
    console.error(err);
    openModal(`<div class="modal-title">Manage Participants</div><div class="op-empty">Couldn\u2019t load joiners. Please try again.</div><div class="modal-actions"><button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button></div>`);
    return;
  }
  const confirmed = rows.filter(function(r){ return r.status === 'confirmed'; });
  const waitlist = rows.filter(function(r){ return r.status === 'waitlist'; });
  const removed = rows.filter(function(r){ return r.status === 'removed' || r.status === 'cancelled'; });
  // Only the actual host can assign/reassign the sub host — someone viewing
  // this screen as the sub host themselves can manage joiners but shouldn't
  // be able to hand the role to someone else (or off to a third party).
  const isActualHost = !!opUI.user && ev.host_id === opUI.user.id;

  function joinerRow(r, opts){
    opts = opts || {};
    const avatar = r.player_photo_url
      ? `<img class="op-user-avatar" src="${esc(r.player_photo_url)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="op-user-avatar op-user-avatar-fallback">${esc((r.player_name || '?').charAt(0).toUpperCase())}</div>`;
    const isPaid = !!r.paid;
    const isSubHost = opts.subHostToggle && r.player_id && ev.sub_host_id === r.player_id;
    return `
      <div class="op-joiner-row">
        ${avatar}
        <span class="op-joiner-name">${esc(r.player_name || 'Player')}</span>
        <div class="op-joiner-actions">
          ${isSubHost ? '<span class="op-badge op-badge-subhost">Sub host</span>' : ''}
          ${r.leave_requested ? `<span class="op-badge op-badge-leave">Wants to leave</span><button class="op-mini-btn op-mini-btn-danger" data-action="op-approve-leave" data-id="${ev.id}" data-player="${esc(r.player_id)}">Approve leave</button>` : ''}
          ${opts.showPaid ? `<button class="op-mini-btn ${isPaid ? 'op-mini-btn-paid' : 'op-mini-btn-unpaid'}" data-action="op-toggle-paid" data-id="${ev.id}" data-player="${esc(r.player_id)}" data-paid="${isPaid ? '1' : '0'}">${isPaid ? 'Paid' : 'Unpaid'}</button>` : ''}
          ${opts.confirmable ? `<button class="op-mini-btn op-mini-btn-primary" data-action="op-confirm-joiner" data-id="${ev.id}" data-player="${esc(r.player_id)}">Confirm</button>` : ''}
          ${opts.moveToWaitlist ? `<button class="op-mini-btn op-mini-btn-ghost" data-action="op-move-to-waitlist" data-id="${ev.id}" data-player="${esc(r.player_id)}">Move to waitlist</button>` : ''}
          ${opts.subHostToggle ? (isSubHost
            ? `<button class="op-mini-btn op-mini-btn-ghost" data-action="op-clear-sub-host" data-id="${ev.id}">Remove sub host</button>`
            : `<button class="op-mini-btn op-mini-btn-ghost" data-action="op-make-sub-host" data-id="${ev.id}" data-player="${esc(r.player_id)}" data-name="${esc(r.player_name || 'this player')}" data-photo="${esc(r.player_photo_url || '')}">Make sub host</button>`
          ) : ''}
          ${opts.removable ? `<button class="op-mini-btn op-mini-btn-danger" data-action="op-confirm-remove-joiner" data-id="${ev.id}" data-player="${esc(r.player_id)}" data-name="${esc(r.player_name || 'this player')}">Remove</button>` : ''}
          ${opts.tag ? `<span class="op-badge op-badge-muted">${opts.tag}</span>` : ''}
        </div>
      </div>`;
  }

  openModal(`
    <div class="modal-title">Manage Participants</div>
    <div class="modal-sub">${esc(ev.title)}</div>

    <div class="op-h-title" style="font-size:14px; margin-top:14px;">Waitlist — pending confirmation (${waitlist.length})</div>
    ${waitlist.length ? `<div class="op-joiner-list">${waitlist.map(function(r){ return joinerRow(r, { confirmable: true, removable: true, showPaid: true }); }).join('')}</div>` : `<div class="op-empty" style="padding:16px;">No one is waiting to be confirmed.</div>`}

    <div class="op-h-title" style="font-size:14px; margin-top:18px;">Confirmed (${opConfirmedHeaderLabel(ev, confirmed.length)})</div>
    ${isActualHost ? `<div class="op-h-sub" style="margin-bottom:8px;">Tap \u201cMake sub host\u201d on a confirmed player to let them help manage joiners while you\u2019re away.</div>` : ''}
    <div class="op-joiner-list">
      ${joinerRow({ player_name: (ev.host_name || 'Host') + ' (Host)', player_photo_url: ev.host_photo_url }, { tag: 'Host' })}
      ${confirmed.map(function(r){ return joinerRow(r, { removable: true, moveToWaitlist: true, showPaid: true, subHostToggle: isActualHost }); }).join('')}
    </div>
    ${confirmed.length === 0 ? `<div class="op-empty" style="padding:16px;">No one else has been confirmed yet.</div>` : ''}

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
    <div class="modal-sub">They'll lose their spot. No one is added automatically — confirm someone from the waitlist to fill it.</div>
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

// Past/ended events can't be "cancelled" (there's nothing left to cancel —
// the game already happened), so the host gets a straightforward delete
// instead. This permanently removes the event and its rsvps, same as the
// auto-cleanup uses (see OpenPlayAPI.deleteEvent).
function opConfirmDeleteEvent(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  openModal(`
    <div class="modal-title">Delete "${esc(ev.title)}"?</div>
    <div class="modal-sub" style="line-height:1.6;">
      This game has already ended. Deleting it removes it — and its RSVP history — for good. This can't be undone.
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="op-open-event" data-id="${ev.id}">Never mind</button>
      <button class="op-btn-danger" data-action="op-delete-event" data-id="${ev.id}">Yes, delete</button>
    </div>
  `);
}

/* ---------------- HOST view ---------------- */
// True once the host has typed/changed anything in the in-progress "Host a
// Game" form. Firestore's subscribeEvents() listener can fire — and call
// maybeRerenderOpenPlay() — at any moment (someone else joins a game, a
// game's status flips, etc), completely unrelated to what the host is
// doing. renderHostView() used to rebuild its whole innerHTML on every one
// of those events, which tore down and recreated the <form>. Recreating a
// focused input mid-keystroke both drops its value AND blurs it — which is
// exactly why this looked like "the keyboard closes and the form clears
// itself": the rerender was the cause of both symptoms, not one causing
// the other. While the form is dirty we now only refresh the read-only
// lists below it and leave the form's DOM node alone (wired in renderHostView).
let opHostFormDirty = false;

function opHostListsHtml(myOpenEvents, myPastEvents){
  return `
    ${myOpenEvents.length ? `
      <div class="op-h-title" style="margin-top:22px;">Your posted games (${myOpenEvents.length}/${MAX_OPEN_EVENTS_PER_HOST})</div>
      <div class="op-event-list">${myOpenEvents.map(opEventCard).join('')}</div>
    ` : ''}

    ${myPastEvents.length ? `
      <div class="op-h-title" style="margin-top:22px;">Past games</div>
      <div class="op-h-sub" style="margin-bottom:10px;">Only your ${MAX_PAST_EVENTS_PER_HOST} most recent are kept \u2014 older ones are removed automatically.</div>
      <div class="op-event-list">${myPastEvents.map(opEventCard).join('')}</div>
    ` : ''}
  `;
}

// Refresh just the "your posted games" / "past games" lists, without
// touching the form above them (used while the host has an in-progress,
// unsaved edit in the form — see the opHostFormDirty guard in renderHostView).
function opRenderHostLists(el, myOpenEvents, myPastEvents){
  const wrap = el.querySelector('#opHostListsWrap');
  if(wrap) wrap.innerHTML = opHostListsHtml(myOpenEvents, myPastEvents);
}

// Lets a host paste a Google Maps / Waze / Apple Maps link straight into the
// Location field and have it land in "Location link" instead, since that's
// almost always what's actually meant when a URL gets pasted there. Wired
// on both the "Host a Game" form and the edit-event form.
function opWireLocationLinkPaste(form){
  const nameInput = form.querySelector('[name="location_name"]');
  const linkInput = form.querySelector('[name="location_link"]');
  if(!nameInput || !linkInput) return;
  nameInput.addEventListener('paste', function(e){
    const cd = e.clipboardData || window.clipboardData;
    const text = cd ? (cd.getData('text') || '').trim() : '';
    if(!/^https?:\/\//i.test(text)) return; // not a link, let the paste behave normally
    e.preventDefault();
    linkInput.value = text;
    linkInput.focus();
    if(typeof linkInput.setSelectionRange === 'function'){
      const len = linkInput.value.length;
      try{ linkInput.setSelectionRange(len, len); }catch(err){ /* ignore */ }
    }
    if(form.id === 'opHostForm') opHostFormDirty = true;
    toast('That looked like a map link \u2014 added it to Location link instead.', 'success');
  });
}

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
    opWireInlineAuthForm();
    return;
  }

  // Auto-prune old past events for this host (runs once per sign-in via
  // opCleanupDoneFor). Only triggers a rerender if something was actually
  // deleted — critical, since rerendering unconditionally here would just
  // call this same function again on every render, in an endless loop.
  opCleanupOldPastEvents().then(function(deletedAny){ if(deletedAny) maybeRerenderOpenPlay(); });

  const mine = opUI.events.filter(function(e){ return e.host_id === opUI.user.id; });
  // status === 'open' only reflects whether the host has cancelled the
  // event — it never flips on its own once the event's time has passed.
  // Splitting purely on status (as this used to) meant an open event whose
  // end time had passed showed up in BOTH "Your posted games" (status still
  // 'open') and "Past games" (start_time < now) at once. Using the
  // time-based opIsEnded() for both sides keeps the two lists mutually
  // exclusive and stops ended games from still counting as "posted".
  const myOpenEvents = mine.filter(function(e){ return e.status === 'open' && !opIsEnded(e); });
  const myPastEvents = mine
    .filter(function(e){ return opIsEnded(e); })
    .sort(function(a, b){ return new Date(b.start_time) - new Date(a.start_time); })
    .slice(0, MAX_PAST_EVENTS_PER_HOST);
  const atOpenLimit = myOpenEvents.length >= MAX_OPEN_EVENTS_PER_HOST;

  // The host is actively filling out the form (and it's still valid to show
  // — i.e. they haven't hit the open-game limit in the meantime from another
  // tab/device). Leave the form node completely untouched and just refresh
  // the lists underneath it, so newly-posted/updated games still stay live
  // without ever touching what's being typed.
  const existingForm = document.getElementById('opHostForm');
  if(existingForm && opHostFormDirty && !atOpenLimit){
    opRenderHostLists(el, myOpenEvents, myPastEvents);
    return;
  }

  el.innerHTML = `
    <div class="op-wrap">
      <div class="op-header">
        <div>
          <div class="op-h-title">Host a Game</div>
          <div class="op-h-sub">Post an open play — others can discover and join</div>
        </div>
      </div>
      ${opAuthChip()}

      ${atOpenLimit ? `
        <div class="op-limit-notice">
          You have ${myOpenEvents.length} / ${MAX_OPEN_EVENTS_PER_HOST} open games posted \u2014 that\u2019s the limit.
          Cancel one below to post a new one.
        </div>
      ` : `
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
            <label class="op-label">Start time
              <input class="op-input" type="time" name="time" required />
            </label>
          </div>
          <div class="op-form-row">
            <label class="op-label">End time
              <input class="op-input" type="time" name="end_time" required />
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
          <label class="op-checkbox-row">
            <input type="checkbox" name="host_counts_toward_max" checked />
            Count yourself as one of the max players
          </label>
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
      `}

      <div id="opHostListsWrap">${opHostListsHtml(myOpenEvents, myPastEvents)}</div>
    </div>
  `;

  opHostFormDirty = false;
  const form = document.getElementById('opHostForm');
  if(form){
    // Any real edit marks the form dirty so a background Firestore update
    // can't blow it away mid-fill. Cleared again on successful submit
    // (opHostFormDirty is also reset at the top of every full render).
    form.addEventListener('input', function(){ opHostFormDirty = true; });
    form.addEventListener('change', function(){ opHostFormDirty = true; });
    opWireLocationLinkPaste(form);
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      // Defensive re-check in case another tab/device posted an event since
      // this view rendered (form is normally hidden once at the limit).
      if(myOpenEvents.length >= MAX_OPEN_EVENTS_PER_HOST){
        toast('You\u2019ve reached the ' + MAX_OPEN_EVENTS_PER_HOST + '-open-game limit. Cancel one first.', 'error');
        return;
      }
      const fd = new FormData(form);
      const date = fd.get('date'), time = fd.get('time'), endTime = fd.get('end_time');
      if(!date || !time){ toast('Pick a date and time.', 'error'); return; }
      if(!endTime){ toast('Pick an end time.', 'error'); return; }
      const start_time = new Date(`${date}T${time}`).toISOString();
      let end_time = new Date(`${date}T${endTime}`).toISOString();
      // An end time earlier than the start time almost always means the
      // game runs past midnight (e.g. 10:00 PM \u2013 12:30 AM) rather than a
      // mistake, so roll it over to the next day instead of rejecting it.
      if(new Date(end_time) <= new Date(start_time)){
        const nextDay = new Date(`${date}T${endTime}`);
        nextDay.setDate(nextDay.getDate() + 1);
        end_time = nextDay.toISOString();
      }
      const payload = {
        title: (fd.get('title') || '').trim() || 'Open Play',
        location_name: (fd.get('location_name') || '').trim(),
        location_link: (fd.get('location_link') || '').trim() || null,
        start_time,
        end_time,
        max_players: Number(fd.get('max_players')) || null,
        fee_amount: (fd.get('fee_amount') || '').trim() || null,
        host_counts_toward_max: fd.get('host_counts_toward_max') === 'on',
        skill_min: fd.get('skill_min') ? Number(fd.get('skill_min')) : null,
        skill_max: fd.get('skill_max') ? Number(fd.get('skill_max')) : null,
        details: (fd.get('details') || '').trim() || null,
        rules: (fd.get('rules') || '').trim() || null,
      };
      if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Posting\u2026'; }
      try{
        const ev = await OpenPlayAPI.createEvent(payload, opUI.user);
        opHostFormDirty = false;
        toast('Open play posted!', 'success');
        state.tab = 'discover';
        saveAll(); renderAll();
        setTimeout(function(){ opOpenEventDetail(ev.id); }, 200);
      }catch(err){
        console.error(err);
        toast(opFriendlyError(err, 'Could not post this event. Please try again.'), 'error');
        if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Post Open Play'; }
        renderActiveView(); // refresh the "your posted games" count/limit banner
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
      const info = opInAppBrowserInfo();
      if(info.isInApp){ opInAppBrowserPrompt(); return; }
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
    case 'op-inline-auth-tab': {
      opInlineAuthMode = t.dataset.mode === 'register' ? 'register' : 'login';
      renderActiveView();
      break;
    }
    case 'op-modal-auth-tab': {
      opModalAuth.mode = t.dataset.mode === 'register' ? 'register' : 'login';
      openModal(opModalAuthHtml());
      opWireModalAuthForm();
      break;
    }
    case 'op-open-auth-modal': {
      opOpenAuthModal(t.dataset.after || 'continue');
      break;
    }
    case 'op-sign-in-modal': {
      if(t.disabled) return;
      const info = opInAppBrowserInfo();
      if(info.isInApp){ opInAppBrowserPrompt(); return; }
      t.disabled = true;
      try{
        const user = await OpenPlayAPI.signInWithGoogle();
        if(user){
          toast(`Welcome, ${user.display_name}!`, 'success');
          opUI.user = user;
          closeModal();
          if(typeof opModalAuth.onSuccess === 'function') opModalAuth.onSuccess(user);
          else renderActiveView();
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
    case 'op-open-in-browser': {
      opOpenInSystemBrowser(t.dataset.url);
      break;
    }
    case 'op-copy-current-link': {
      try{
        await navigator.clipboard.writeText(t.dataset.url);
        toast('Link copied — paste it into your browser app.', 'success');
      }catch(err){
        toast(t.dataset.url, 'default');
      }
      break;
    }
    case 'op-sign-in-to-join': {
      if(t.disabled) return;
      const eventId = t.dataset.id;
      opOpenAuthModal('join this game', function(){
        opOpenEventDetail(eventId); // reopen — Join is now available
      });
      break;
    }
    case 'op-open-event': {
      await opOpenEventDetail(t.dataset.id);
      break;
    }
    case 'op-open-chat': {
      await opRenderEventChat(t.dataset.id);
      break;
    }
    case 'op-join-event': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        const status = await OpenPlayAPI.rsvp(t.dataset.id, opUI.user);
        toast(status === 'confirmed' ? "You're in! RSVP confirmed." : "Request sent — the host will confirm your spot.", 'success');
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
    case 'op-view-participants': {
      await opRenderParticipants(t.dataset.id);
      break;
    }
    case 'op-request-leave': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        await OpenPlayAPI.requestLeave(t.dataset.id, opUI.user);
        toast('Leave request sent — the host will confirm.', 'success');
        await opOpenEventDetail(t.dataset.id);
      }catch(err){
        console.error(err);
        toast('Could not send a leave request. Please try again.', 'error');
      }finally{
        t.disabled = false;
      }
      break;
    }
    case 'op-cancel-leave-request': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        await OpenPlayAPI.cancelLeaveRequest(t.dataset.id, opUI.user);
        toast('Leave request cancelled.', 'success');
        await opOpenEventDetail(t.dataset.id);
      }catch(err){
        console.error(err);
        toast('Could not cancel the leave request. Please try again.', 'error');
      }finally{
        t.disabled = false;
      }
      break;
    }
    case 'op-approve-leave': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        await OpenPlayAPI.approveLeave(t.dataset.id, t.dataset.player);
        toast('Leave approved.', 'success');
        await opRenderManageJoiners(t.dataset.id);
        renderActiveView();
      }catch(err){
        console.error(err);
        toast(opFriendlyError(err, 'Could not approve this leave request.'), 'error');
        t.disabled = false;
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
    case 'op-confirm-delete-event': {
      opConfirmDeleteEvent(t.dataset.id);
      break;
    }
    case 'op-delete-event': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        await OpenPlayAPI.deleteEvent(t.dataset.id);
        toast('Event deleted.', 'success');
        closeModal();
        renderActiveView();
      }catch(err){
        console.error(err);
        toast('Could not delete this event. Please try again.', 'error');
        t.disabled = false;
      }
      break;
    }
    case 'op-edit-event': {
      opRenderEditEvent(t.dataset.id);
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
    case 'op-move-to-waitlist': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        await OpenPlayAPI.moveToWaitlist(t.dataset.id, t.dataset.player);
        toast('Moved to waitlist.', 'success');
        await opRenderManageJoiners(t.dataset.id);
        renderActiveView();
      }catch(err){
        console.error(err);
        toast(opFriendlyError(err, 'Could not move this joiner to the waitlist.'), 'error');
        t.disabled = false;
      }
      break;
    }
    case 'op-toggle-paid': {
      if(t.disabled) return;
      t.disabled = true;
      const nextPaid = t.dataset.paid !== '1';
      try{
        await OpenPlayAPI.markPaid(t.dataset.id, t.dataset.player, nextPaid);
        toast(nextPaid ? 'Marked as paid.' : 'Marked as unpaid.', 'success');
        await opRenderManageJoiners(t.dataset.id);
      }catch(err){
        console.error(err);
        toast(opFriendlyError(err, 'Could not update payment status.'), 'error');
        t.disabled = false;
      }
      break;
    }
    case 'op-make-sub-host': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        await OpenPlayAPI.setSubHost(t.dataset.id, t.dataset.player, t.dataset.name, t.dataset.photo);
        toast((t.dataset.name || 'Player') + ' is now sub host.', 'success');
        await opRenderManageJoiners(t.dataset.id);
      }catch(err){
        console.error(err);
        toast(opFriendlyError(err, 'Could not set the sub host.'), 'error');
        t.disabled = false;
      }
      break;
    }
    case 'op-clear-sub-host': {
      if(t.disabled) return;
      t.disabled = true;
      try{
        await OpenPlayAPI.clearSubHost(t.dataset.id);
        toast('Sub host removed.', 'success');
        await opRenderManageJoiners(t.dataset.id);
      }catch(err){
        console.error(err);
        toast(opFriendlyError(err, 'Could not remove the sub host.'), 'error');
        t.disabled = false;
      }
      break;
    }
    case 'op-discover-filter': {
      opUI.discoverFilter = { preset: t.dataset.preset, date: '' };
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
opBoot();

})();
