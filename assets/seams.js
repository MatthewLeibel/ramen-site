// Seams: each scene (and each page's top banner) melts into the section after it. The foot of its art goes soft and fades into the next section's
// own colour (read here from the page, so it is right on every page and stays right when a colour changes). Without
// scripts the sections simply meet as they always did.
(function () {
  function colourAfter(s) {
    var next = s.nextElementSibling;
    while (next && (next.tagName === 'SCRIPT' || next.hidden)) next = next.nextElementSibling;
    if (!next && s.parentElement && s.parentElement.tagName === 'MAIN') next = s.parentElement.nextElementSibling;
    if (!next) return null;
    var c = getComputedStyle(next).backgroundColor;
    return c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)' ? c : null;
  }
  function seams() {
    document.querySelectorAll('.scene, .page-hero, .s-hero').forEach(function (s) {
      if (s.querySelector(':scope > .seam, :scope > .band')) return;   // a cloud band already covers its seam
      var c = colourAfter(s);
      if (!c) return;
      s.style.setProperty('--next', c);
      var d = document.createElement('div');
      d.className = 'seam';
      d.setAttribute('aria-hidden', 'true');
      s.appendChild(d);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', seams); else seams();
})();
