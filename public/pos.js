(function () {
  "use strict";
  document.documentElement.classList.add("js");

  // Keypad: digits are entered as minor units (cents) and shown as a decimal in the plain amount field.
  var amount = document.getElementById("pos-amount");
  var keypad = document.getElementById("pos-keypad");
  var MAX_DIGITS = 7; // 10,000.00 in cents
  var digits = "";
  function show() {
    if (!amount) return;
    if (!digits) { amount.value = ""; return; }
    var p = digits.length < 3 ? ("00" + digits).slice(-3) : digits;
    amount.value = p.slice(0, -2) + "." + p.slice(-2);
  }
  if (amount && keypad) {
    var m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.value);
    if (m) digits = String(parseInt(m[1] + ((m[2] || "") + "00").slice(0, 2), 10) || "");
    amount.readOnly = true; // the keypad is the input; no on-screen keyboard
    show();
    keypad.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest("[data-k]") : null;
      if (!btn) return;
      var k = btn.getAttribute("data-k");
      if (k === "back") digits = digits.slice(0, -1);
      else if ((digits + k).replace(/^0+/, "").length <= MAX_DIGITS) digits = (digits + k).replace(/^0+/, "");
      show();
    });
  }

  // Recent invoices: poll every 5s, and only while the page is visible.
  var list = document.getElementById("pos-recent");
  var note = document.getElementById("pos-recent-note");
  var timer = null;
  var busy = false;
  function cell(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  }
  function render(items) {
    if (!list) return;
    list.textContent = "";
    if (!items.length) list.appendChild(cell("li", "muted small", list.getAttribute("data-empty") || ""));
    items.forEach(function (i) {
      var li = document.createElement("li");
      li.className = "recent-row";
      li.appendChild(cell("span", "mono recent-amt", i.amount + " " + i.currency));
      li.appendChild(cell("span", "pill pill-" + String(i.status).replace(/[^a-z_]/g, ""), String(i.status).replace(/_/g, " ")));
      var t = cell("time", "muted tiny", new Date(i.created_at).toLocaleString());
      t.setAttribute("datetime", i.created_at);
      li.appendChild(t);
      list.appendChild(li);
    });
  }
  function poll() {
    if (busy) return;
    busy = true;
    fetch("/pos/recent", { headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" })
      .then(function (r) {
        if (r.status === 401) { stop(); if (note) note.textContent = "Signed out. Reload the page to sign in."; return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (j) { if (j && j.invoices) render(j.invoices); })
      .catch(function () {})
      .then(function () { busy = false; });
  }
  function start() {
    if (timer !== null || document.hidden || !list) return;
    timer = setInterval(poll, 5000);
  }
  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop();
    else { poll(); start(); }
  });
  start();
})();
