// nav.js — mobile hamburger + scroll reveal
(function () {
  // ── Hamburger ────────────────────────────────────────────────────────────
  var nav = document.querySelector('nav');
  if (nav) {
    var links = nav.querySelector('.nav-links');
    var btn = document.createElement('button');
    btn.className = 'nav-toggle';
    btn.setAttribute('aria-label', 'Toggle menu');
    btn.innerHTML = '<span></span><span></span><span></span>';
    nav.appendChild(btn);

    btn.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      btn.classList.toggle('open', open);
    });

    links.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        links.classList.remove('open');
        btn.classList.remove('open');
      });
    });

    // Close on outside tap
    document.addEventListener('click', function (e) {
      if (!nav.contains(e.target)) {
        links.classList.remove('open');
        btn.classList.remove('open');
      }
    });
  }

  // ── Scroll reveal ─────────────────────────────────────────────────────────
  var revealEls = document.querySelectorAll('.img-full, .img-grid-2, .gallery');
  if (!revealEls.length) return;

  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('revealed');
          obs.unobserve(e.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(function (el) { obs.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add('revealed'); });
  }
})();
