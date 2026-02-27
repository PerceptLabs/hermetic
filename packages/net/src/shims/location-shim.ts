// @hermetic/net — Location shim (runs INSIDE the sandbox iframe)
//
// Provides a virtual window.location and history.pushState

export const LOCATION_SHIM_SOURCE = `
(function() {
  var _virtualLocation = {
    href: "http://localhost/",
    protocol: "http:",
    host: "localhost",
    hostname: "localhost",
    port: "",
    pathname: "/",
    search: "",
    hash: "",
    origin: "http://localhost"
  };

  // Override history.pushState and replaceState
  var _origPushState = history.pushState;
  var _origReplaceState = history.replaceState;

  history.pushState = function(state, title, url) {
    if (url) {
      try {
        var parsed = new URL(url, _virtualLocation.href);
        _virtualLocation.href = parsed.href;
        _virtualLocation.pathname = parsed.pathname;
        _virtualLocation.search = parsed.search;
        _virtualLocation.hash = parsed.hash;
      } catch(e) {}
    }
  };

  history.replaceState = function(state, title, url) {
    if (url) {
      try {
        var parsed = new URL(url, _virtualLocation.href);
        _virtualLocation.href = parsed.href;
        _virtualLocation.pathname = parsed.pathname;
        _virtualLocation.search = parsed.search;
        _virtualLocation.hash = parsed.hash;
      } catch(e) {}
    }
  };
})();
`;
