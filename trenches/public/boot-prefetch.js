// Starts the boot requests before the app exists.
//
// The Trenches document is a 1.3KB shell. Nothing can ask the API for a feed until roughly 104KB
// of module JavaScript has downloaded, parsed and begun evaluating - only then does bootPrefetch
// run. This file is a plain classic script: the browser runs it the moment it arrives, which is
// one round trip and a bundle-evaluation earlier, and it fires exactly the same requests.
//
// It is a separate file rather than an inline block because the site's Content-Security-Policy
// has no 'unsafe-inline' in script-src, so an inline block would simply be refused.
//
// The responses are handed to src/api/client.ts, which consumes them in place of its own fetch.
// If anything here misses - a URL that does not match, storage blocked, the script arriving late -
// nothing breaks: client.ts finds no warmed response and fetches normally.
(function () {
  var el = document.currentScript;
  var api = el && el.getAttribute("data-api");
  if (!api) return;

  // Keyed by the same path string client.ts builds, so it can look its own request up.
  var store = Object.create(null);
  window.__trenchesWarm = { at: Date.now(), store: store };

  function warm(path) {
    try {
      var opts = { credentials: "include" };
      // Bounded like the app's own requests, where the browser can: a connection that dies
      // without closing must not leave the handed-over promise pending forever. client.ts guards
      // its side of the handoff too (see boundWarmed there); aborting here also frees the socket.
      try {
        if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
          opts.signal = AbortSignal.timeout(20000);
        }
      } catch (err) {
        // Older engine - the client-side bound still applies.
      }
      var p = fetch(api + path, opts);
      // Nothing awaits these yet. Without a catch here a network failure becomes an unhandled
      // rejection in the console before the app has had a chance to pick it up.
      p.catch(function () {});
      store[path] = p;
    } catch (err) {
      // fetch itself throwing (blocked, bad URL) is not worth failing the page over.
    }
  }

  function stored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  // Always asked: its answer is what decides between the feed and the sign-in screen.
  warm("/auth/me");

  // The other three are gated exactly as bootPrefetch gates them. Without this a signed-out
  // visitor - every first-time reader, and every crawler - would fire three guaranteed 401s.
  if (stored("trenches.hasSession") !== "1") return;

  var curated = false;
  try {
    var raw = stored("trenches.preferences");
    curated = !!(raw && JSON.parse(raw).includeCuratedInFeed === true);
  } catch (err) {
    // Corrupt or blocked storage: the default is the safe answer, same as bootPrefetch.
  }

  warm("/subscription");
  warm("/filters");
  warm("/matches?page=1" + (curated ? "&includeCurated=true" : ""));
})();
