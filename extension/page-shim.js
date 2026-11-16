// Runs in the page's own JavaScript world (manifest "world": "MAIN"), because
// content.js cannot change what the page's scripts see.
//
// Facebook's message box ignores typed text while the document does not have
// focus, and it doesn't have focus whenever you are working in another app
// (the terminal). While a send is in progress, content.js asks this script to
// make document.hasFocus() report true. Outside a send it is the real thing.
// It touches nothing else: no network, cookies or storage.
(function () {
  "use strict";
  if (globalThis.__tmFocusShim) return;
  globalThis.__tmFocusShim = true;

  const realHasFocus = document.hasFocus.bind(document);
  let forced = false;
  document.hasFocus = () => forced || realHasFocus();
  document.addEventListener("tm-focus-shim-on", () => {
    forced = true;
  });
  document.addEventListener("tm-focus-shim-off", () => {
    forced = false;
  });
})();
