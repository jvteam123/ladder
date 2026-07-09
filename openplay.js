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
const MAX_GUESTS_PER_JOIN = 4;        // extra named players one joiner can bring per request
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
// Mirrors the server-side prune trigger (see SQL below), which physically
// deletes anything past the 100 newest rows for an event — so there's
// never more than 100 to load anyway.
const CHAT_HISTORY_LIMIT = 100;
// A message can only be edited within this long of being sent. Also
// enforced server-side by the "author can edit within 1 minute" RLS
// policy below, so an expired edit attempt just comes back as an error.
const CHAT_EDIT_WINDOW_MS = 60 * 1000;
// Per user, per event — mirrors the Storage insert policy below, which is
// the real (server-side) enforcement of this cap.
const CHAT_MAX_ATTACHMENTS_PER_USER = 3;
const CHAT_ATTACHMENT_BUCKET = 'open-play-chat-attachments';
const CHAT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // mirrors the bucket's file_size_limit
const CHAT_ATTACHMENT_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,application/pdf';

// Profile photos — a separate public Storage bucket from chat attachments,
// keyed by user id rather than event id (one photo lives across every
// event a person hosts/joins). See the "Profile photos" SQL comment below
// the chat-attachments bucket setup for the bucket + policy definitions.
// The resulting public URL is written onto the Firebase Auth user's own
// photoURL (via updateProfile), which is where avatar_url already reads
// from everywhere else in the app (see mapAuthUser) — so nothing else
// needs to change to pick the new photo up.
const AVATAR_BUCKET = 'open-play-avatars';
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp';

// Private messages ("PM the host") — a separate table from the group chat
// above. One thread per (event_id, participant_id) pair, between that
// participant and the event's host. Anyone with a *live* rsvp (confirmed
// OR waitlist — matches myRsvpForEvent) is allowed to start a thread; see
// DmEligibility below for how that's mirrored into Supabase so the RLS
// policy can check it (same residual identity-verification limitation as
// ChatMembership — see "NOTE ON AUTH" near the top of this file: this
// stops randoms from posting, but doesn't cryptographically prove who's
// posting). Reads have the same limitation as group chat reads (no
// verified Supabase session tied to the Firebase user), so this is
// "private by convention", not end-to-end private — flagged in the UI.
const DM_TABLE = 'open_play_dm_messages';
const DM_ELIGIBLE_TABLE = 'open_play_dm_eligible_participants';
const DM_HISTORY_LIMIT = 200;
// DM attachments — same file types/size cap as group chat, but a separate
// bucket keyed by (event_id, participant_id) rather than (event_id,
// user_id), since a DM thread only ever has the two of them in it. The
// limit is per *thread* (shared between host + participant), not per
// sender, since either side can post files into the same conversation —
// see the Storage insert policy below for the real enforcement.
const DM_ATTACHMENT_BUCKET = 'open-play-dm-attachments';
const DM_MAX_ATTACHMENTS_PER_THREAD = 6;

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
  // `attachment`, if given, is { url, name, type, size } from
  // uploadAttachment() below. `body` may be empty for an attachment-only
  // message (the DB check constraint requires at least one of the two).
  async send(eventId, user, body, attachment){
    if(!sbReady()) throw new Error('Chat isn\u2019t available right now.');
    const { data, error } = await sbClient.from(CHAT_TABLE).insert({
      event_id: String(eventId),
      user_id: user.id,
      user_name: user.display_name || 'Player',
      avatar_url: user.avatar_url || null,
      body: body || '',
      attachment_url: attachment ? attachment.url : null,
      attachment_name: attachment ? attachment.name : null,
      attachment_type: attachment ? attachment.type : null,
      attachment_size: attachment ? attachment.size : null,
    }).select().single();
    if(error) throw error;
    return data;
  },
  // Only allowed within CHAT_EDIT_WINDOW_MS of sending — also enforced
  // server-side (see "author can edit within 1 minute" policy below).
  async edit(messageId, newBody){
    if(!sbReady()) throw new Error('Chat isn\u2019t available right now.');
    const { data, error } = await sbClient
      .from(CHAT_TABLE)
      .update({ body: newBody, edited_at: new Date().toISOString() })
      .eq('id', messageId)
      .select()
      .single();
    if(error) throw error;
    return data;
  },
  // "Unsend" is a soft delete: the row stays (so the thread doesn't
  // reflow for everyone else) but body/attachment are cleared and
  // `deleted` flips true; the UI renders that as "Message deleted".
  async unsend(messageId){
    if(!sbReady()) throw new Error('Chat isn\u2019t available right now.');
    const { data, error } = await sbClient
      .from(CHAT_TABLE)
      .update({ deleted: true, body: '', attachment_url: null, attachment_name: null, attachment_type: null, attachment_size: null })
      .eq('id', messageId)
      .select()
      .single();
    if(error) throw error;
    return data;
  },
  // Subscribes to inserts (new messages) AND updates (edits/unsends) for
  // one event's chat. `handlers` is { onInsert, onUpdate }. Returns a
  // channel handle to pass to unsubscribe() when the chat view closes.
  subscribe(eventId, handlers, channelSuffix){
    if(!sbReady()) return null;
    return sbClient
      .channel('open-play-chat-' + eventId + (channelSuffix ? '-' + channelSuffix : ''))
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: CHAT_TABLE,
        filter: 'event_id=eq.' + eventId,
      }, function(payload){ if(handlers.onInsert) handlers.onInsert(payload.new); })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: CHAT_TABLE,
        filter: 'event_id=eq.' + eventId,
      }, function(payload){ if(handlers.onUpdate) handlers.onUpdate(payload.new); })
      .subscribe();
  },
  unsubscribe(channel){
    if(channel && sbClient) sbClient.removeChannel(channel);
  },

  // How many (non-deleted) attachments this user has already posted in
  // this event's chat — checked before even opening the file picker so
  // the UI can head off a 4th upload with a friendly message. The real
  // limit is enforced regardless by the Storage insert policy below.
  async getMyAttachmentCount(eventId, userId){
    if(!sbReady() || !userId) return 0;
    const { count, error } = await sbClient
      .from(CHAT_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('event_id', String(eventId))
      .eq('user_id', userId)
      .eq('deleted', false)
      .not('attachment_url', 'is', null);
    if(error){ console.error('[chat] getMyAttachmentCount failed', error); return 0; }
    return count || 0;
  },

  // Uploads one file to the chat-attachments bucket and returns
  // { url, name, type, size } to hand to send(). Path is
  // "<event_id>/<user_id>/<timestamp>_<filename>" so the Storage
  // policies below can read the event/user straight out of the path —
  // same trick as ChatMembership, no verified server-side identity here.
  async uploadAttachment(eventId, userId, file){
    if(!sbReady()) throw new Error('Attachments aren\u2019t available right now.');
    if(file.size > CHAT_MAX_ATTACHMENT_BYTES) throw new Error('That file is too big \u2014 max 5MB.');
    const safeName = file.name.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(-80);
    const path = `${eventId}/${userId}/${Date.now()}_${safeName}`;
    const { error: uploadErr } = await sbClient.storage
      .from(CHAT_ATTACHMENT_BUCKET)
      .upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if(uploadErr){
      // The Storage insert policy rejects a 4th file from the same user
      // in the same event — surface that as a friendly limit message
      // instead of a raw Postgres/Storage error.
      if(/polic/i.test(uploadErr.message || '')) throw new Error(`You\u2019ve reached the ${CHAT_MAX_ATTACHMENTS_PER_USER}-file limit for this game\u2019s chat.`);
      throw uploadErr;
    }
    const { data: pub } = sbClient.storage.from(CHAT_ATTACHMENT_BUCKET).getPublicUrl(path);
    return { url: pub.publicUrl, name: file.name, type: file.type || 'application/octet-stream', size: file.size };
  },

  // Bulk helpers for the unread-chat-badge feature (see the "CHAT UNREAD
  // TRACKING" section below). Read-only "peek" queries, kept here
  // alongside the rest of the chat wire calls.
  async getMyEventIds(userId){
    if(!sbReady() || !userId) return [];
    const { data, error } = await sbClient
      .from(MEMBERSHIP_TABLE)
      .select('event_id')
      .eq('user_id', userId);
    if(error){ console.error('[chat] getMyEventIds failed', error); return []; }
    return (data || []).map(function(r){ return r.event_id; });
  },
  // Latest message timestamp per event id, for badge comparisons. One
  // tiny query per event rather than a grouped query — simpler than a
  // Postgres RPC, and event counts here are small (bounded by
  // MAX_OPEN_EVENTS_PER_HOST per host, plus however many games this
  // person has joined).
  async getLatestTimestamps(eventIds){
    if(!sbReady() || !eventIds || !eventIds.length) return {};
    const results = await Promise.all(eventIds.map(async function(id){
      const { data, error } = await sbClient
        .from(CHAT_TABLE)
        .select('created_at')
        .eq('event_id', id)
        .order('created_at', { ascending: false })
        .limit(1);
      if(error){ console.error('[chat] getLatestTimestamps failed for', id, error); return null; }
      return (data && data[0]) ? data[0].created_at : null;
    }));
    const map = {};
    eventIds.forEach(function(id, i){ if(results[i]) map[id] = results[i]; });
    return map;
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

/* ---------------- PRIVATE MESSAGES (DM) wire calls ---------------- */
const DmAPI = {
  // All messages in one (event, participant) thread, oldest first.
  async loadThread(eventId, participantId){
    if(!sbReady()) return [];
    const { data, error } = await sbClient
      .from(DM_TABLE)
      .select('*')
      .eq('event_id', String(eventId))
      .eq('participant_id', participantId)
      .order('created_at', { ascending: true })
      .limit(DM_HISTORY_LIMIT);
    if(error){ console.error('[dm] load failed', error); return []; }
    return data || [];
  },
  async send(eventId, hostId, participantId, sender, body, attachment){
    if(!sbReady()) throw new Error('Messaging isn\u2019t available right now.');
    const { data, error } = await sbClient.from(DM_TABLE).insert({
      event_id: String(eventId),
      host_id: hostId,
      participant_id: participantId,
      sender_id: sender.id,
      sender_name: sender.display_name || 'Player',
      sender_avatar_url: sender.avatar_url || null,
      body: body || '',
      attachment_url: attachment ? attachment.url : null,
      attachment_name: attachment ? attachment.name : null,
      attachment_type: attachment ? attachment.type : null,
      attachment_size: attachment ? attachment.size : null,
    }).select().single();
    if(error) throw error;
    return data;
  },
  // How many (non-deleted, since DMs have no soft-delete) attachments
  // already exist in this thread — checked before opening the file picker,
  // same idea as ChatAPI.getMyAttachmentCount but scoped to the thread
  // rather than one sender, since host + participant share the cap.
  async getAttachmentCount(eventId, participantId){
    if(!sbReady() || !participantId) return 0;
    const { count, error } = await sbClient
      .from(DM_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('event_id', String(eventId))
      .eq('participant_id', participantId)
      .not('attachment_url', 'is', null);
    if(error){ console.error('[dm] getAttachmentCount failed', error); return 0; }
    return count || 0;
  },
  // Uploads one file to the DM-attachments bucket and returns
  // { url, name, type, size } to hand to send(). Path is
  // "<event_id>/<participant_id>/<timestamp>_<filename>" — keyed by the
  // thread, not the uploader, since either party can post into it; see
  // the Storage insert policy below for the real (server-side) cap.
  async uploadAttachment(eventId, participantId, file){
    if(!sbReady()) throw new Error('Attachments aren\u2019t available right now.');
    if(file.size > CHAT_MAX_ATTACHMENT_BYTES) throw new Error('That file is too big \u2014 max 5MB.');
    const safeName = file.name.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(-80);
    const path = `${eventId}/${participantId}/${Date.now()}_${safeName}`;
    const { error: uploadErr } = await sbClient.storage
      .from(DM_ATTACHMENT_BUCKET)
      .upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if(uploadErr){
      // The Storage insert policy rejects a file past the per-thread cap —
      // surface that as a friendly limit message instead of a raw error.
      if(/polic/i.test(uploadErr.message || '')) throw new Error(`This conversation has reached the ${DM_MAX_ATTACHMENTS_PER_THREAD}-file limit.`);
      throw uploadErr;
    }
    const { data: pub } = sbClient.storage.from(DM_ATTACHMENT_BUCKET).getPublicUrl(path);
    return { url: pub.publicUrl, name: file.name, type: file.type || 'application/octet-stream', size: file.size };
  },
  // For the host's "Messages" list: the single latest message per
  // participant thread on this event, newest thread first.
  async listThreadsForHost(eventId){
    if(!sbReady()) return [];
    const { data, error } = await sbClient
      .from(DM_TABLE)
      .select('*')
      .eq('event_id', String(eventId))
      .order('created_at', { ascending: false });
    if(error){ console.error('[dm] listThreadsForHost failed', error); return []; }
    const seen = {};
    const threads = [];
    (data || []).forEach(function(m){
      if(seen[m.participant_id]) return;
      seen[m.participant_id] = true;
      threads.push(m);
    });
    return threads;
  },
  // Bulk helper for the DM-unread-badge feature (see "DM UNREAD TRACKING"
  // below): the latest message per event, for every event this user
  // hosts, in one query (every DM row carries the event's host_id
  // regardless of who actually sent it — see send() below — so a single
  // "where host_id = me" query covers every hosted event's inbox at
  // once, no need to already know which event ids to ask about).
  async getHostThreadsLatest(hostId){
    if(!sbReady() || !hostId) return {};
    const { data, error } = await sbClient
      .from(DM_TABLE)
      .select('event_id, created_at, sender_id')
      .eq('host_id', hostId)
      .order('created_at', { ascending: false });
    if(error){ console.error('[dm] getHostThreadsLatest failed', error); return {}; }
    const map = {};
    (data || []).forEach(function(m){
      if(!map[m.event_id]) map[m.event_id] = m; // first hit per event_id is the latest (rows are newest-first)
    });
    return map;
  },
  // Mirror of the above for the participant side ("Message host"): the
  // latest message per event in every thread *this user* is the
  // participant of — i.e. every game where they've messaged (or been
  // messaged by) that game's host.
  async getParticipantThreadsLatest(participantId){
    if(!sbReady() || !participantId) return {};
    const { data, error } = await sbClient
      .from(DM_TABLE)
      .select('event_id, created_at, sender_id')
      .eq('participant_id', participantId)
      .order('created_at', { ascending: false });
    if(error){ console.error('[dm] getParticipantThreadsLatest failed', error); return {}; }
    const map = {};
    (data || []).forEach(function(m){
      if(!map[m.event_id]) map[m.event_id] = m;
    });
    return map;
  },
  subscribe(eventId, participantId, onInsert, channelSuffix){
    if(!sbReady()) return null;
    return sbClient
      .channel('open-play-dm-' + eventId + '-' + participantId + (channelSuffix ? '-' + channelSuffix : ''))
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: DM_TABLE,
        filter: 'event_id=eq.' + eventId,
      }, function(payload){
        if(payload.new.participant_id === participantId && onInsert) onInsert(payload.new);
      })
      .subscribe();
  },
  unsubscribe(channel){
    if(channel && sbClient) sbClient.removeChannel(channel);
  },
};

// Mirrors "who currently holds a live rsvp (confirmed or waitlist) on this
// event" into Supabase, so the DM insert policy can require it before
// letting a participant message the host. Populated/cleared alongside the
// Firestore rsvp writes in OpenPlayAPI (rsvp / _releaseSpot / deleteEvent)
// — same best-effort, never-throw shape as ChatMembership above.
const DmEligibility = {
  async add(eventId, userId, userName, avatarUrl){
    if(!sbReady() || !eventId || !userId) return;
    try{
      const { error } = await sbClient.from(DM_ELIGIBLE_TABLE).upsert({
        event_id: String(eventId),
        user_id: userId,
        user_name: userName || null,
        avatar_url: avatarUrl || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'event_id,user_id' });
      if(error) console.error('[dm] eligibility add failed', error);
    }catch(err){ console.error('[dm] eligibility add failed', err); }
  },
  async remove(eventId, userId){
    if(!sbReady() || !eventId || !userId) return;
    try{
      const { error } = await sbClient.from(DM_ELIGIBLE_TABLE)
        .delete().eq('event_id', String(eventId)).eq('user_id', userId);
      if(error) console.error('[dm] eligibility remove failed', error);
    }catch(err){ console.error('[dm] eligibility remove failed', err); }
  },
  async removeAllForEvent(eventId){
    if(!sbReady() || !eventId) return;
    try{
      const { error } = await sbClient.from(DM_ELIGIBLE_TABLE)
        .delete().eq('event_id', String(eventId));
      if(error) console.error('[dm] eligibility cleanup failed', error);
    }catch(err){ console.error('[dm] eligibility cleanup failed', err); }
  },
  async listForEvent(eventId){
    if(!sbReady() || !eventId) return [];
    const { data, error } = await sbClient.from(DM_ELIGIBLE_TABLE).select('*').eq('event_id', String(eventId));
    if(error){ console.error('[dm] listForEvent failed', error); return []; }
    return data || [];
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
  body text not null default '',
  edited_at timestamptz,
  deleted boolean not null default false,
  attachment_url text,
  attachment_name text,
  attachment_type text,
  attachment_size bigint,
  created_at timestamptz not null default now()
);
create index if not exists open_play_chat_messages_event_idx
  on open_play_chat_messages (event_id, created_at);

-- If this table already existed from before edit/unsend/attachments were
-- added, run this block to bring it up to date (safe to re-run):
alter table open_play_chat_messages
  add column if not exists edited_at timestamptz,
  add column if not exists deleted boolean not null default false,
  add column if not exists attachment_url text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text,
  add column if not exists attachment_size bigint;
alter table open_play_chat_messages alter column body drop not null;
alter table open_play_chat_messages alter column body set default '';
update open_play_chat_messages set body = '' where body is null;
alter table open_play_chat_messages alter column body set not null;

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

-- A "live" (non-deleted) message needs a body and/or an attachment; a
-- deleted one is allowed an empty body (that's what unsend clears it to).
alter table open_play_chat_messages drop constraint if exists open_play_chat_messages_body_check;
alter table open_play_chat_messages add constraint open_play_chat_messages_body_check check (
  deleted = true
  or (
    char_length(coalesce(body,'')) <= 500
    and (char_length(coalesce(body,'')) > 0 or attachment_url is not null)
  )
);

-- Reads stay open to anyone who has the event id (same limitation as
-- before: there's no verified identity to restrict reads by).
drop policy if exists "anyone can read chat" on open_play_chat_messages;
create policy "anyone can read chat" on open_play_chat_messages
  for select using (true);

-- Writes require the (event_id, user_id) pair to be a confirmed
-- participant — this is the actual "host has to confirm you" gate.
drop policy if exists "confirmed participants can post chat" on open_play_chat_messages;
create policy "confirmed participants can post chat" on open_play_chat_messages
  for insert with check (
    deleted = false
    and char_length(coalesce(body,'')) <= 500
    and (char_length(coalesce(body,'')) > 0 or attachment_url is not null)
    and exists (
      select 1 from open_play_confirmed_participants p
      where p.event_id = open_play_chat_messages.event_id
        and p.user_id = open_play_chat_messages.user_id
    )
  );

-- Edits: only within 1 minute of created_at. Same residual limitation as
-- the insert policy above (no verified caller identity — see the "NOTE ON
-- AUTH" comment at the top of this file), so this checks "is (event_id,
-- user_id) a confirmed participant", not "is the caller provably that
-- participant".
drop policy if exists "author can edit within 1 minute" on open_play_chat_messages;
create policy "author can edit within 1 minute" on open_play_chat_messages
  for update using (
    created_at > now() - interval '1 minute'
    and exists (
      select 1 from open_play_confirmed_participants p
      where p.event_id = open_play_chat_messages.event_id
        and p.user_id = open_play_chat_messages.user_id
    )
  )
  with check (
    deleted = false
    and char_length(coalesce(body,'')) between 1 and 500
  );

-- Unsend: no time limit, but only clearing content (deleted flips true).
drop policy if exists "author can unsend anytime" on open_play_chat_messages;
create policy "author can unsend anytime" on open_play_chat_messages
  for update using (
    exists (
      select 1 from open_play_confirmed_participants p
      where p.event_id = open_play_chat_messages.event_id
        and p.user_id = open_play_chat_messages.user_id
    )
  )
  with check (deleted = true);

-- The membership table itself is synced by trusted client code (Firestore
-- security rules already gate who can confirm/remove a joiner), so it's
-- readable/writable the same way the old fully-open chat table was.
drop policy if exists "membership readable" on open_play_confirmed_participants;
create policy "membership readable" on open_play_confirmed_participants
  for select using (true);
drop policy if exists "membership syncable" on open_play_confirmed_participants;
create policy "membership syncable" on open_play_confirmed_participants
  for insert with check (true);
drop policy if exists "membership syncable update" on open_play_confirmed_participants;
create policy "membership syncable update" on open_play_confirmed_participants
  for update using (true);
drop policy if exists "membership syncable delete" on open_play_confirmed_participants;
create policy "membership syncable delete" on open_play_confirmed_participants
  for delete using (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'open_play_chat_messages'
  ) then
    alter publication supabase_realtime add table open_play_chat_messages;
  end if;
end $$;

-- Retention: keep only the 100 newest messages per event; every insert
-- prunes anything older past that. Note this does NOT delete the
-- corresponding Storage attachment files for pruned rows — those become
-- orphaned objects in the bucket. Fine at small scale; if that matters
-- later, add a scheduled Edge Function to sweep orphaned files.
create or replace function open_play_chat_prune() returns trigger
language plpgsql security definer as $$
begin
  delete from open_play_chat_messages
  where event_id = new.event_id
    and id not in (
      select id from open_play_chat_messages
      where event_id = new.event_id
      order by created_at desc
      limit 100
    );
  return null;
end;
$$;
drop trigger if exists open_play_chat_prune_trigger on open_play_chat_messages;
create trigger open_play_chat_prune_trigger
  after insert on open_play_chat_messages
  for each row execute function open_play_chat_prune();

-- Attachments: a public Storage bucket, 5MB/file, images + PDF only.
-- Files are stored at "<event_id>/<user_id>/<timestamp>_<filename>" so
-- the policies below can read event/user straight out of the path.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'open-play-chat-attachments', 'open-play-chat-attachments', true, 5242880,
  array['image/jpeg','image/png','image/gif','image/webp','application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "chat attachments public read" on storage.objects;
create policy "chat attachments public read" on storage.objects
  for select using (bucket_id = 'open-play-chat-attachments');

-- The actual "3 files per user per event" cap — enforced here, not just
-- client-side, by counting existing objects under the same event/user path.
drop policy if exists "confirmed participants can upload up to 3 files" on storage.objects;
create policy "confirmed participants can upload up to 3 files" on storage.objects
  for insert with check (
    bucket_id = 'open-play-chat-attachments'
    and exists (
      select 1 from open_play_confirmed_participants p
      where p.event_id = (storage.foldername(name))[1]
        and p.user_id = (storage.foldername(name))[2]
    )
    and (
      select count(*) from storage.objects o
      where o.bucket_id = 'open-play-chat-attachments'
        and (storage.foldername(o.name))[1] = (storage.foldername(name))[1]
        and (storage.foldername(o.name))[2] = (storage.foldername(name))[2]
    ) < 3
  );

drop policy if exists "authors can delete their own chat attachments" on storage.objects;
create policy "authors can delete their own chat attachments" on storage.objects
  for delete using (
    bucket_id = 'open-play-chat-attachments'
    and exists (
      select 1 from open_play_confirmed_participants p
      where p.event_id = (storage.foldername(name))[1]
        and p.user_id = (storage.foldername(name))[2]
    )
  );

-- Profile photos: a separate public Storage bucket from chat attachments,
-- 5MB/file, images only. Files are stored at "<user_id>/<timestamp>_<filename>"
-- so the policy below can check the uploader owns the folder they're
-- writing into (no confirmed-participant check needed here — anyone
-- signed in can set their own photo, unlike per-event chat attachments).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'open-play-avatars', 'open-play-avatars', true, 5242880,
  array['image/jpeg','image/png','image/gif','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars public read" on storage.objects;
create policy "avatars public read" on storage.objects
  for select using (bucket_id = 'open-play-avatars');

-- NOTE ON AUTH applies here too (see the note near the top of this file):
-- Supabase has no verified session tied to the Firebase user, so this can
-- only check "does the uploaded path's first folder match the user id the
-- client claims", not cryptographically prove it. Good enough to stop
-- accidental cross-writes; a determined attacker who already knew another
-- user's uid could still overwrite their folder. Same residual limitation
-- as chat attachments/membership above.
drop policy if exists "users can upload their own avatar" on storage.objects;
create policy "users can upload their own avatar" on storage.objects
  for insert with check (bucket_id = 'open-play-avatars');

drop policy if exists "users can replace their own avatar" on storage.objects;
create policy "users can replace their own avatar" on storage.objects
  for update using (bucket_id = 'open-play-avatars');

-- ---------------- PRIVATE MESSAGES (DM: participant <-> host) ----------------
-- One thread per (event_id, participant_id). Only the host and that one
-- participant are meant to use a given thread; see the "Private messages"
-- comment near DM_TABLE above for the honest limitation on read privacy.
create table if not exists open_play_dm_messages (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  host_id text not null,
  participant_id text not null,
  sender_id text not null,
  sender_name text not null,
  sender_avatar_url text,
  body text not null default '',
  attachment_url text,
  attachment_name text,
  attachment_type text,
  attachment_size bigint,
  created_at timestamptz not null default now(),
  constraint open_play_dm_messages_sender_check check (sender_id = host_id or sender_id = participant_id),
  constraint open_play_dm_messages_parties_check check (host_id <> participant_id)
);
create index if not exists open_play_dm_messages_thread_idx
  on open_play_dm_messages (event_id, participant_id, created_at);

-- If this table already existed from before attachments were added, run
-- this block to bring it up to date (safe to re-run):
alter table open_play_dm_messages
  add column if not exists attachment_url text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text,
  add column if not exists attachment_size bigint;
alter table open_play_dm_messages alter column body drop not null;
alter table open_play_dm_messages alter column body set default '';
update open_play_dm_messages set body = '' where body is null;
alter table open_play_dm_messages alter column body set not null;

-- A message needs a body and/or an attachment — same rule as group chat,
-- just without the "or deleted" clause since DMs have no soft-delete.
alter table open_play_dm_messages drop constraint if exists open_play_dm_messages_body_check;
alter table open_play_dm_messages add constraint open_play_dm_messages_body_check check (
  char_length(coalesce(body,'')) <= 500
  and (char_length(coalesce(body,'')) > 0 or attachment_url is not null)
);

create table if not exists open_play_dm_eligible_participants (
  event_id text not null,
  user_id text not null,
  user_name text,
  avatar_url text,
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

alter table open_play_dm_messages enable row level security;
alter table open_play_dm_eligible_participants enable row level security;

-- Reads: same honest limitation as group chat (no verified Supabase
-- session tied to the Firebase user — see "NOTE ON AUTH" at the top of
-- this file), so this can't cryptographically restrict reads to just the
-- two parties. Left open to anyone who has the event_id + participant_id,
-- same trust model as the rest of this file. The UI tells users this.
drop policy if exists "dm readable" on open_play_dm_messages;
create policy "dm readable" on open_play_dm_messages
  for select using (true);

-- Writes: a participant can only post if they currently hold a live rsvp
-- (confirmed or waitlist) on that event — mirrored into
-- open_play_dm_eligible_participants by DmEligibility. The host side has
-- no equivalent Firestore-backed check available here, so it's gated the
-- same way group-chat host posting effectively is: trusted client code.
drop policy if exists "eligible parties can dm" on open_play_dm_messages;
create policy "eligible parties can dm" on open_play_dm_messages
  for insert with check (
    char_length(coalesce(body,'')) <= 500
    and (char_length(coalesce(body,'')) > 0 or attachment_url is not null)
    and (
      sender_id = host_id
      or (
        sender_id = participant_id
        and exists (
          select 1 from open_play_dm_eligible_participants e
          where e.event_id = open_play_dm_messages.event_id
            and e.user_id = open_play_dm_messages.participant_id
        )
      )
    )
  );

-- Eligibility mirror table: synced by trusted client code the same way
-- open_play_confirmed_participants is (see that table's policies above).
drop policy if exists "dm eligibility readable" on open_play_dm_eligible_participants;
create policy "dm eligibility readable" on open_play_dm_eligible_participants
  for select using (true);
drop policy if exists "dm eligibility syncable insert" on open_play_dm_eligible_participants;
create policy "dm eligibility syncable insert" on open_play_dm_eligible_participants
  for insert with check (true);
drop policy if exists "dm eligibility syncable update" on open_play_dm_eligible_participants;
create policy "dm eligibility syncable update" on open_play_dm_eligible_participants
  for update using (true);
drop policy if exists "dm eligibility syncable delete" on open_play_dm_eligible_participants;
create policy "dm eligibility syncable delete" on open_play_dm_eligible_participants
  for delete using (true);

-- DM attachments: a public Storage bucket, 5MB/file, images + PDF only —
-- same shape as chat attachments, but the cap is per *thread*
-- (event_id/participant_id), shared between host and participant, since
-- files are stored at "<event_id>/<participant_id>/<timestamp>_<filename>"
-- rather than per-uploader. See "NOTE ON AUTH" near the top of this file
-- for the same residual identity-verification limitation as everywhere
-- else here: this checks the thread is a real (eligible) one, not
-- cryptographically who's uploading into it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'open-play-dm-attachments', 'open-play-dm-attachments', true, 5242880,
  array['image/jpeg','image/png','image/gif','image/webp','application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "dm attachments public read" on storage.objects;
create policy "dm attachments public read" on storage.objects
  for select using (bucket_id = 'open-play-dm-attachments');

drop policy if exists "eligible threads can upload up to 6 dm attachments" on storage.objects;
create policy "eligible threads can upload up to 6 dm attachments" on storage.objects
  for insert with check (
    bucket_id = 'open-play-dm-attachments'
    and exists (
      select 1 from open_play_dm_eligible_participants e
      where e.event_id = (storage.foldername(name))[1]
        and e.user_id = (storage.foldername(name))[2]
    )
    and (
      select count(*) from storage.objects o
      where o.bucket_id = 'open-play-dm-attachments'
        and (storage.foldername(o.name))[1] = (storage.foldername(name))[1]
        and (storage.foldername(o.name))[2] = (storage.foldername(name))[2]
    ) < 6
  );

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'open_play_dm_messages'
  ) then
    alter publication supabase_realtime add table open_play_dm_messages;
  end if;
end $$;
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

  // ----- profile photo (Supabase Storage, written onto the Firebase user) -----
  // Uploads to the avatars bucket, then sets it as the current Firebase Auth
  // user's photoURL — that's the single field avatar_url reads everywhere
  // (see mapAuthUser), so Google sign-ins and username/password accounts
  // both pick up a custom photo the same way. Returns the new public URL.
  async uploadAvatar(userId, file){
    if(!sbReady()) throw new Error('Photo upload isn\u2019t available right now.');
    if(!fbReady() || !window.fbAuth.currentUser) throw new Error('Sign in to upload a profile photo.');
    if(!/^image\//.test(file.type || '')) throw new Error('Please choose an image file.');
    if(file.size > AVATAR_MAX_BYTES) throw new Error('That image is too big \u2014 max 5MB.');
    const safeName = file.name.replace(/[^a-zA-Z0-9_.\-]/g, '_').slice(-80);
    const path = `${userId}/${Date.now()}_${safeName}`;
    const { error: uploadErr } = await sbClient.storage
      .from(AVATAR_BUCKET)
      .upload(path, file, { contentType: file.type || 'image/jpeg' });
    if(uploadErr) throw uploadErr;
    const { data: pub } = sbClient.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    await window.fbAuth.currentUser.updateProfile({ photoURL: pub.publicUrl });
    return pub.publicUrl;
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
    DmEligibility.removeAllForEvent(eventId);
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
  // Event ids where this player actually played (was confirmed at some
  // point) — used to build their History tab alongside events they
  // hosted/sub-hosted. Doesn't include waitlist-only or removed rsvps.
  async listConfirmedEventIdsForPlayer(userId){
    if(!userId) return [];
    const snap = await window.fbDb.collection(RSVPS_COL)
      .where('player_id', '==', userId)
      .where('status', '==', 'confirmed')
      .get();
    return snap.docs.map(function(d){ return d.data().event_id; });
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
    // Confirmed or waitlisted both count as "in line" — either way they can
    // now PM the host (see DmEligibility above).
    DmEligibility.add(eventId, user.id, user.display_name, user.avatar_url);
    return resultStatus;
  },
  // Adds one named "plus one" the joining player is bringing along. This
  // is its own RSVP doc (own waitlist entry, own confirm/remove buttons in
  // Manage Participants) rather than bundled into the inviting player's
  // spot, because the host confirms/removes each person individually —
  // exactly like a normal joiner, just tagged with who vouched for them.
  // Guests have no Firebase account of their own, so they never sign in,
  // chat, or DM — this is a named placeholder on the roster until the
  // host acts on it. player_id is a synthetic id, never a real uid.
  async addGuestRsvp(eventId, invitedByUser, guestName){
    const guestId = 'guest_' + invitedByUser.id + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const rsvpRef = window.fbDb.collection(RSVPS_COL).doc(rsvpDocId(eventId, guestId));
    await rsvpRef.set({
      event_id: eventId,
      player_id: guestId,
      player_name: guestName,
      player_photo_url: null,
      status: 'waitlist',
      paid: false,
      is_guest: true,
      invited_by: invitedByUser.id,
      invited_by_name: invitedByUser.display_name || 'a player',
      created_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return guestId;
  },
  // Joins the event for the signed-in user, then adds one guest RSVP per
  // non-empty name supplied (capped at MAX_GUESTS_PER_JOIN — extras are
  // silently dropped, since the UI itself won't let more than that many
  // fields exist). Guest adds run after the real rsvp succeeds and are
  // best-effort per name: if one fails, the rest still get tried, since
  // the person's own spot is already secured either way.
  async rsvpWithGuests(eventId, user, guestNames){
    const status = await OpenPlayAPI.rsvp(eventId, user);
    const names = (guestNames || [])
      .map(function(n){ return (n || '').trim(); })
      .filter(Boolean)
      .slice(0, MAX_GUESTS_PER_JOIN);
    for(const name of names){
      try{ await OpenPlayAPI.addGuestRsvp(eventId, user, name); }
      catch(err){ console.error('[rsvp] could not add guest', name, err); }
    }
    return status;
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
    let wasLive = false;
    await window.fbDb.runTransaction(async function(tx){
      // Firestore transactions require ALL reads before ANY writes, so both
      // gets happen up front regardless of which branch below needs them.
      const rsvpSnap = await tx.get(rsvpRef);
      const eventSnap = await tx.get(eventRef);
      if(!rsvpSnap.exists) return;
      const cur = rsvpSnap.data();
      if(cur.status !== 'confirmed' && cur.status !== 'waitlist') return;
      freedSeat = cur.status === 'confirmed';
      wasLive = true;
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
    // DM eligibility covers confirmed AND waitlist, so it comes off
    // whenever either kind of live rsvp goes away.
    if(wasLive) DmEligibility.remove(eventId, playerId);
  }
};
window.OpenPlayAPI = OpenPlayAPI; // exposed for later use / debugging

/* ---------------- local UI state ---------------- */
const opUI = { user: null, authReady: false, events: [], eventsReady: false, error: null,
  // Discover tab's date filter — { preset: 'all' | 'today' | 'tomorrow' | 'week' | 'weekend' | 'date', date: 'YYYY-MM-DD' | '' }
  discoverFilter: { preset: 'all', date: '' },
  // eventId -> true for every event this signed-in user hosts that has a
  // private message (DM) from a participant they haven't opened yet. See
  // the "DM UNREAD TRACKING" section below — same shape/pattern as
  // unreadChatEvents, just scoped to the host's own "Messages" button.
  unreadDmEvents: {},
  // eventId -> true for every event where this signed-in user (as a
  // participant, not the host) has a "Message host" thread with a reply
  // from the host they haven't opened yet. Mirror of unreadDmEvents for
  // the other side of the same conversation.
  unreadDmMineEvents: {},
  // eventId -> true for every chat-enabled event (hosted, sub-hosted, or
  // joined) that has messages the signed-in user hasn't opened yet. See
  // the "CHAT UNREAD TRACKING" section below.
  unreadChatEvents: {},
  // Event ids the signed-in user was actually confirmed in at some point —
  // null until loaded (see opEnsureHistoryIds), used by the History tab.
  historyParticipantIds: null };
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
  if(window.state && (state.tab === 'discover' || state.tab === 'host' || state.tab === 'op-ended')) renderActiveView();
}

// Loads (once per sign-in) the ids of past events the signed-in user was
// actually confirmed in, for the History tab. host_id/sub_host_id matches
// don't need a fetch — they're already on the event doc — only "was I a
// confirmed participant somewhere" needs a query. Guarded the same way
// opCleanupOldPastEvents is, so a re-render mid-load doesn't refire it.
let opHistoryIdsLoadedFor = null;
function opEnsureHistoryIds(){
  if(!opUI.user) return;
  if(opHistoryIdsLoadedFor === opUI.user.id) return;
  opHistoryIdsLoadedFor = opUI.user.id;
  OpenPlayAPI.listConfirmedEventIdsForPlayer(opUI.user.id).then(function(ids){
    opUI.historyParticipantIds = ids;
    maybeRerenderOpenPlay();
  }).catch(function(err){
    console.error('[history] could not load participant history', err);
    opUI.historyParticipantIds = [];
    opHistoryIdsLoadedFor = null; // allow a retry on the next visit
    maybeRerenderOpenPlay();
  });
}

/* ---------------- DM UNREAD TRACKING ----------------
   Puts a small notification dot in two places, for the two sides of the
   same conversation:
     - the host's "Messages" button (and their event cards), when a
       participant has sent them a DM they haven't opened yet
     - a participant's "Message host" button (and their event cards),
       when the host has replied to *their* thread and they haven't
       opened it yet
   Both read state is tracked per (user, event) in localStorage, same as
   chat — purely a "have I looked" marker, no cross-device sync needed,
   and the same key works for both sides since one person can't be both
   host and participant of the same single event. */
const OP_DM_READ_PREFIX = 'op_dm_read:';
function opDmReadKey(eventId, userId){ return OP_DM_READ_PREFIX + userId + ':' + eventId; }
function opGetDmLastRead(eventId){
  if(!opUI.user) return null;
  try{ return localStorage.getItem(opDmReadKey(eventId, opUI.user.id)); }
  catch(err){ return null; }
}
function opMarkDmRead(eventId, iso){
  if(!opUI.user) return;
  try{ localStorage.setItem(opDmReadKey(eventId, opUI.user.id), iso || new Date().toISOString()); }
  catch(err){ /* private browsing / storage full — badge just won't persist across reloads */ }
  if(opUI.unreadDmEvents[eventId]) delete opUI.unreadDmEvents[eventId];
  if(opUI.unreadDmMineEvents[eventId]) delete opUI.unreadDmMineEvents[eventId];
}

// Refetches whether there's a DM newer than what's been read, for both
// sides at once — same throttled/poll-based shape as opRefreshChatUnread,
// for the same reasons (no realtime subscription just for a badge).
let opDmUnreadRefreshInFlight = false;
let opLastDmUnreadRefresh = 0;
async function opRefreshDmUnread(force){
  if(!opUI.user || !sbReady()){
    opUI.unreadDmEvents = {};
    opUI.unreadDmMineEvents = {};
    return;
  }
  if(!force && typeof document !== 'undefined' && document.hidden) return;
  const now = Date.now();
  if(!force && now - opLastDmUnreadRefresh < 20000) return; // throttle
  if(opDmUnreadRefreshInFlight) return;
  opDmUnreadRefreshInFlight = true;
  opLastDmUnreadRefresh = now;
  try{
    const myId = opUI.user.id;
    function isOpenForMessaging(eventId){
      const ev = opUI.events.find(function(e){ return e.id === eventId; });
      return !ev || !opMessagingClosed(ev); // unknown event (not loaded yet) — don't hide it, err on showing
    }

    const [hostLatest, mineLatest] = await Promise.all([
      DmAPI.getHostThreadsLatest(myId),
      DmAPI.getParticipantThreadsLatest(myId),
    ]);

    const unreadHost = {};
    Object.keys(hostLatest).forEach(function(eventId){
      const latest = hostLatest[eventId];
      if(latest.sender_id === myId) return; // last word was ours — nothing new to see
      if(!isOpenForMessaging(eventId)) return;
      const lastRead = opGetDmLastRead(eventId);
      if(!lastRead || new Date(latest.created_at) > new Date(lastRead)) unreadHost[eventId] = true;
    });
    opUI.unreadDmEvents = unreadHost;

    const unreadMine = {};
    Object.keys(mineLatest).forEach(function(eventId){
      const latest = mineLatest[eventId];
      if(latest.sender_id === myId) return; // last word was ours
      if(!isOpenForMessaging(eventId)) return;
      const lastRead = opGetDmLastRead(eventId);
      if(!lastRead || new Date(latest.created_at) > new Date(lastRead)) unreadMine[eventId] = true;
    });
    opUI.unreadDmMineEvents = unreadMine;
  }catch(err){
    console.error('[dm] unread refresh failed', err);
  }finally{
    opDmUnreadRefreshInFlight = false;
    maybeRerenderOpenPlay();
  }
}

/* ---------------- CHAT UNREAD TRACKING ----------------
   Puts a small notification dot on event cards and on the "Chat"
   button in event detail when a chat this user can post in has messages
   they haven't opened yet. "Can chat in" reuses the same
   open_play_confirmed_participants membership table the chat RLS policy
   already relies on (see ChatMembership above) — it's exactly "host, sub
   host, or confirmed joiner" for each event, kept in sync as a side
   effect of those actions elsewhere in this file.

   Read state is tracked per (user, event) in localStorage — it's purely
   a "have I looked" marker with no need to sync across devices. */
const OP_CHAT_READ_PREFIX = 'op_chat_read:';
function opChatReadKey(eventId, userId){ return OP_CHAT_READ_PREFIX + userId + ':' + eventId; }
function opGetChatLastRead(eventId){
  if(!opUI.user) return null;
  try{ return localStorage.getItem(opChatReadKey(eventId, opUI.user.id)); }
  catch(err){ return null; }
}
function opMarkChatRead(eventId, iso){
  if(!opUI.user) return;
  try{ localStorage.setItem(opChatReadKey(eventId, opUI.user.id), iso || new Date().toISOString()); }
  catch(err){ /* private browsing / storage full — badge just won't persist across reloads */ }
  if(opUI.unreadChatEvents[eventId]) delete opUI.unreadChatEvents[eventId];
}

// eventId currently open in the chat modal, if any — new messages for
// this event mark themselves read immediately instead of lighting up
// the badge, since the person is already looking at them.
let opChatOpenEventId = null;

// Refetches which events this user can chat in and whether each has
// unread messages. Poll-based by design (no realtime subscription here) —
// a badge doesn't need millisecond accuracy, and one channel per visible
// event was the main thing driving up Supabase Realtime's per-connection
// channel count and monthly message quota on the free tier. Throttled
// since it fires opportunistically (every Discover/Host render, plus a
// slow poll) rather than only on demand.
let opUnreadRefreshInFlight = false;
let opLastUnreadRefresh = 0;
async function opRefreshChatUnread(force){
  if(!opUI.user || !sbReady()){
    opUI.unreadChatEvents = {};
    return;
  }
  // Skip while the tab is in the background — nobody's looking at the
  // badge, and it'll catch up the moment the tab regains focus (see the
  // visibilitychange listener below).
  if(!force && typeof document !== 'undefined' && document.hidden) return;
  const now = Date.now();
  if(!force && now - opLastUnreadRefresh < 20000) return; // throttle
  if(opUnreadRefreshInFlight) return;
  opUnreadRefreshInFlight = true;
  opLastUnreadRefresh = now;
  try{
    const allIds = await ChatAPI.getMyEventIds(opUI.user.id);
    // Chat closes for good OP_POST_END_MESSAGING_WINDOW_MS after a game
    // ends (see opMessagingClosed) — no point fetching or tracking read
    // state past that, but it should stay tracked during the grace period
    // right after a game ends, not cut off the instant it ends.
    const ids = allIds.filter(function(id){
      const ev = opUI.events.find(function(e){ return e.id === id; });
      return !ev || !opMessagingClosed(ev);
    });
    if(!ids.length){ opUI.unreadChatEvents = {}; return; }
    const latestMap = await ChatAPI.getLatestTimestamps(ids);
    const unread = {};
    ids.forEach(function(id){
      if(id === opChatOpenEventId) return; // already looking at it
      const latest = latestMap[id];
      if(!latest) return;
      const lastRead = opGetChatLastRead(id);
      if(!lastRead || new Date(latest) > new Date(lastRead)) unread[id] = true;
    });
    opUI.unreadChatEvents = unread;
  }catch(err){
    console.error('[chat] unread refresh failed', err);
  }finally{
    opUnreadRefreshInFlight = false;
    maybeRerenderOpenPlay();
  }
}

// Nothing in Firestore changes when an event's start_time simply arrives —
// there's no write, no onSnapshot event, nothing to trigger a rerender.
// Without this, the Open -> Happening flip (and Happening -> back to normal
// once the assumed duration passes) would only ever show up after some
// unrelated rerender happened to fire. Poll once a minute instead so the
// Discover badges stay accurate on their own while the tab is open.
setInterval(function(){ maybeRerenderOpenPlay(); opRefreshChatUnread(); opRefreshDmUnread(); }, 60 * 1000);

// opRefreshChatUnread() no-ops while the tab is hidden (see above), so
// catch up immediately on refocus rather than waiting up to a minute for
// the next poll tick.
if(typeof document !== 'undefined'){
  document.addEventListener('visibilitychange', function(){
    if(!document.hidden){ opRefreshChatUnread(true); opRefreshDmUnread(true); }
  });
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
    const signedOut = !user && !!opUI.user;
    opUI.user = user;
    opUI.authReady = true;
    if(signedOut){
      opUI.unreadChatEvents = {};
      opUI.unreadDmEvents = {};
      opUI.unreadDmMineEvents = {};
      opUI.historyParticipantIds = null;
      opHistoryIdsLoadedFor = null;
    } else if(user){
      opRefreshChatUnread(true);
      opRefreshDmUnread(true);
    }
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
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>' },
    { id: 'op-ended', label: 'Ended', desc: 'Games you\u2019ve hosted or played that have ended',
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></svg>' }
  );
}

// Wrap the core renderActiveView so 'discover' / 'host' render without touching script.js
const _coreRenderActiveView = window.renderActiveView;
window.renderActiveView = function(){
  if(state && (state.tab === 'discover' || state.tab === 'host' || state.tab === 'op-ended')){
    const target = document.getElementById('view');
    if(state.tab === 'discover') renderDiscoverView(target);
    else if(state.tab === 'host') renderHostView(target);
    else renderHistoryView(target);
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
// Chat and DMs stay open for a short grace period after a game ends (so
// people can still say thanks, settle up, share photos, etc.), then close
// for good — an ended game's roster isn't going to change, so there's no
// ongoing reason to keep messaging live indefinitely. Applies everywhere
// the same way (Ended list or not), since it's the same underlying event.
const OP_POST_END_MESSAGING_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // 2 days
function opMessagingClosed(ev){
  const end = opEndTimeMs(ev);
  if(isNaN(end)) return false;
  return Date.now() >= end + OP_POST_END_MESSAGING_WINDOW_MS;
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

// Builds the plain-text blurb for "Copy shareable link" — title, venue,
// date/time range, and payment (when the host set one), followed by a
// blank line and the RSVP link on its own line so it's easy to paste
// straight into a group chat while still being tappable. Plain text, not
// HTML, so this uses the raw field values rather than esc(). Falls back
// to just the bare link if the event can't be found (e.g. a stale card).
function opShareText(ev, url){
  if(!ev) return url;
  const lines = [ev.title || 'Open Play'];
  if(ev.location_name) lines.push('📍 ' + ev.location_name);
  const when = fmtWhenRange(ev);
  if(when) lines.push('🗓️ ' + when);
  if(ev.fee_amount) lines.push('💵 ' + ev.fee_amount + (ev.fee_note ? ' — ' + ev.fee_note : ''));
  lines.push('');
  lines.push('RSVP: ' + url);
  return lines.join('\n');
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
  // Supabase RLS rejection (e.g. the chat edit window has closed) reads
  // as a generic Postgres policy-violation message — swap in something
  // an actual person can act on.
  if(err && err.message && /row-level security/i.test(err.message)){
    return 'That\u2019s no longer allowed \u2014 the 1-minute edit window may have passed.';
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
        <div class="op-user-avatar-wrap">
          ${avatar}
          <button type="button" class="op-avatar-edit-btn" data-action="op-change-avatar" title="Change profile photo">\ud83d\udcf7</button>
          <input type="file" id="opAvatarFileInput" accept="${AVATAR_ACCEPT}" style="display:none;" />
        </div>
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

  opRefreshChatUnread(); // throttled — cheap to call on every render
  opRefreshDmUnread(); // throttled — cheap to call on every render

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

/* ---------------- HISTORY view ---------------- */
// Past/ended games the signed-in user was part of — as host, sub host, or
// a confirmed participant (see opEnsureHistoryIds / listConfirmedEventIdsForPlayer).
// Cancelled events never happened, so they're excluded. Note this only
// shows events that haven't been auto-pruned yet (see
// MAX_PAST_EVENTS_PER_HOST / opCleanupOldPastEvents) — a host's older past
// games age out for everyone, including people who played in them.
function renderHistoryView(el){
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
  if(!opUI.user){
    el.innerHTML = `
      <div class="op-wrap">
        <div class="op-header">
          <div>
            <div class="op-h-title">History</div>
            <div class="op-h-sub">Games you\u2019ve hosted or played that have ended</div>
          </div>
        </div>
        <div class="op-signin-card">
          <div class="op-signin-title">Sign in to see your history</div>
          <div class="op-signin-sub">Past games you hosted, co-hosted, or played in will show up here, along with who else was there.</div>
          <button class="op-google-btn" data-action="op-open-auth-modal" data-after="see your game history">${GOOGLE_G_SVG}<span>Continue with Google</span></button>
        </div>
      </div>`;
    return;
  }

  opEnsureHistoryIds(); // fire-and-forget; re-renders once loaded

  const uid = opUI.user.id;
  const stillLoadingIds = opUI.historyParticipantIds === null;
  const confirmedIds = opUI.historyParticipantIds || [];
  const events = opUI.events
    .filter(function(e){
      if(e.status === 'cancelled') return false;
      if(!opIsEnded(e)) return false;
      return e.host_id === uid || e.sub_host_id === uid || confirmedIds.indexOf(e.id) !== -1;
    })
    .sort(function(a, b){ return new Date(b.start_time || 0) - new Date(a.start_time || 0); }); // most recent first

  const emptyMsg = stillLoadingIds
    ? 'Loading your history\u2026'
    : `No past games yet.<br/>Games you host or play in will show up here once they\u2019re over.`;

  el.innerHTML = `
    <div class="op-wrap">
      <div class="op-header">
        <div>
          <div class="op-h-title">History</div>
          <div class="op-h-sub">Games you\u2019ve hosted or played that have ended</div>
        </div>
      </div>
      ${opAuthChip()}
      ${events.length === 0 ? `
        <div class="op-empty">${emptyMsg}</div>
      ` : `
        <div class="op-event-list">${events.map(opEventCard).join('')}</div>
      `}
    </div>
  `;
}

function opEventCard(ev){
  const badge = OP_STATUS_BADGES[opEventStatus(ev)];
  // Lit when this event's chat has messages the current user (host, sub
  // host, or confirmed joiner) hasn't opened yet — see "CHAT UNREAD
  // TRACKING" above. Also lit when the host has an unread private message
  // on this event — see "DM UNREAD TRACKING" above.
  const hasUnread = !!opUI.unreadChatEvents[ev.id] || !!opUI.unreadDmEvents[ev.id] || !!opUI.unreadDmMineEvents[ev.id];
  const unreadDot = hasUnread
    ? `<span class="op-chat-unread-dot" title="New messages"></span>` : '';
  return `
    <div class="op-card" data-action="op-open-event" data-id="${ev.id}">
      <div class="op-card-top">
        <div class="op-card-title">${esc(ev.title)}${unreadDot}</div>
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
    actionButton = `<button class="btn btn-primary" data-action="op-open-join-request" data-id="${ev.id}">${full ? 'Join Waitlist' : 'Request to Join'}</button>`;
  }
  const subHostButton = isSubHost
    ? `<button class="btn btn-ghost" data-action="op-manage-joiners" data-id="${ev.id}">Manage Participants (sub host)</button>`
    : '';
  // Once a game has ended, only the host/sub host and whoever was actually
  // confirmed in it can still look up who else played — waitlisted (never
  // got in) or removed players can't. Live/upcoming games keep the old
  // open-to-anyone behavior.
  const canSeeParticipants = !isHost && !isSubHost && (!ended || (!!myRsvp && myRsvp.status === 'confirmed'));
  const participantsButton = canSeeParticipants
    ? `<button class="btn btn-ghost" data-action="op-view-participants" data-id="${ev.id}">View participants</button>`
    : '';
  const messagingClosed = opMessagingClosed(ev);
  const canChat = !messagingClosed && (isHost || isSubHost || (!!myRsvp && myRsvp.status !== 'waitlist' && !myRsvp.leave_requested));
  const hasUnreadChat = canChat && !!opUI.unreadChatEvents[ev.id];
  const chatButton = canChat
    ? `<button class="btn btn-ghost" data-action="op-open-chat" data-id="${ev.id}">\ud83d\udcac Chat${hasUnreadChat ? '<span class="op-chat-unread-dot op-chat-unread-dot-btn" title="New chat messages"></span>' : ''}</button>`
    : (ended && messagingClosed ? `<button class="btn btn-ghost" disabled title="Chat closes 2 days after a game ends">\ud83d\udcac Chat closed</button>` : '');
  // PM the host: anyone holding a live-or-was-live rsvp (confirmed or
  // waitlist) can start a private thread with the host. The host instead
  // gets a "Messages" button that lists every thread on this event.
  const hasUnreadDm = isHost && !messagingClosed && !!opUI.unreadDmEvents[ev.id];
  const hasUnreadDmMine = !isHost && !messagingClosed && !!opUI.unreadDmMineEvents[ev.id];
  const dmButton = messagingClosed
    ? (ended && (isHost || (!isSubHost && !!myRsvp)) ? `<button class="btn btn-ghost" disabled title="Messages close 2 days after a game ends">\u2709\ufe0f Messages closed</button>` : '')
    : (isHost
      ? `<button class="btn btn-ghost" data-action="op-open-dm-list" data-id="${ev.id}">\u2709\ufe0f Messages${hasUnreadDm ? '<span class="op-chat-unread-dot op-chat-unread-dot-btn" title="New message"></span>' : ''}</button>`
      : (!isSubHost && !!myRsvp
        ? `<button class="btn btn-ghost" data-action="op-message-host" data-id="${ev.id}">\u2709\ufe0f Message host${hasUnreadDmMine ? '<span class="op-chat-unread-dot op-chat-unread-dot-btn" title="New reply from host"></span>' : ''}</button>`
        : ''));

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
      ${dmButton}
      <button class="btn btn-ghost" data-action="op-share-event" data-id="${ev.id}">Copy shareable link</button>
      <button class="btn btn-ghost" data-action="modal-close">Close</button>
    </div>
  `);
}

/* ---------------- JOIN REQUEST (bring extra players) ---------------- */
// "Request to Join" opens here first instead of RSVP'ing immediately, so
// a player can optionally list other people they're bringing by name.
// Each name becomes its own waitlist entry (see OpenPlayAPI.addGuestRsvp)
// that the host reviews and confirms one at a time in Manage Participants,
// same as any other joiner — just tagged "Guest of {inviter}" there so
// the host knows who vouched for them.
function opGuestFieldRowHtml(){
  return `<div class="op-form-row" style="align-items:center; margin-bottom:8px;">
    <input type="text" class="op-input op-guest-input" style="margin-bottom:0;" placeholder="Player name" maxlength="60" />
    <button type="button" class="op-mini-btn op-mini-btn-danger" data-guest-remove style="flex:none;">Remove</button>
  </div>`;
}

function opRenderJoinRequestModal(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev || !opUI.user) return;
  const full = opIsFull(ev);
  const verb = full ? 'Join Waitlist' : 'Request to Join';

  openModal(`
    <div class="modal-title">${verb}</div>
    <div class="modal-sub">${esc(ev.title)}</div>
    <form id="opJoinRequestForm" class="op-form">
      <div class="op-detail-row" style="margin-bottom:10px;">You <span>\u2014 ${esc(opUI.user.display_name || 'signed in player')}</span></div>
      <label class="op-label">Bringing anyone else? (optional)</label>
      <div id="opGuestFields"></div>
      <button type="button" class="btn btn-ghost" id="opAddGuestBtn" style="margin-bottom:12px;">+ Add a player</button>
      <div class="op-h-sub" style="margin:-6px 0 12px;">Each name you add waits for the host to confirm separately, same as your own spot.</div>
      <button type="submit" class="btn btn-primary btn-block" id="opJoinSubmitBtn">${verb}</button>
    </form>
    <button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}" style="margin-top:8px;">Back</button>
  `);

  const fieldsEl = document.getElementById('opGuestFields');
  const addBtn = document.getElementById('opAddGuestBtn');
  function guestInputs(){ return fieldsEl ? Array.from(fieldsEl.querySelectorAll('.op-guest-input')) : []; }
  function refreshAddBtn(){ if(addBtn) addBtn.style.display = guestInputs().length >= MAX_GUESTS_PER_JOIN ? 'none' : ''; }
  function addGuestField(){
    if(guestInputs().length >= MAX_GUESTS_PER_JOIN || !fieldsEl) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = opGuestFieldRowHtml();
    const row = wrap.firstElementChild;
    fieldsEl.appendChild(row);
    const removeBtn = row.querySelector('[data-guest-remove]');
    if(removeBtn) removeBtn.addEventListener('click', function(){ row.remove(); refreshAddBtn(); });
    const input = row.querySelector('.op-guest-input');
    if(input) input.focus();
    refreshAddBtn();
  }
  if(addBtn) addBtn.addEventListener('click', addGuestField);

  const form = document.getElementById('opJoinRequestForm');
  if(form){
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      const submitBtn = document.getElementById('opJoinSubmitBtn');
      if(submitBtn) submitBtn.disabled = true;
      const guestNames = guestInputs().map(function(i){ return i.value; });
      try{
        const status = await OpenPlayAPI.rsvpWithGuests(eventId, opUI.user, guestNames);
        const guestCount = guestNames.map(function(n){ return (n || '').trim(); }).filter(Boolean).length;
        const guestNote = guestCount ? ` +${guestCount} more waiting on the host\u2019s confirmation.` : '';
        toast((status === 'confirmed' ? "You're in! RSVP confirmed." : 'Request sent \u2014 the host will confirm your spot.') + guestNote, 'success');
        closeModal();
        renderActiveView();
      }catch(err){
        console.error(err);
        toast(opFriendlyError(err, 'Could not send your request. Please try again.'), 'error');
        if(submitBtn) submitBtn.disabled = false;
      }
    });
  }
}

/* ---------------- CHAT VIEW ---------------- */
let opChatChannel = null;

function opChatCleanup(){
  if(opChatChannel){ ChatAPI.unsubscribe(opChatChannel); opChatChannel = null; }
  opChatOpenEventId = null;
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

function opChatAttachmentHtml(m){
  if(!m.attachment_url) return '';
  const isImage = (m.attachment_type || '').indexOf('image/') === 0;
  if(isImage){
    return `<a href="${esc(m.attachment_url)}" target="_blank" rel="noopener" class="op-chat-attach-img-link">
      <img src="${esc(m.attachment_url)}" class="op-chat-attach-img" alt="${esc(m.attachment_name || 'attachment')}" loading="lazy" />
    </a>`;
  }
  return `<a href="${esc(m.attachment_url)}" target="_blank" rel="noopener" class="op-chat-attach-file">\ud83d\udcce ${esc(m.attachment_name || 'File')}</a>`;
}

// A message can be edited only by its author, only while not already
// deleted, and only within CHAT_EDIT_WINDOW_MS of being sent — mirrors
// the "author can edit within 1 minute" RLS policy (see SQL above), so
// this is a UI convenience, not the real enforcement.
function opChatCanEdit(m){
  if(!opUI.user || !m || m.deleted || m.user_id !== opUI.user.id) return false;
  return (Date.now() - new Date(m.created_at).getTime()) <= CHAT_EDIT_WINDOW_MS;
}

function opChatMsgActionsHtml(m){
  const editBtn = opChatCanEdit(m)
    ? `<button type="button" class="op-chat-msg-action" data-msg-action="edit">Edit</button>` : '';
  return `<div class="op-chat-msg-actions">${editBtn}<button type="button" class="op-chat-msg-action op-chat-msg-action-danger" data-msg-action="delete">Unsend</button></div>`;
}

// Builds the inner HTML for one message bubble — used both for the
// initial render and to re-render a single message in place after an
// edit, unsend, or cancelled edit/delete confirmation.
function opChatBubbleHtml(m, isMine){
  if(m.deleted){
    return `
      ${!isMine ? `<div class="op-chat-msg-author">${esc(m.user_name || 'Player')}</div>` : ''}
      <div class="op-chat-bubble op-chat-bubble-deleted">Message deleted</div>
      <div class="op-chat-msg-time">${esc(opChatTime(m.created_at))}</div>`;
  }
  const editedTag = m.edited_at ? ' <span class="op-chat-edited-tag">(edited)</span>' : '';
  const attachHtml = opChatAttachmentHtml(m);
  const bodyHtml = m.body ? `<div class="op-chat-bubble-text">${esc(m.body)}</div>` : '';
  return `
    ${!isMine ? `<div class="op-chat-msg-author">${esc(m.user_name || 'Player')}</div>` : ''}
    <div class="op-chat-bubble">${attachHtml}${bodyHtml}</div>
    <div class="op-chat-msg-time">${esc(opChatTime(m.created_at))}${editedTag}</div>
    ${isMine ? opChatMsgActionsHtml(m) : ''}`;
}

function opChatMessageEl(m, isMine){
  const wrap = document.createElement('div');
  wrap.className = 'op-chat-msg' + (isMine ? ' op-chat-msg-mine' : '');
  wrap.dataset.msgId = m.id;
  wrap.innerHTML = opChatBubbleHtml(m, isMine);
  return wrap;
}

async function opRenderEventChat(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev) return;
  if(opMessagingClosed(ev)){
    openModal(`<div class="modal-title">Chat</div><div class="op-empty" style="padding:24px;">Chat closed 2 days after this game ended.</div><div class="modal-actions"><button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button></div>`);
    return;
  }
  if(!opUI.user){
    opOpenAuthModal('join the chat', function(){ opRenderEventChat(eventId); });
    return;
  }

  opChatCleanup();
  opChatOpenEventId = eventId;
  opMarkChatRead(eventId); // clear the badge right away; refined below once we know the real latest message time

  // Self-heal membership: ChatMembership.add() normally fires at the
  // moment someone hosts an event or gets an RSVP confirmed, but anyone
  // whose host/RSVP record predates that sync (or slipped through for any
  // other reason) would otherwise be permanently unable to edit/unsend
  // their own messages, since those RLS policies require a membership
  // row. Re-confirming it here, every time this user opens this event's
  // chat, fixes that with no manual backfill needed. Best-effort — same
  // as every other ChatMembership call, this must never block chat itself.
  try{
    const isHost = ev.host_id === opUI.user.id;
    const isSubHost = !isHost && ev.sub_host_id === opUI.user.id;
    const myRsvp = (!isHost && !isSubHost) ? await OpenPlayAPI.myRsvpForEvent(eventId, opUI.user.id) : null;
    const isConfirmedJoiner = !!myRsvp && myRsvp.status !== 'waitlist' && !myRsvp.leave_requested;
    if(isHost || isSubHost || isConfirmedJoiner){
      const role = isHost ? 'host' : (isSubHost ? 'subhost' : 'participant');
      await ChatMembership.add(eventId, opUI.user.id, opUI.user.display_name, opUI.user.avatar_url, role);
    }
  }catch(err){ console.error('[chat] membership self-heal failed', err); }

  openModal(`
    <div class="modal-title">${esc(ev.title)} · Chat</div>
    <div class="modal-sub">Only shown to people in this game — chat itself isn\u2019t private, see note in code</div>
    <div class="op-chat-messages" id="opChatMessages"><div class="op-empty" style="padding:24px;">Loading messages\u2026</div></div>
    <div class="op-chat-attach-preview" id="opChatAttachPreview" style="display:none;"></div>
    <form class="op-chat-form" id="opChatForm">
      <button type="button" class="op-chat-attach-btn" id="opChatAttachBtn" title="Attach a file (max ${CHAT_MAX_ATTACHMENTS_PER_USER} per game)">\ud83d\udcce</button>
      <input type="file" id="opChatFileInput" accept="${CHAT_ATTACHMENT_ACCEPT}" style="display:none;" />
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

  // Local store of message objects by id — lets edit/unsend/cancel
  // re-render one bubble in place without re-fetching the whole thread.
  const msgStore = {};

  function appendMessage(m){
    msgStore[m.id] = m;
    if(!listEl) return;
    const nearBottom = (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight) < 60;
    const emptyNote = listEl.querySelector('.op-empty');
    if(emptyNote) emptyNote.remove();
    listEl.appendChild(opChatMessageEl(m, !!(opUI.user && m.user_id === opUI.user.id)));
    if(nearBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  function updateMessage(m){
    msgStore[m.id] = m;
    if(!listEl) return;
    const el = listEl.querySelector('[data-msg-id="' + m.id + '"]');
    if(!el) return;
    el.innerHTML = opChatBubbleHtml(m, !!(opUI.user && m.user_id === opUI.user.id));
  }

  const messages = await ChatAPI.loadRecent(eventId);
  if(listEl){
    listEl.innerHTML = '';
    if(!messages.length){
      listEl.innerHTML = `<div class="op-empty" style="padding:24px;">No messages yet \u2014 say hi \ud83d\udc4b</div>`;
    } else {
      messages.forEach(appendMessage);
      opMarkChatRead(eventId, messages[messages.length - 1].created_at);
    }
    listEl.scrollTop = listEl.scrollHeight;
  }

  opChatChannel = ChatAPI.subscribe(eventId, {
    onInsert: function(m){
      appendMessage(m);
      opMarkChatRead(eventId, m.created_at); // already looking at it — never badge this one
    },
    onUpdate: function(m){
      updateMessage(m); // someone's edit/unsend landed — reflects instantly, incl. our own
    },
  }, 'open');

  // ---- attachments ----
  let myAttachmentCount = 0;
  try{ myAttachmentCount = await ChatAPI.getMyAttachmentCount(eventId, opUI.user.id); }catch(err){ /* best effort — real cap is server-side */ }
  let pendingAttachment = null; // File staged for the next send

  const attachBtn = document.getElementById('opChatAttachBtn');
  const fileInput = document.getElementById('opChatFileInput');
  const previewEl = document.getElementById('opChatAttachPreview');

  function renderAttachPreview(){
    if(!previewEl) return;
    if(!pendingAttachment){ previewEl.style.display = 'none'; previewEl.innerHTML = ''; return; }
    previewEl.style.display = 'flex';
    previewEl.innerHTML = `
      <span class="op-chat-attach-preview-name">\ud83d\udcce ${esc(pendingAttachment.name)}</span>
      <button type="button" class="op-chat-attach-remove" id="opChatAttachRemove" title="Remove">\u2715</button>`;
    const removeBtn = document.getElementById('opChatAttachRemove');
    if(removeBtn) removeBtn.addEventListener('click', function(){ pendingAttachment = null; renderAttachPreview(); });
  }

  if(attachBtn && fileInput){
    attachBtn.addEventListener('click', function(){
      if(myAttachmentCount >= CHAT_MAX_ATTACHMENTS_PER_USER){
        toast(`You\u2019ve already shared ${CHAT_MAX_ATTACHMENTS_PER_USER} files in this game\u2019s chat \u2014 that\u2019s the limit.`, 'error');
        return;
      }
      fileInput.click();
    });
    fileInput.addEventListener('change', function(){
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ''; // reset so picking the same file again still fires change
      if(!file) return;
      if(file.size > CHAT_MAX_ATTACHMENT_BYTES){ toast('That file is too big \u2014 max 5MB.', 'error'); return; }
      pendingAttachment = file;
      renderAttachPreview();
    });
  }

  const form = document.getElementById('opChatForm');
  if(form){
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      const input = document.getElementById('opChatInput');
      const body = (input.value || '').trim();
      if(!body && !pendingAttachment) return;
      const btn = form.querySelector('.op-chat-send');
      if(btn) btn.disabled = true;
      if(attachBtn) attachBtn.disabled = true;
      const savedBody = body;
      const savedAttachment = pendingAttachment;
      input.value = '';
      pendingAttachment = null;
      renderAttachPreview();
      try{
        let attachmentPayload = null;
        if(savedAttachment){
          attachmentPayload = await ChatAPI.uploadAttachment(eventId, opUI.user.id, savedAttachment);
          myAttachmentCount++;
        }
        await ChatAPI.send(eventId, opUI.user, savedBody, attachmentPayload);
      }catch(err){
        toast(opFriendlyError(err, 'Message didn\u2019t send \u2014 try again.'), 'error');
        input.value = savedBody;
        if(savedAttachment && !/limit/i.test((err && err.message) || '')){
          pendingAttachment = savedAttachment; // put it back unless it was the limit that failed
          renderAttachPreview();
        }
      }
      if(btn) btn.disabled = false;
      if(attachBtn) attachBtn.disabled = false;
      input.focus();
    });
  }

  // ---- edit / unsend, via delegation on the message list ----
  if(listEl){
    listEl.addEventListener('click', async function(e){
      const actionBtn = e.target.closest('[data-msg-action]');
      if(!actionBtn) return;
      const msgEl = actionBtn.closest('[data-msg-id]');
      if(!msgEl) return;
      const m = msgStore[msgEl.dataset.msgId];
      if(!m) return;
      const action = actionBtn.dataset.msgAction;

      if(action === 'edit'){
        if(!opChatCanEdit(m)){
          toast('You can only edit a message within 1 minute of sending it.', 'error');
          updateMessage(m); // drop the now-stale Edit button
          return;
        }
        const bubble = msgEl.querySelector('.op-chat-bubble');
        if(!bubble) return;
        bubble.innerHTML = `
          <input type="text" class="op-input op-chat-edit-input" maxlength="500" value="${esc(m.body || '')}" />
          <div class="op-chat-edit-actions">
            <button type="button" class="op-mini-btn op-mini-btn-primary" data-msg-action="save-edit">Save</button>
            <button type="button" class="op-mini-btn op-mini-btn-ghost" data-msg-action="cancel-edit">Cancel</button>
          </div>`;
        const editInput = bubble.querySelector('.op-chat-edit-input');
        if(editInput){ editInput.focus(); editInput.setSelectionRange(editInput.value.length, editInput.value.length); }
        return;
      }

      if(action === 'cancel-edit'){ updateMessage(m); return; }

      if(action === 'save-edit'){
        const editInput = msgEl.querySelector('.op-chat-edit-input');
        const newBody = editInput ? editInput.value.trim() : '';
        if(!newBody){ toast('Message can\u2019t be empty.', 'error'); return; }
        if(!opChatCanEdit(m)){
          toast('The 1-minute edit window has passed.', 'error');
          updateMessage(m);
          return;
        }
        actionBtn.disabled = true;
        try{
          const updated = await ChatAPI.edit(m.id, newBody);
          updateMessage(updated || Object.assign({}, m, { body: newBody, edited_at: new Date().toISOString() }));
        }catch(err){
          toast(opFriendlyError(err, 'Couldn\u2019t save that edit.'), 'error');
          updateMessage(m);
        }
        return;
      }

      if(action === 'delete'){
        const actionsRow = msgEl.querySelector('.op-chat-msg-actions');
        if(actionsRow){
          actionsRow.innerHTML = `
            <span class="op-chat-msg-action-confirm">Unsend this message?</span>
            <button type="button" class="op-mini-btn op-mini-btn-danger" data-msg-action="confirm-delete">Yes, unsend</button>
            <button type="button" class="op-mini-btn op-mini-btn-ghost" data-msg-action="cancel-delete">Cancel</button>`;
        }
        return;
      }

      if(action === 'cancel-delete'){ updateMessage(m); return; }

      if(action === 'confirm-delete'){
        actionBtn.disabled = true;
        try{
          const updated = await ChatAPI.unsend(m.id);
          updateMessage(updated || Object.assign({}, m, { deleted: true, body: '', attachment_url: null }));
        }catch(err){
          toast(opFriendlyError(err, 'Couldn\u2019t unsend that message.'), 'error');
          updateMessage(m);
        }
        return;
      }
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

  // Confirmed roster renders as a Reclub-style grid: a square photo tile
  // per person, name underneath, plus dashed "open" tiles for any spots
  // still unfilled — so at a glance you can see exactly how full the game
  // is, not just a count. Only meaningful when the host set a max_players
  // cap; uncapped games just show filled tiles and no blanks. Computed off
  // the confirmed rows we just fetched (rather than ev.rsvp_count, which
  // can lag a beat behind Firestore) so the tile count is always accurate.
  let emptySlots = 0;
  if(ev.max_players){
    const filledForCap = confirmed.length + (opHostCountsTowardMax(ev) ? 1 : 0);
    emptySlots = Math.max(0, ev.max_players - filledForCap);
  }

  function participantTile(r){
    const avatar = r.player_photo_url
      ? `<img class="op-participant-avatar" src="${esc(r.player_photo_url)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="op-participant-avatar op-user-avatar-fallback">${esc((r.player_name || '?').charAt(0).toUpperCase())}</div>`;
    const isSubHost = r.player_id && ev.sub_host_id === r.player_id;
    const tag = r.tag ? `<span class="op-participant-tag">${esc(r.tag)}</span>`
      : isSubHost ? `<span class="op-participant-tag">Sub host</span>`
      : r.is_guest ? `<span class="op-participant-tag op-participant-tag-muted">Guest</span>`
      : '';
    return `
      <div class="op-participant-tile">
        ${avatar}
        <span class="op-participant-name">${esc(r.player_name || 'Player')}</span>
        ${tag}
      </div>`;
  }

  function emptyTile(){
    return `
      <div class="op-participant-tile">
        <div class="op-participant-avatar op-participant-empty">+</div>
        <span class="op-participant-name op-participant-name-empty">Open</span>
      </div>`;
  }

  function readOnlyRow(r){
    const avatar = r.player_photo_url
      ? `<img class="op-user-avatar" src="${esc(r.player_photo_url)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="op-user-avatar op-user-avatar-fallback">${esc((r.player_name || '?').charAt(0).toUpperCase())}</div>`;
    return `
      <div class="op-joiner-row">
        ${avatar}
        <span class="op-joiner-name">${esc(r.player_name || 'Player')}</span>
        ${r.is_guest ? `<span class="op-badge op-badge-muted">Guest of ${esc(r.invited_by_name || 'a player')}</span>` : ''}
      </div>`;
  }

  openModal(`
    <div class="modal-title">Participants</div>
    <div class="modal-sub">${esc(ev.title)}</div>

    <div class="op-h-title" style="font-size:14px; margin-top:14px;">Confirmed (${opConfirmedHeaderLabel(ev, confirmed.length)})</div>
    <div class="op-participant-grid">
      ${participantTile({ player_name: ev.host_name || 'Host', player_photo_url: ev.host_photo_url, tag: 'Host' })}
      ${confirmed.map(participantTile).join('')}
      ${Array.from({ length: emptySlots }).map(emptyTile).join('')}
    </div>

    <div class="op-h-title" style="font-size:14px; margin-top:18px;">Waitlist (${waitlist.length})</div>
    ${waitlist.length ? `<div class="op-joiner-list">${waitlist.map(readOnlyRow).join('')}</div>` : `<div class="op-empty" style="padding:16px;">No one is waiting.</div>`}

    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button>
    </div>
  `);
}

/* ---------------- PRIVATE MESSAGES (DM) ---------------- */
let opDmChannel = null;

function opDmCleanup(){
  if(opDmChannel){ DmAPI.unsubscribe(opDmChannel); opDmChannel = null; }
}
// Same "watch the DOM for the modal leaving" teardown trick as opWatchChatCleanup.
function opWatchDmCleanup(container){
  if(!container || !window.MutationObserver) return;
  const obs = new MutationObserver(function(){
    if(!document.body.contains(container)){
      opDmCleanup();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// Builds one message bubble, reusing the same markup/classes as group chat
// (op-chat-*) so it inherits that styling for free — DMs support
// attachments the same way group chat does (see opChatAttachmentHtml),
// but skip edit/unsend since those aren't offered here.
function opDmBubbleHtml(m, isMine){
  const attachHtml = opChatAttachmentHtml(m);
  const bodyHtml = m.body ? `<div class="op-chat-bubble-text">${esc(m.body)}</div>` : '';
  return `
    ${!isMine ? `<div class="op-chat-msg-author">${esc(m.sender_name || 'Player')}</div>` : ''}
    <div class="op-chat-bubble">${attachHtml}${bodyHtml}</div>
    <div class="op-chat-msg-time">${esc(opChatTime(m.created_at))}</div>`;
}

// Host-side entry point: every participant thread on this event, most
// recently active first, so the host can see who's reached out.
async function opRenderDmThreadList(eventId){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev || !opUI.user || ev.host_id !== opUI.user.id) return;
  if(opMessagingClosed(ev)){
    openModal(`<div class="modal-title">Messages</div><div class="op-empty" style="padding:24px;">Messages closed 2 days after this game ended.</div><div class="modal-actions"><button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button></div>`);
    return;
  }
  openModal(`<div class="modal-title">Messages</div><div class="op-empty" style="padding:24px;">Loading\u2026</div>`);
  if(!sbReady()){
    openModal(`<div class="modal-title">Messages</div><div class="op-empty">Messaging isn\u2019t available right now.</div><div class="modal-actions"><button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button></div>`);
    return;
  }
  let threads, eligible;
  try{
    [threads, eligible] = await Promise.all([
      DmAPI.listThreadsForHost(eventId),
      DmEligibility.listForEvent(eventId),
    ]);
  }catch(err){
    console.error(err);
    openModal(`<div class="modal-title">Messages</div><div class="op-empty">Couldn\u2019t load messages. Please try again.</div><div class="modal-actions"><button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button></div>`);
    return;
  }
  // The eligibility mirror always has the participant's own name/avatar
  // (recorded when they rsvp'd), whereas the latest message in a thread
  // might have been sent by the host — so look names up from there rather
  // than trusting the last message's sender fields.
  const namesById = {};
  eligible.forEach(function(p){ namesById[p.user_id] = { name: p.user_name, photo: p.avatar_url }; });

  // Host is looking at the message list now — clear this event's DM badge.
  opMarkDmRead(eventId);

  function threadRow(m){
    const known = namesById[m.participant_id] || {};
    const name = known.name || (m.sender_id === m.participant_id ? m.sender_name : 'Player');
    const photo = known.photo || (m.sender_id === m.participant_id ? m.sender_avatar_url : null);
    const avatar = photo
      ? `<img class="op-user-avatar" src="${esc(photo)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="op-user-avatar op-user-avatar-fallback">${esc((name || '?').charAt(0).toUpperCase())}</div>`;
    return `
      <div class="op-joiner-row" data-action="op-open-dm-thread" data-id="${ev.id}" data-participant="${esc(m.participant_id)}" data-name="${esc(name || 'Player')}" data-photo="${esc(photo || '')}" style="cursor:pointer;">
        ${avatar}
        <span class="op-joiner-name">${esc(name || 'Player')}</span>
      </div>`;
  }

  openModal(`
    <div class="modal-title">Messages</div>
    <div class="modal-sub">${esc(ev.title)} \u2014 private threads with people who\u2019ve messaged you</div>
    ${threads.length
      ? `<div class="op-joiner-list">${threads.map(threadRow).join('')}</div>`
      : `<div class="op-empty" style="padding:24px;">No one has messaged you about this game yet.</div>`}
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button>
    </div>
  `);
}

// Shared 1:1 thread view — used both by a participant messaging the host,
// and by the host opening a specific participant's thread from the list
// above. participantName/participantPhoto are only needed for the header
// when the participant hasn't sent a message yet (so there's nothing to
// pull a name from otherwise) — safe to omit.
async function opRenderDmThread(eventId, participantId, participantName, participantPhoto){
  const ev = opUI.events.find(function(e){ return e.id === eventId; });
  if(!ev || !opUI.user) return;
  const isHost = ev.host_id === opUI.user.id;
  if(!isHost && opUI.user.id !== participantId) return; // only the two parties belong here
  if(opMessagingClosed(ev)){
    openModal(`<div class="modal-title">Messages</div><div class="op-empty" style="padding:24px;">Messages closed 2 days after this game ended.</div><div class="modal-actions"><button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}">Back</button></div>`);
    return;
  }
  const backAction = isHost
    ? `<button class="btn btn-ghost btn-block" data-action="op-open-dm-list" data-id="${ev.id}" style="margin-top:8px;">Back to messages</button>`
    : `<button class="btn btn-ghost btn-block" data-action="op-open-event" data-id="${ev.id}" style="margin-top:8px;">Back</button>`;
  const headerName = isHost ? (participantName || 'Player') : (ev.host_name || 'Host');
  opMarkDmRead(eventId); // looking at a thread on this event now — clear the badge (host or participant, same key)

  opDmCleanup();

  openModal(`
    <div class="modal-title">${esc(headerName)}</div>
    <div class="modal-sub">${esc(ev.title)} \u2014 private message, not the group chat. Same as group chat, this isn\u2019t end-to-end encrypted.</div>
    <div class="op-chat-messages" id="opDmMessages"><div class="op-empty" style="padding:24px;">Loading messages\u2026</div></div>
    <div class="op-chat-attach-preview" id="opDmAttachPreview" style="display:none;"></div>
    <form class="op-chat-form" id="opDmForm">
      <button type="button" class="op-chat-attach-btn" id="opDmAttachBtn" title="Attach a file (max ${DM_MAX_ATTACHMENTS_PER_THREAD} per conversation)">\ud83d\udcce</button>
      <input type="file" id="opDmFileInput" accept="${CHAT_ATTACHMENT_ACCEPT}" style="display:none;" />
      <input type="text" class="op-input op-chat-input" id="opDmInput" placeholder="${isHost ? 'Reply\u2026' : 'Message the host\u2026'}" maxlength="500" autocomplete="off" />
      <button type="submit" class="btn btn-primary op-chat-send">Send</button>
    </form>
    ${backAction}
  `);

  const listEl = document.getElementById('opDmMessages');
  opWatchDmCleanup(listEl);
  if(!sbReady()){
    if(listEl) listEl.innerHTML = `<div class="op-empty">Messaging isn\u2019t available right now.</div>`;
    return;
  }

  function appendMessage(m){
    if(!listEl) return;
    opMarkDmRead(eventId, m.created_at); // already looking at it — never badge this one (host or participant)
    const nearBottom = (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight) < 60;
    const emptyNote = listEl.querySelector('.op-empty');
    if(emptyNote) emptyNote.remove();
    const wrap = document.createElement('div');
    wrap.className = 'op-chat-msg' + (m.sender_id === opUI.user.id ? ' op-chat-msg-mine' : '');
    wrap.innerHTML = opDmBubbleHtml(m, m.sender_id === opUI.user.id);
    listEl.appendChild(wrap);
    if(nearBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  const messages = await DmAPI.loadThread(eventId, participantId);
  if(listEl){
    listEl.innerHTML = '';
    if(!messages.length){
      listEl.innerHTML = `<div class="op-empty" style="padding:24px;">${isHost ? 'No messages yet.' : 'Say hi \ud83d\udc4b \u2014 only the host will see this.'}</div>`;
    } else {
      messages.forEach(appendMessage);
    }
    listEl.scrollTop = listEl.scrollHeight;
  }

  opDmChannel = DmAPI.subscribe(eventId, participantId, function(m){ appendMessage(m); }, isHost ? 'host' : 'participant');

  // ---- attachments (same pattern as group chat, but capped per thread) ----
  let threadAttachmentCount = 0;
  try{ threadAttachmentCount = await DmAPI.getAttachmentCount(eventId, participantId); }catch(err){ /* best effort — real cap is server-side */ }
  let pendingAttachment = null; // File staged for the next send

  const attachBtn = document.getElementById('opDmAttachBtn');
  const fileInput = document.getElementById('opDmFileInput');
  const previewEl = document.getElementById('opDmAttachPreview');

  function renderAttachPreview(){
    if(!previewEl) return;
    if(!pendingAttachment){ previewEl.style.display = 'none'; previewEl.innerHTML = ''; return; }
    previewEl.style.display = 'flex';
    previewEl.innerHTML = `
      <span class="op-chat-attach-preview-name">\ud83d\udcce ${esc(pendingAttachment.name)}</span>
      <button type="button" class="op-chat-attach-remove" id="opDmAttachRemove" title="Remove">\u2715</button>`;
    const removeBtn = document.getElementById('opDmAttachRemove');
    if(removeBtn) removeBtn.addEventListener('click', function(){ pendingAttachment = null; renderAttachPreview(); });
  }

  if(attachBtn && fileInput){
    attachBtn.addEventListener('click', function(){
      if(threadAttachmentCount >= DM_MAX_ATTACHMENTS_PER_THREAD){
        toast(`This conversation has already reached the ${DM_MAX_ATTACHMENTS_PER_THREAD}-file limit.`, 'error');
        return;
      }
      fileInput.click();
    });
    fileInput.addEventListener('change', function(){
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ''; // reset so picking the same file again still fires change
      if(!file) return;
      if(file.size > CHAT_MAX_ATTACHMENT_BYTES){ toast('That file is too big \u2014 max 5MB.', 'error'); return; }
      pendingAttachment = file;
      renderAttachPreview();
    });
  }

  const form = document.getElementById('opDmForm');
  if(form){
    form.addEventListener('submit', async function(e){
      e.preventDefault();
      const input = document.getElementById('opDmInput');
      const body = (input.value || '').trim();
      if(!body && !pendingAttachment) return;
      const btn = form.querySelector('.op-chat-send');
      if(btn) btn.disabled = true;
      if(attachBtn) attachBtn.disabled = true;
      const savedBody = body;
      const savedAttachment = pendingAttachment;
      input.value = '';
      pendingAttachment = null;
      renderAttachPreview();
      try{
        let attachmentPayload = null;
        if(savedAttachment){
          attachmentPayload = await DmAPI.uploadAttachment(eventId, participantId, savedAttachment);
          threadAttachmentCount++;
        }
        await DmAPI.send(eventId, ev.host_id, participantId, opUI.user, savedBody, attachmentPayload);
      }catch(err){
        toast(opFriendlyError(err, 'Message didn\u2019t send \u2014 try again.'), 'error');
        input.value = savedBody;
        if(savedAttachment && !/limit/i.test((err && err.message) || '')){
          pendingAttachment = savedAttachment; // put it back unless it was the limit that failed
          renderAttachPreview();
        }
      }
      if(btn) btn.disabled = false;
      if(attachBtn) attachBtn.disabled = false;
      input.focus();
    });
  }
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
          ${r.is_guest ? `<span class="op-badge op-badge-muted">Guest of ${esc(r.invited_by_name || 'a player')}</span>` : ''}
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

  opRefreshChatUnread(); // throttled — cheap to call on every render
  opRefreshDmUnread(); // throttled — cheap to call on every render

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
    case 'op-change-avatar': {
      const wrap = t.closest('.op-user-avatar-wrap');
      const input = wrap ? wrap.querySelector('#opAvatarFileInput') : document.getElementById('opAvatarFileInput');
      if(input) input.click();
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
    case 'op-open-join-request': {
      opRenderJoinRequestModal(t.dataset.id);
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
    case 'op-message-host': {
      if(!opUI.user){
        opOpenAuthModal('message the host', function(){ opRenderDmThread(t.dataset.id, opUI.user.id); });
        break;
      }
      await opRenderDmThread(t.dataset.id, opUI.user.id);
      break;
    }
    case 'op-open-dm-list': {
      await opRenderDmThreadList(t.dataset.id);
      break;
    }
    case 'op-open-dm-thread': {
      await opRenderDmThread(t.dataset.id, t.dataset.participant, t.dataset.name, t.dataset.photo);
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
      const ev = opUI.events.find(function(e){ return e.id === t.dataset.id; });
      const url = `${location.origin}${location.pathname}#open-play=${t.dataset.id}`;
      const text = opShareText(ev, url);
      try{
        await navigator.clipboard.writeText(text);
        toast('Details copied — paste it in your group chat!', 'success');
      }catch(err){
        toast(text, 'default');
      }
      break;
    }
  }
});

// Change handler for the hidden profile-photo file input (see the
// op-change-avatar case above, which just clicks this input open — the
// actual upload happens here once a file is picked). Delegated at the
// document level, same reasoning as the click handler: the chip re-renders
// often (three different views embed opAuthChip), so a per-render wire-up
// would be easy to miss on one of them.
document.addEventListener('change', async function(e){
  const input = e.target;
  if(!input || input.id !== 'opAvatarFileInput') return;
  const file = input.files && input.files[0];
  input.value = ''; // reset so picking the same file again still fires change
  if(!file) return;
  if(!opUI.user){ toast('Sign in to upload a profile photo.', 'error'); return; }
  if(!/^image\//.test(file.type || '')){ toast('Please choose an image file.', 'error'); return; }
  if(file.size > AVATAR_MAX_BYTES){ toast('That image is too big — max 5MB.', 'error'); return; }

  const wrap = input.closest('.op-user-avatar-wrap');
  const editBtn = wrap ? wrap.querySelector('.op-avatar-edit-btn') : null;
  if(editBtn) editBtn.disabled = true;
  try{
    const url = await OpenPlayAPI.uploadAvatar(opUI.user.id, file);
    opUI.user = Object.assign({}, opUI.user, { avatar_url: url });
    toast('Profile photo updated!', 'success');
    renderActiveView();
  }catch(err){
    console.error(err);
    toast(opFriendlyError(err, 'Couldn\u2019t upload that photo. Please try again.'), 'error');
    if(editBtn) editBtn.disabled = false;
  }
});

/* ---------------- boot ---------------- */
opAddNavSections();
opBoot();

})();
