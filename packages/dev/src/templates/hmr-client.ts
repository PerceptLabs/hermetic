// @hermetic/dev — HMR client code injected into preview iframe
//
// Listens for update messages from host and applies module hot-swaps.

export const HMR_CLIENT_SOURCE = `
(function() {
  window.__hermetic_hmr = {
    modules: new Map(),
    callbacks: new Map(),
  };

  // Accept HMR updates for a module
  window.__hermetic_hmr.accept = function(moduleId, callback) {
    window.__hermetic_hmr.callbacks.set(moduleId, callback);
  };

  // Listen for HMR update messages
  window.addEventListener("message", function(event) {
    if (event.data && event.data.type === "hermetic-hmr-update") {
      var moduleId = event.data.moduleId;
      var code = event.data.code;

      // Store the new module code
      window.__hermetic_hmr.modules.set(moduleId, code);

      // Call the accept callback if registered
      var callback = window.__hermetic_hmr.callbacks.get(moduleId);
      if (callback) {
        try {
          callback(code);
        } catch (err) {
          console.error("[HMR] Failed to apply update for " + moduleId, err);
          // Full reload fallback
          window.location.reload();
        }
      } else {
        // No accept handler — full reload
        window.location.reload();
      }
    }

    // Full rebuild notification
    if (event.data && event.data.type === "hermetic-hmr-full-reload") {
      window.location.reload();
    }
  });
})();
`;
