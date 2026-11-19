// Runs in the page itself (not the extension's isolated world), before the player loads.
// When a player puts the bare <video> element in full screen, the browser shows only that
// element, so nothing can be drawn over it (Enhanced22's panel and scorebug included). This
// sends the request to the video's container instead and makes the video fill it, which
// looks the same but leaves room for the overlay.
(() => {
  if (window.__e22fs) return;
  window.__e22fs = true;
  const style = document.createElement('style');
  style.textContent = `
    .e22-fs { background: #000 !important; display: flex !important; align-items: center !important; justify-content: center !important; }
    .e22-fs > video.e22-fsv { width: 100% !important; height: 100% !important; max-width: none !important; max-height: none !important;
      object-fit: contain !important; position: static !important; transform: none !important; }`;
  const addStyle = () => (document.head || document.documentElement).appendChild(style);
  if (document.documentElement) addStyle(); else document.addEventListener('DOMContentLoaded', addStyle);

  const wrap = (name) => {
    const orig = Element.prototype[name] || HTMLVideoElement.prototype[name];
    if (!orig) return;
    const fn = function (...args) {
      if (this instanceof HTMLVideoElement && this.parentElement) {
        const box = this.parentElement;
        box.classList.add('e22-fs');
        this.classList.add('e22-fsv');
        return orig.apply(box, args);
      }
      return orig.apply(this, args);
    };
    if (Element.prototype[name]) Element.prototype[name] = fn; else HTMLVideoElement.prototype[name] = fn;
  };
  wrap('requestFullscreen');
  wrap('webkitRequestFullscreen');
  wrap('webkitRequestFullScreen');
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) return;
    for (const n of document.querySelectorAll('.e22-fs')) n.classList.remove('e22-fs');
    for (const n of document.querySelectorAll('.e22-fsv')) n.classList.remove('e22-fsv');
  }, true);
})();
