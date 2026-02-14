(() => {
  "use strict";

  if (window.__zetaFrontendV4) {
    return;
  }
  if (!location.hostname.endsWith("overleaf.com")) {
    return;
  }

  const zeta = window.__zetaContent;
  if (!zeta?.ZetaApp) {
    console.error("zeta bootstrap failed: ZetaApp module missing.");
    return;
  }

  window.__zetaFrontendV4 = true;
  const app = new zeta.ZetaApp();
  app.init();

  window.__zetaDestroy = () => {
    app.destroy();
    delete window.__zetaFrontendV4;
  };
})();
