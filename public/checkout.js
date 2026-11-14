(function () {
  "use strict";
  var root = document.querySelector("[data-ws]");
  if (!root) return;

  // Copy buttons.
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (btn) {
    var label = btn.textContent;
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var done = function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = label; }, 1500);
      };
      var fallback = function () {
        // No clipboard access: select the text so the user can copy it by hand.
        var src = btn.getAttribute("data-select") && document.querySelector(btn.getAttribute("data-select"));
        if (src && window.getSelection) {
          var r = document.createRange();
          r.selectNodeContents(src);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        }
        btn.textContent = "Select and copy";
        setTimeout(function () { btn.textContent = label; }, 2000);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    });
  });

  // Rate-lock countdown.
  var cd = document.querySelector("[data-countdown]");
  if (cd) {
    var lock = document.querySelector("[data-lock-notice]");
    var until = Number(cd.getAttribute("data-countdown"));
    var tick = function () {
      var s = Math.max(0, Math.floor((until - Date.now()) / 1000));
      cd.textContent = ("0" + Math.floor(s / 60)).slice(-2) + ":" + ("0" + (s % 60)).slice(-2);
      if (s === 0 && lock) lock.hidden = false;
      // Lightning: an expired invoice can't be paid, so its QR and copy button go away with the countdown.
      if (s === 0) Array.prototype.forEach.call(document.querySelectorAll("[data-hide-on-lock]"), function (el) { el.hidden = true; });
    };
    tick();
    setInterval(tick, 1000);
  }

  // Live status over WebSocket. The page is server-rendered for one status and received amount
  // (data-status / data-received on the root); when either changes, or the invoice is paid, reload
  // so amounts, QR, notices and the lock notice all match the new state.
  if (root.getAttribute("data-paid") === "1" || !("WebSocket" in window)) return;
  var shownStatus = root.getAttribute("data-status");
  var shownReceived = root.getAttribute("data-received");
  var delay = 1000;
  var closed = false;

  function connect() {
    var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + root.getAttribute("data-ws"));
    ws.onopen = function () { delay = 1000; };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type !== "status") return;
      if (m.invoice_status === "paid" || m.status !== shownStatus || m.received !== shownReceived) {
        closed = true;
        location.reload();
      }
    };
    ws.onclose = function () {
      if (closed) return;
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
  }
  connect();
})();
