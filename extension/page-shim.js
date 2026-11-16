// Runs in the page's own JavaScript world (manifest "world": "MAIN"), because
// content.js cannot change what the page's scripts see.
//
// Facebook's message box ignores typed text unless the page believes it is
// focused and visible, and Chrome reports the opposite whenever you work in
// another app (the terminal) or the window is hidden. While a send is in
// progress, content.js asks this script to make the page see a focused,
// visible document, and to run requestAnimationFrame callbacks from a timer
// (Chrome never calls them for a hidden page). Outside a send everything is
// the real thing. It touches nothing else: no network, cookies or storage.
//
// The data-tm-shim attribute on <html> says whether this script is loaded
// ("loaded"), active ("on") or inactive ("off"); content.js reads it for the
// diagnostics in a failed send, since it cannot see this world's objects.
(function () {
  "use strict";
  if (globalThis.__tmShim) return;
  globalThis.__tmShim = true;

  const root = document.documentElement;
  const setState = (v) => root.setAttribute("data-tm-shim", v);

  const proto = Document.prototype;
  const realHidden = Object.getOwnPropertyDescriptor(proto, "hidden").get;
  const realState = Object.getOwnPropertyDescriptor(proto, "visibilityState").get;
  const realHasFocus = document.hasFocus.bind(document);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancelRaf = window.cancelAnimationFrame.bind(window);
  let forced = false;

  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => (forced ? false : realHidden.call(document)),
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (forced ? "visible" : realState.call(document)),
  });
  document.hasFocus = () => forced || realHasFocus();

  // While forced and the page is really hidden, run animation-frame callbacks
  // from a timer. Ids from the timer path are kept apart from the real ones.
  let nextId = 1e9;
  const timers = new Map();
  window.requestAnimationFrame = (cb) => {
    if (!forced || realHidden.call(document) === false) return realRaf(cb);
    const id = nextId++;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        cb(performance.now());
      }, 16),
    );
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    if (timers.has(id)) {
      clearTimeout(timers.get(id));
      timers.delete(id);
    } else {
      realCancelRaf(id);
    }
  };

  document.addEventListener("tm-shim-on", () => {
    forced = true;
    setState("on");
  });
  document.addEventListener("tm-shim-off", () => {
    forced = false;
    setState("off");
  });
  setState("loaded");
})();
