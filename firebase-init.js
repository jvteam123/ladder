/* ================================================================
   FIREBASE INIT — Discover / Host live backend
   ------------------------------------------------------------------
   Loaded (as a plain classic script) BEFORE openplay.js, right after
   the Firebase compat SDK <script> tags in index.html. Exposes a few
   ready-to-use globals that openplay.js consumes:

     window.fbAuth           — firebase.auth() instance
     window.fbDb              — firebase.firestore() instance
     window.fbGoogleProvider  — a GoogleAuthProvider instance

   Nothing in here is Ladder/Open-Play specific — this file only
   wires up the Firebase project itself.
   ================================================================ */

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyD9s0DRoMqfzKJYWTB2EKkBabgoDbKqnt4",
  authDomain: "mladder-36f28.firebaseapp.com",
  projectId: "mladder-36f28",
  storageBucket: "mladder-36f28.firebasestorage.app",
  messagingSenderId: "588983233975",
  appId: "1:588983233975:web:674ba9c6781bdc7428cc32"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Keep users signed in across visits/tabs (falls back gracefully if the
// browser blocks persistent storage, e.g. private browsing).
firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

window.fbAuth = firebase.auth();
window.fbDb = firebase.firestore();
window.fbGoogleProvider = new firebase.auth.GoogleAuthProvider();

// Turn on Firestore's offline cache. This makes writes (like the Ladder
// cloud backup in script.js) durable the moment they're queued client-side
// — even if the app is killed or the phone dies a split second later —
// because Firestore stores pending writes in its own local IndexedDB and
// auto-flushes them to the server the next time the app opens with a
// network connection. `synchronizeTabs` keeps multiple open tabs in sync
// off the same cache. Safe to ignore failures (e.g. multiple tabs on a
// browser without multi-tab support, or private browsing) — the app just
// falls back to network-only Firestore, and the local IndexedDB save (in
// script.js) still covers offline use either way.
if(window.fbDb.enablePersistence){
  window.fbDb.enablePersistence({ synchronizeTabs: true }).catch(() => {});
}
