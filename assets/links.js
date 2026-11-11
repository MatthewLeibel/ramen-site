// Links that change in one place, for every page that loads this file.
//
// ADD_TO_CHROME: the RAMen add-on's page in the Chrome Web Store. The add-on is not listed yet, so this is null and
// every Chrome button (a link with data-add-to-chrome) keeps its own address, chrome.html#get, where the page says it
// is waiting for the Chrome Web Store and offers an email when it is there. Until then the buttons say so in their
// own words ("Coming to Chrome"), never "Add to Chrome". Once the listing is live, put its address here, for example
// "https://chromewebstore.google.com/detail/ramen/ID". Then on every page:
//   a[data-add-to-chrome]   goes straight to the store, and takes the words in its data-live-text ("Add to Chrome")
//   [data-store-soon]       the "waiting for the store" notes and the email form hide themselves
//   [data-store-live]       what only makes sense once it is in the store (hidden until then) shows itself
var ADD_TO_CHROME = null;

// FREE_CHECKOUT and LIFETIME_CHECKOUT: the Polar checkout links of RAMen Free ($0) and RAMen Lifetime ($79, with the
// FOUNDER discount: $49 for the first 500). Until each is set, its plan card and anything marked for it stay hidden
// ([data-free-live], [data-lifetime-live]) and its stand-in shows ([data-free-soon]); once set, a[data-free-checkout]
// and a[data-lifetime-checkout] go there and the stand-ins hide.
var FREE_CHECKOUT = "https://buy.polar.sh/polar_cl_9WtKPgfsBxdyODMrkx1xznSBPyWk3K04zS5o23JaDou";
var LIFETIME_CHECKOUT = "https://buy.polar.sh/polar_cl_Tr6ojzoANKCKNl3t1Z7qBbv7w1qErG1IGDLOV0gkWAG";

(function () {
  [[FREE_CHECKOUT, 'free'], [LIFETIME_CHECKOUT, 'lifetime']].forEach(function (p) {
    if (!p[0]) return;
    document.querySelectorAll('a[data-' + p[1] + '-checkout]').forEach(function (a) { a.href = p[0]; });
    document.querySelectorAll('[data-' + p[1] + '-live]').forEach(function (el) { el.hidden = false; });
    document.querySelectorAll('[data-' + p[1] + '-soon]').forEach(function (el) { el.hidden = true; });
  });
})();

(function () {
  if (!ADD_TO_CHROME) return;
  document.querySelectorAll('a[data-add-to-chrome]').forEach(function (a) {
    a.href = ADD_TO_CHROME;
    a.rel = 'noopener';
    if (a.hasAttribute('data-live-text')) a.textContent = a.getAttribute('data-live-text');
  });
  document.querySelectorAll('[data-store-soon]').forEach(function (el) { el.hidden = true; });
  document.querySelectorAll('[data-store-live]').forEach(function (el) { el.hidden = false; });
})();
