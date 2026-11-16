// Runs in the page's own JavaScript world (manifest "world": "MAIN"), because
// content.js cannot change what the page's scripts see.
//
// Facebook's message box ignores typed text while the document does not have
// focus, and it never has focus while you work in another app (the terminal).
// While a send is in progress, content.js asks this script to make
// document.hasFocus() report true. Outside a send it is the real thing. It
// changes nothing else: no visibility, timers, network, cookies or storage.
//
// The data-tm-shim attribute on <html> says whether this script is loaded
// ("loaded"), active ("on") or inactive ("off"); content.js reads it for the
// diagnostics in a failed send, since it cannot see this world's objects.
(function () {
  "use strict";
  if (globalThis.__tmShim) return;
  globalThis.__tmShim = true;

  const root = document.documentElement;
  const realHasFocus = document.hasFocus.bind(document);
  let forced = false;

  document.hasFocus = () => forced || realHasFocus();
  document.addEventListener("tm-shim-on", () => {
    forced = true;
    root.setAttribute("data-tm-shim", "on");
  });
  document.addEventListener("tm-shim-off", () => {
    forced = false;
    root.setAttribute("data-tm-shim", "off");
  });
  root.setAttribute("data-tm-shim", "loaded");
})();
