// Client-side white-label. The server injects window.__BRAND (see src/tenant.js) and the theme CSS
// variables; this file replaces the visible JohorStudio.com text, the logo, the contact links and the
// footer credit with the tenant's brand. It does nothing on live.johorstudio.com unless a master brand
// was saved in the admin UI.
(function () {
  'use strict';
  var B = window.__BRAND;
  if (!B) return;
  var branded = B.kind === 'tenant' || !B.isPlatform;
  if (!branded) return;

  var NAME = B.name || '';
  var PLATFORM = 'JohorStudio.com';
  var PLATFORM_RE = /JohorStudio\.com/gi;
  var PLATFORM_BARE_RE = /JohorStudio/gi;
  var PLATFORM_LINK = /(^|\.)johorstudio\.com$/i;

  function isPlatformHost(href) {
    try { return PLATFORM_LINK.test(new URL(href, location.href).hostname); } catch (e) { return false; }
  }
  function isPlatformLink(a) { return a && a.getAttribute('href') && isPlatformHost(a.getAttribute('href')); }
  function replaceText(s) {
    if (!s || !/johorstudio/i.test(s)) return s;
    return s.replace(PLATFORM_RE, NAME).replace(PLATFORM_BARE_RE, NAME);
  }

  // ---- title / meta / theme colour ----
  if (document.title && /johorstudio/i.test(document.title)) document.title = replaceText(document.title);
  document.querySelectorAll('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"]').forEach(function (m) {
    var c = m.getAttribute('content');
    if (c && /johorstudio/i.test(c)) m.setAttribute('content', replaceText(c));
  });
  if (B.colors && B.colors.graphite) {
    var theme = document.querySelector('meta[name="theme-color"]');
    if (theme) theme.setAttribute('content', B.colors.graphite);
  }
  var canonical = document.querySelector('link[rel="canonical"]');
  if (canonical && isPlatformHost(canonical.href)) canonical.href = location.origin + location.pathname;

  // ---- favicon ----
  var icon = B.favicon || B.logo;
  if (icon) {
    var link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = icon;
  }

  // ---- logo / brand name ----
  document.querySelectorAll('.brand-name').forEach(function (el) {
    if (B.logo) {
      var img = document.createElement('img');
      img.src = B.logo;
      img.alt = NAME;
      img.style.height = '26px';
      img.style.width = 'auto';
      img.style.display = 'block';
      el.textContent = '';
      el.appendChild(img);
      el.style.fontSize = '0';
    } else {
      el.textContent = NAME;
    }
  });
  document.querySelectorAll('.brand').forEach(function (a) {
    if (B.website) a.setAttribute('href', B.website);
    a.setAttribute('title', NAME);
    a.setAttribute('aria-label', NAME);
  });

  // ---- replace platform links: brand/contact links go to the tenant's own site ----
  document.querySelectorAll('a[href]').forEach(function (a) {
    if (!isPlatformLink(a)) return;
    if (a.hasAttribute('data-platform-credit')) return;           // the footer credit keeps johorstudio.com
    if (a.classList && a.classList.contains('live-home')) { a.hidden = true; return; } // "Live home" = platform
    if (B.website) a.setAttribute('href', B.website);
    else a.hidden = true;
  });
  if (B.whatsapp) {
    document.querySelectorAll('a[href^="https://wa.me/"], a[href^="https://api.whatsapp.com/"]').forEach(function (a) {
      a.setAttribute('href', 'https://wa.me/' + String(B.whatsapp).replace(/\D/g, ''));
    });
  }

  // ---- visible text: "JohorStudio.com" -> tenant name (skip scripts/styles/inputs) ----
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, IFRAME: 1, INPUT: 1, SELECT: 1, OPTION: 1 };
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      var p = node.parentNode;
      if (!p || SKIP[p.nodeName]) return NodeFilter.FILTER_REJECT;
      if (!/johorstudio/i.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      if (p.closest && p.closest('[data-platform-credit]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  var nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(function (n) { n.nodeValue = replaceText(n.nodeValue); });

  // ---- footer credit: "Servis disediakan oleh JohorStudio.com" ----
  var credit = B.disclaimer || 'Servis disediakan oleh JohorStudio.com';
  var creditHtml = 'Servis disediakan oleh <a href="https://johorstudio.com" target="_blank" rel="noopener" data-platform-credit>JohorStudio.com</a>';
  if (credit.indexOf('JohorStudio.com') === -1) creditHtml = credit;
  document.querySelectorAll('footer.site, .site-footer, #sitefooter').forEach(function (f) {
    f.innerHTML = '<span style="opacity:.85">' + creditHtml + '</span>';
  });
  // The gallery footer holds the WhatsApp link; keep it and append the credit.
  document.querySelectorAll('.gfoot').forEach(function (f) {
    if (f.querySelector('[data-platform-credit]')) return;
    var span = document.createElement('span');
    span.setAttribute('style', 'opacity:.85');
    span.innerHTML = ' \u00b7 ' + creditHtml;
    f.appendChild(span);
  });

  // ---- late DOM: the panel/admin pages render templates after load, so watch for new text ----
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType === 3) { if (/johorstudio/i.test(n.nodeValue) && !(n.parentNode && SKIP[n.parentNode.nodeName])) n.nodeValue = replaceText(n.nodeValue); }
        else if (n.nodeType === 1) { fixSubtree(n); }
      }
    }
  });
  function fixSubtree(root) {
    if (!root.querySelectorAll) return;
    root.querySelectorAll('.brand-name').forEach(function (el) { if (/johorstudio/i.test(el.textContent)) el.textContent = replaceText(el.textContent); });
    root.querySelectorAll('a[href]').forEach(function (a) {
      if (isPlatformLink(a) && !a.hasAttribute('data-platform-credit') && B.website) a.setAttribute('href', B.website);
    });
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var ns = [];
    while (w.nextNode()) if (/johorstudio/i.test(w.currentNode.nodeValue)) ns.push(w.currentNode);
    ns.forEach(function (n) { if (n.parentNode && !SKIP[n.parentNode.nodeName]) n.nodeValue = replaceText(n.nodeValue); });
  }
  try { observer.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* very old browsers */ }
  // Pages set document.title after load (gallery uses the event name); keep the brand in it.
  try {
    new MutationObserver(function () {
      if (!document.title || !/johorstudio/i.test(document.title)) return;
      var next = replaceText(document.title);
      if (next !== document.title) document.title = next;   // guard: avoid an endless title-mutation loop
    }).observe(document.head, { childList: true, subtree: true, characterData: true });
  } catch (e) { /* ignore */ }

  // ---- the JohorStudio photo mosaic belongs to the platform only ----
  if (B.kind === 'tenant') {
    document.querySelectorAll('.mosaic').forEach(function (el) { el.hidden = true; });
  }

  // ---- optional hero copy from the brand ----
  if (B.heroHeadline) {
    var h1 = document.querySelector('.hero h1, main h1');
    if (h1) h1.textContent = B.heroHeadline;
  }
  if (B.heroSub) {
    var sub = document.querySelector('.hero p, .hero .sub');
    if (sub) sub.textContent = B.heroSub;
  }
})();
