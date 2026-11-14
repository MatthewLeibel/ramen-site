// Keyboard reach on every page (accessibility re-check, 14 Nov 2026): a code box that scrolls sideways can be reached
// with Tab and scrolled with the arrow keys. It gets tabindex=0 only while its text is wider than the box (on a phone,
// a long command), so short boxes add no extra Tab stops; checked again when the window changes size.
(function () {
  function reach() {
    var boxes = document.querySelectorAll('pre, code.cmd');
    for (var i = 0; i < boxes.length; i++) {
      var el = boxes[i];
      if (el.tagName === 'CODE' && el.parentElement && el.parentElement.closest('pre')) continue;   // its pre carries it
      var wide = el.scrollWidth > el.clientWidth + 1;
      if (wide && !el.hasAttribute('tabindex')) { el.setAttribute('tabindex', '0'); el.setAttribute('data-reach', ''); }
      else if (!wide && el.hasAttribute('data-reach')) { el.removeAttribute('tabindex'); el.removeAttribute('data-reach'); }
    }
  }
  var t;
  window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(reach, 200); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reach); else reach();
  window.addEventListener('load', reach);          // web fonts can change a box's width
})();
