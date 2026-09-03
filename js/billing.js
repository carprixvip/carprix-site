/* Carprix — billing client for the static site (carprix.vip — D20; carprixapp.com and www redirect there).
 * Talks only to the Carprix billing API (docs/API-v0.3.md, v0.3.1 — pay → sign → verify → drive). Every URL
 * it receives back (Checkout, Customer Portal, Stripe-hosted invoice) is Stripe-hosted. No Stripe key,
 * no Stripe.js on the page.
 *
 *   <script src="/js/billing.js" defer></script>
 *   CarprixBilling.apply({...}).then(...).catch(function (err) { show(err.message); });
 *
 * Contract: every method returns a Promise. On failure it rejects with an ApiError
 * { status, code, message, details } — never alert(); the page decides how to render it.
 *
 *   health()                       GET  /health          → { ok, stage, stripe_mode, payments_enabled, service, version }
 *   apply(payload)                 POST /apply           → { application_id, status: 'awaiting_payment', continue_url }
 *   status(applicationId)          GET  /status?app=     → aggregated status (no PII): status, payments_enabled, contract{next_signer},
 *                                                          payment, kyc_status, vehicle{model,kbb_reference_model,jurisdiction},
 *                                                          delivery{ready,meeting_point,scheduled_at,delivered_at,term_end},
 *                                                          return{meeting_point,scheduled_at,returned_at}, guardian_monitoring{requested,requested_at?,status},
 *                                                          commitment{min_payments,periods_paid,remaining_*}, termination?, balance_due?, hosted_invoice_url?
 *   checkout(applicationId)        POST /checkout        → { url, id }   (available as soon as the application exists)
 *   portal({ application_id, email } | { session_id })   → { url }
 *   cancelRequest({ application_id, email, reason? })    → { accepted, mode: 'at_period_end', effective_at, message }
 *                                                        | { accepted, mode: 'early_termination', balance_due, hosted_invoice_url, due_at?, message }
 *   guardianMonitoring(applicationId, email)  POST /guardian-monitoring → { accepted, already_requested, guardian_monitoring{requested,requested_at,status}, message }
 *
 * API base (v0.3.1, hosts v0.3.5/D20): production `https://billing.carprixapp.com` when the page is served from a
 * production host — carprix.vip, www.carprix.vip and, during the transition, carprixapp.com / www.carprixapp.com
 * (the API and Stripe's pay.carprixapp.com stay on carprixapp.com); `https://billing-test.carprixapp.com` when the URL
 * has `?api=test` or the page host is anything else (localhost, file://, GitHub Pages preview).
 * `window.CARPRIX_BILLING_API` (set before this script) overrides both.
 *
 * Payments gate (v0.3.1, D12 GO 4): while the stack runs on the Stripe sandbox the API returns `payments_enabled: false`;
 * the pages then hide the Pay button and show "Payments open at launch" — unless the URL has `?preview=1`
 * (internal testing; `CarprixBilling.preview`). The server never blocks POST /checkout.
 *
 * Guardian Monitoring (v0.3.3, D16): `apply()` forwards the optional boolean `guardian_monitoring` (persisted by the API);
 * `GET /status` returns `guardian_monitoring: { requested, requested_at?, status: not_requested|requested|active|declined }`
 * and `guardianMonitoring(applicationId, email)` posts a later request (`POST /guardian-monitoring`, idempotent). The pages read
 * the block from the API only — `CarprixBilling.gm.describe(d, status)` turns it into the one-line note they show.
 */
(function () {
  'use strict';

  var API_PROD = 'https://billing.carprixapp.com';
  var API_TEST = 'https://billing-test.carprixapp.com';
  // D20 (v0.3.5): the site lives on carprix.vip; the carprixapp.com hosts stay listed while they still serve the site
  // (until the 301 redirect is live) — a page served from any of these MUST talk to the production API.
  var PROD_HOSTS = ['carprix.vip', 'www.carprix.vip', 'carprixapp.com', 'www.carprixapp.com'];
  // D17: English is the only language for now. One place to switch Intl formatting when other languages arrive
  // (read from <html lang> so a future /fr/ page formats dates and numbers in French without touching this file).
  var LOCALE = (document.documentElement && document.documentElement.lang) || 'en-US';

  function qs(name) {
    try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
  }

  function resolveApi() {
    if (window.CARPRIX_BILLING_API) return String(window.CARPRIX_BILLING_API).replace(/\/$/, '');
    var forced = String(qs('api') || '').toLowerCase();
    if (forced === 'test') return API_TEST;
    if (forced === 'prod' || forced === 'live') return API_PROD;
    var host = String(window.location.hostname || '').toLowerCase();
    return PROD_HOSTS.indexOf(host) !== -1 ? API_PROD : API_TEST;
  }

  var API = resolveApi();
  var PREVIEW = qs('preview') === '1';
  var TIMEOUT_MS = 20000;

  function ApiError(message, status, code, details) {
    this.name = 'ApiError';
    this.message = message || 'Request failed';
    this.status = status || 0;
    this.code = code || 'error';
    this.details = details;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function humanize(status, code, fallback) {
    if (status === 0) return 'We could not reach the billing service. Check your connection and try again.';
    if (status === 404) return 'We could not find that application. Check the link in your e-mail or contact the concierge.';
    if (status === 403) return 'That e-mail does not match this application. Use the e-mail you applied with.';
    if (status === 409) return fallback || 'This action is not available right now for this application.';
    if (status === 429) return 'Too many requests. Please wait a moment and try again.';
    if (status >= 500) return 'The billing service is temporarily unavailable. Please try again in a minute.';
    return fallback || ('Request failed (' + status + ')');
  }

  function request(method, path, body) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;
    var init = {
      method: method,
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
      cache: 'no-store',
      credentials: 'omit',
    };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(API + path, init)
      .then(function (res) {
        return res.text().then(function (text) {
          var data = {};
          if (text) { try { data = JSON.parse(text); } catch (e) { data = {}; } }
          if (!res.ok) {
            var err = (data && data.error) || {};
            throw new ApiError(humanize(res.status, err.code, err.message), res.status, err.code || ('http_' + res.status), err.details);
          }
          return data;
        });
      })
      .catch(function (e) {
        if (e instanceof ApiError) throw e;
        var aborted = e && e.name === 'AbortError';
        throw new ApiError(aborted ? 'The request timed out. Please try again.' : humanize(0), 0, aborted ? 'timeout' : 'network');
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  var APP_ID_RE = /^[A-Za-z0-9]{16,40}$/;          // 26-char base32 id (be lenient on case/length)
  var SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]+$/; // Stripe Checkout Session id
  var EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
  var TIERS = ['alfa', 'bravo', 'delta']; // the only tiers (TESTE was removed in v0.3)

  function assert(cond, message) { if (!cond) throw new ApiError(message, 400, 'validation'); }

  /** GET /health — used by join.html for the payments gate before an application exists. */
  function health() {
    return request('GET', '/health');
  }

  /**
   * Payments gate: true when the Pay button may be shown. `payments_enabled` comes from GET /health or GET /status;
   * a missing flag (older API) counts as enabled so the site never hides a working Checkout by accident.
   * `?preview=1` always shows the button (internal sandbox testing).
   */
  function paymentsOpen(data) {
    if (PREVIEW) return true;
    return !(data && data.payments_enabled === false);
  }

  /**
   * Sandbox payments (v0.3.7, D22): true when GET /health says the gate is open on Stripe TEST keys
   * (`sandbox_payments`), or — older API — when `stripe_mode` is "test" while payments are enabled. The pages then
   * show a "sandbox — no real charges" notice next to the Pay button; Checkout itself carries Stripe's TEST MODE banner.
   */
  function sandboxPayments(health) {
    if (!health) return false;
    if (typeof health.sandbox_payments === 'boolean') return health.sandbox_payments;
    return health.stripe_mode === 'test' && health.payments_enabled === true;
  }

  var SANDBOX_NOTICE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
    + '<div><strong>Sandbox.</strong> Checkout runs in Stripe <strong>test mode</strong> while we prove the journey: <strong>no real charges are made</strong> and only Stripe test cards are accepted (for example 4242 4242 4242 4242, any future date, any CVC). Live payments open at launch.</div>';

  /** Show/hide the sandbox notice element (`.notice`) according to GET /health. Returns the flag. */
  function renderSandboxNotice(el, health) {
    var on = sandboxPayments(health);
    if (!el) return on;
    if (on) { el.innerHTML = SANDBOX_NOTICE; el.classList.add('notice--sandbox'); }
    el.hidden = !on;
    return on;
  }

  /**
   * Launch offer (v0.3.8, D24): GET /health.launch_offer = { enabled, discount_pct, quarters, term_months, renews:false,
   * prices: { alfa: { amount, full_amount, savings, quarterly_amount } … } } — the whole 9-month term prepaid in ONE payment
   * with 15 % off (20 % in v0.3.8), no automatic renewal, alongside quarterly billing. Absent/closed → null (older API or offer closed).
   */
  function launchOffer(health) {
    var o = health && health.launch_offer;
    if (!o || o.enabled !== true || !o.prices) return null;
    return o;
  }

  /** Amounts of the offer for a tier (cents) or null. */
  function launchOfferFor(health, tier) {
    var o = launchOffer(health);
    var p = o && o.prices && o.prices[String(tier || '').toLowerCase()];
    return p ? { amount: p.amount, full_amount: p.full_amount, savings: p.savings, quarterly_amount: p.quarterly_amount, discount_pct: o.discount_pct, term_months: o.term_months || 9 } : null;
  }

  /** Toggle every `[data-launch-offer]` element (and fill `[data-offer-amount|savings|full]` children) from GET /health. */
  function renderLaunchOffer(root, health) {
    var o = launchOffer(health);
    var nodes = (root || document).querySelectorAll('[data-launch-offer]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i], tier = el.getAttribute('data-launch-offer');
      var p = o && tier ? launchOfferFor(health, tier) : null;
      if (o && tier && !p) { el.hidden = true; continue; }
      el.hidden = !o;
      if (p) {
        var a = el.querySelector('[data-offer-amount]'); if (a) a.textContent = formatUsd(p.amount);
        var sv = el.querySelector('[data-offer-savings]'); if (sv) sv.textContent = formatUsd(p.savings);
        var f = el.querySelector('[data-offer-full]'); if (f) f.textContent = formatUsd(p.full_amount);
      }
    }
    return !!o;
  }

  function apply(payload) {
    return Promise.resolve().then(function () {
      var p = payload || {};
      var s = p.subscriber || {}, c = p.cosigner || {};
      assert(TIERS.indexOf(String(p.tier || '').toLowerCase()) !== -1, 'Choose a membership tier.');
      assert(s.name && s.email && s.phone, 'Please complete the member details.');
      assert(c.name && c.email, 'Please complete the co-responsible party details.');
      assert(EMAIL_RE.test(s.email) && EMAIL_RE.test(c.email), 'Please check the e-mail addresses.');
      assert(p.accepted_terms_version, 'You need to accept the Terms to continue.');
      var body = {
        tier: String(p.tier).toLowerCase(),
        subscriber: { name: String(s.name).trim(), email: String(s.email).trim().toLowerCase(), phone: String(s.phone).trim() },
        cosigner: { name: String(c.name).trim(), email: String(c.email).trim().toLowerCase() },
        accepted_terms_version: String(p.accepted_terms_version),
      };
      if (c.phone) body.cosigner.phone = String(c.phone).trim();
      // D16 — optional Guardian Monitoring request (v0.3.3 persists it). Only a real boolean: the API rejects "true"/1 with 400.
      if (typeof p.guardian_monitoring === 'boolean') body.guardian_monitoring = p.guardian_monitoring;
      // D24 (v0.3.8; 15 % since v0.3.9) — billing mode: 'quarterly' (default) or 'launch_prepay' (whole term in one payment, 15 % off) while the offer is open.
      if (p.billing === 'launch_prepay' || p.billing === 'quarterly') body.billing = p.billing;
      return request('POST', '/apply', body);
    });
  }

  function status(applicationId) {
    return Promise.resolve().then(function () {
      assert(APP_ID_RE.test(applicationId || ''), 'Missing or invalid application id.');
      return request('GET', '/status?app=' + encodeURIComponent(applicationId));
    });
  }

  function checkout(applicationId) {
    return Promise.resolve().then(function () {
      assert(APP_ID_RE.test(applicationId || ''), 'Missing or invalid application id.');
      return request('POST', '/checkout', { application_id: applicationId }).then(function (data) {
        assert(data && /^https:\/\//.test(data.url || ''), 'The billing service returned an unexpected response.');
        return data;
      });
    });
  }

  function portal(opts) {
    return Promise.resolve().then(function () {
      var o = opts || {};
      var body;
      if (o.session_id) {
        assert(SESSION_RE.test(o.session_id), 'Invalid checkout session id.');
        body = { session_id: o.session_id };
      } else {
        assert(APP_ID_RE.test(o.application_id || ''), 'Missing or invalid application id.');
        assert(EMAIL_RE.test(o.email || ''), 'Enter the e-mail you applied with.');
        body = { application_id: o.application_id, email: String(o.email).trim().toLowerCase() };
      }
      return request('POST', '/portal', body).then(function (data) {
        assert(data && /^https:\/\//.test(data.url || ''), 'The billing service returned an unexpected response.');
        return data;
      });
    });
  }

  function cancelRequest(opts) {
    return Promise.resolve().then(function () {
      var o = opts || {};
      assert(APP_ID_RE.test(o.application_id || ''), 'Missing or invalid application id.');
      assert(EMAIL_RE.test(o.email || ''), 'Enter the e-mail you applied with.');
      var body = { application_id: o.application_id, email: String(o.email).trim().toLowerCase() };
      if (o.reason && String(o.reason).trim()) body.reason = String(o.reason).trim().slice(0, 1000);
      return request('POST', '/cancel-request', body);
    });
  }

  /**
   * POST /guardian-monitoring — the member requests Guardian Monitoring after applying (D16, v0.3.3). Explicit opt-in:
   * the body always carries `requested: true`. Idempotent: an existing request comes back with `already_requested: true`;
   * an ops decision (`active` / `declined`) is never overwritten. 403 email_mismatch · 404 · 409 application_closed.
   */
  function guardianMonitoring(applicationId, email) {
    return Promise.resolve().then(function () {
      assert(APP_ID_RE.test(applicationId || ''), 'Missing or invalid application id.');
      assert(EMAIL_RE.test(email || ''), 'Enter the e-mail you applied with.');
      return request('POST', '/guardian-monitoring', { application_id: applicationId, email: String(email).trim().toLowerCase(), requested: true });
    });
  }

  /* ---- Guardian Monitoring view helpers (D16) — the API block is the only source of truth ---- */
  var GM_STATUSES = ['not_requested', 'requested', 'active', 'declined'];
  var PRE_DELIVERY = ['awaiting_payment', 'processing_payment', 'paid_awaiting_contract', 'contract_signed', 'kyc_review', 'delivery_scheduled'];
  /** Normalise `d.guardian_monitoring` (missing block — older API — reads as not requested). */
  function gmView(d) {
    var g = (d && d.guardian_monitoring) || {};
    var status = GM_STATUSES.indexOf(g.status) !== -1 ? g.status : (g.requested === true ? 'requested' : 'not_requested');
    return { requested: g.requested === true, requested_at: g.requested_at || null, status: status };
  }
  /** Short label for overview rows ("Requested on September 2, 2026" · "Active" · "Not available" · "Not requested"). */
  function gmLabel(d) {
    var g = gmView(d);
    if (g.status === 'active') return 'Active';
    if (g.status === 'declined') return 'Not available — see the concierge\'s e-mail';
    if (g.status === 'requested' || g.requested) return 'Requested' + (g.requested_at ? ' on ' + formatDate(g.requested_at) : '') + ' — to be confirmed';
    return 'Not requested';
  }
  /**
   * One-line note for continue/success/manage: null when there is nothing to say (never requested), otherwise
   * { kind: 'requested'|'active'|'declined', title, text } — `status` is the membership status (delivery ahead or not).
   */
  function gmDescribe(d, status) {
    var g = gmView(d);
    var ahead = !status || PRE_DELIVERY.indexOf(String(status)) !== -1;
    if (g.status === 'active') return { kind: 'active', title: 'Guardian Monitoring active', text: 'your co-responsible party can follow the vehicle\'s location and driving data through Carprix.' };
    if (g.status === 'declined') return { kind: 'declined', title: 'Guardian Monitoring', text: 'could not be set up for this membership — our concierge has the details.' };
    if (g.status === 'requested' || g.requested) return { kind: 'requested', title: 'Guardian Monitoring requested', text: ahead ? 'we will confirm it with you before delivery.' : 'our concierge will confirm the activation with you.' };
    return null;
  }

  /* ---- small UI helpers shared by the billing pages (no framework) ---- */
  /** Build a same-site URL (`/billing/continue.html?app=…`), carrying `preview=1` / `api=` through the journey. */
  function pageUrl(path, params) {
    var parts = [];
    var p = params || {};
    Object.keys(p).forEach(function (k) { if (p[k] != null && p[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(p[k])); });
    if (PREVIEW) parts.push('preview=1');
    var api = String(qs('api') || '').toLowerCase();
    if (api === 'test' || api === 'prod' || api === 'live') parts.push('api=' + api);
    return path + (parts.length ? '?' + parts.join('&') : '');
  }
  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.label) button.dataset.label = button.textContent.trim();
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      button.innerHTML = '<span class="spinner" aria-hidden="true"></span> ' + (busyLabel || 'Please wait…');
    } else {
      button.removeAttribute('aria-busy');
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }
  function showNotice(el, message, kind) {
    if (!el) return;
    el.className = 'notice notice--' + (kind || 'error');
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg><div></div>';
    el.lastElementChild.textContent = message;
    el.hidden = false;
    if (kind === 'error') el.setAttribute('role', 'alert'); else el.setAttribute('role', 'status');
  }
  function hideNotice(el) { if (el) { el.hidden = true; el.textContent = ''; } }
  /** Render the Guardian Monitoring one-liner into a `.gm-note` element (hidden when there is nothing to say). */
  function renderGmNote(el, d, status) {
    if (!el) return;
    var n = gmDescribe(d, status);
    el.hidden = !n;
    if (!n) return;
    el.setAttribute('data-kind', n.kind);
    var span = el.querySelector('span') || el;
    span.innerHTML = '';
    var b = document.createElement('strong'); b.textContent = n.title;
    span.appendChild(b); span.appendChild(document.createTextNode(' — ' + n.text));
  }
  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleDateString(LOCALE, { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return d.toDateString(); }
  }
  /** Date + time for scheduled handovers/returns ("September 20, 2026, 10:00 AM"); falls back to the date only. */
  function formatDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var hasTime = /T\d{2}:\d{2}/.test(String(iso)) && !/T00:00(:00)?(\.0+)?(Z|[+-]00:?00)?$/.test(String(iso));
    if (!hasTime) return formatDate(iso);
    try { return d.toLocaleString(LOCALE, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return d.toString(); }
  }
  /** Cents → "USD 24,000" (the ISO-code style used in the legal documents and the Checkout text). */
  function formatUsd(cents) {
    if (typeof cents !== 'number' || !isFinite(cents)) return '';
    try { return 'USD ' + new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(cents / 100); } catch (e) { return 'USD ' + Math.round(cents / 100); }
  }
  /** ISO 3166-1 alpha-2 (vehicle.jurisdiction) → country name in the page language ("MC" → "Monaco"); the code itself as fallback. */
  function countryName(code) {
    var c = String(code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) return c;
    try { var n = new Intl.DisplayNames([LOCALE], { type: 'region' }).of(c); return n && n !== c ? n : c; } catch (e) { return c; }
  }
  /** Only Stripe-hosted invoice pages are ever linked from the site. */
  function isInvoiceUrl(url) { return /^https:\/\/invoice\.stripe\.com\//.test(String(url || '')); }

  window.CarprixBilling = {
    health: health,
    apply: apply,
    status: status,
    checkout: checkout,
    portal: portal,
    cancelRequest: cancelRequest,
    guardianMonitoring: guardianMonitoring,
    paymentsOpen: paymentsOpen,
    sandboxPayments: sandboxPayments,
    launchOffer: launchOffer,
    launchOfferFor: launchOfferFor,
    preview: PREVIEW,
    api: API,
    ApiError: ApiError,
    isAppId: function (v) { return APP_ID_RE.test(v || ''); },
    isSessionId: function (v) { return SESSION_RE.test(v || ''); },
    isEmail: function (v) { return EMAIL_RE.test(String(v || '').trim()); },
    isInvoiceUrl: isInvoiceUrl,
    gm: { view: gmView, label: gmLabel, describe: gmDescribe },
    ui: { qs: qs, pageUrl: pageUrl, setBusy: setBusy, showNotice: showNotice, hideNotice: hideNotice, renderGmNote: renderGmNote, renderSandboxNotice: renderSandboxNotice, renderLaunchOffer: renderLaunchOffer, formatDate: formatDate, formatDateTime: formatDateTime, formatUsd: formatUsd, countryName: countryName },
  };
})();
