// Apply the saved theme and language before first paint. A file of its own
// (not inline) so the Content-Security-Policy can forbid inline scripts.
try {
  var th = localStorage.getItem('pmo.theme');
  if (th === 'dark' || th === 'light') document.documentElement.dataset.theme = th;
  if (localStorage.getItem('pmo.lang') === 'ar') {
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  }
} catch (e) {}
