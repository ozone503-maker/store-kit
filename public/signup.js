// "Get on the list." footer signup for Fruity Puppy store pages (not Brobots/Kudoken).
(function () {
  var params = new URLSearchParams(location.search);
  if (params.get('brand') || /brobots|kudoken/.test(location.hostname)) return;
  var foot = document.querySelector('.fp-foot');
  if (!foot || foot.querySelector('.fp-signup')) return;
  var BASE = location.pathname.indexOf('/store') === 0 ? '/store' : '';
  var OK = "You're on the list. Good choice.";
  var FAIL = "That didn't take. Try again?";
  var form = document.createElement('form');
  form.className = 'fp-signup';
  form.noValidate = true;
  form.innerHTML =
    '<p class="fp-signup-head"><b>Get on the list.</b> <span>Skin news from a pink robot dog. No spam. I\u2019d know.</span></p>' +
    '<p class="fp-signup-row"><label class="fp-sr" for="fp-signup-email">Email</label>' +
    '<input id="fp-signup-email" type="email" name="email" autocomplete="email" inputmode="email" placeholder="you@email.com" required maxlength="254">' +
    '<input class="fp-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
    '<button type="submit">I\u2019m in</button></p>' +
    '<small class="fp-signup-consent">By signing up you agree to get Fruity Puppy emails. Unsubscribe anytime.</small>' +
    '<p class="fp-signup-msg" role="status" aria-live="polite"></p>';
  foot.appendChild(form);
  var msg = form.querySelector('.fp-signup-msg');
  var btn = form.querySelector('button');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { msg.textContent = FAIL; return; }
    btn.disabled = true; msg.textContent = '';
    fetch(BASE + '/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, website: form.website.value, source: 'store' + (location.pathname.replace(/^\/store/, '') || '/') })
    }).then(function (r) { return r.json().then(function (d) { return r.ok && d.ok; }); })
      .then(function (ok) {
        msg.textContent = ok ? OK : FAIL;
        if (ok) { form.email.value = ''; form.classList.add('is-done'); }
      })
      .catch(function () { msg.textContent = FAIL; })
      .then(function () { btn.disabled = false; });
  });
})();
