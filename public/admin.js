(function () {
  "use strict";
  // Copy buttons: data-copy holds the text. Without clipboard access the sibling field is selected for a manual copy.
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (btn) {
    var label = btn.textContent;
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var done = function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = label; }, 1500);
      };
      var fallback = function () {
        var src = btn.getAttribute("data-select") && document.querySelector(btn.getAttribute("data-select"));
        if (src && window.getSelection) {
          var r = document.createRange();
          r.selectNodeContents(src);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    });
  });
})();
