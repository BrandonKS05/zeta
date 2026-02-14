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
  window.__zetaApp = app;
  window.__zetaDebug = {
    getChunkTree: () => app.chunkTree,
    getLeafChunks: () => (app.chunkTree ? app.chunkTree.leafChunks : []),
    getActiveChunkId: () => app.activeChunkId,
    getActiveChunk: () => {
      if (!app.chunkTree || !app.activeChunkId) {
        return null;
      }
      return app.chunkTree.chunkById.get(app.activeChunkId) || null;
    },
  };

  window.__zetaDestroy = () => {
    app.destroy();
    delete window.__zetaDebug;
    delete window.__zetaApp;
    delete window.__zetaFrontendV4;
  };
})();
