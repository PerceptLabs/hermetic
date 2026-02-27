// @hermetic/net — Cookie shim (runs INSIDE the sandbox iframe)
//
// Provides a virtual document.cookie jar since sandbox iframe has no real cookies

export const COOKIE_SHIM_SOURCE = `
(function() {
  var _cookieJar = {};

  try {
    Object.defineProperty(document, "cookie", {
      get: function() {
        return Object.entries(_cookieJar)
          .map(function(entry) { return entry[0] + "=" + entry[1]; })
          .join("; ");
      },
      set: function(value) {
        var parts = value.split(";")[0].split("=");
        if (parts.length >= 2) {
          var key = parts[0].trim();
          var val = parts.slice(1).join("=").trim();
          if (val === "" && value.indexOf("max-age=0") !== -1) {
            delete _cookieJar[key];
          } else {
            _cookieJar[key] = val;
          }
        }
      },
      configurable: true
    });
  } catch(e) {
    // May fail in some sandbox configurations
  }
})();
`;
