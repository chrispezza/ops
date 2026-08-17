// All behaviour lives here rather than in inline handlers so the page can ship a
// script-src that does not need 'unsafe-inline' — inline handlers are exactly
// what a CSP is for, and keeping one would have made the header decorative.
// Everything is delegated from document, so htmx fragment swaps keep working
// without rebinding.

// ux §5: "/" focuses the filter box.
document.addEventListener("keydown", function (e) {
  if (e.key !== "/" || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  var input = document.querySelector("input[name=q]");
  if (!input) return;
  e.preventDefault();
  input.focus();
});

// ux §2.1: clicking a row navigates to the entity, but never when the click
// landed on something already interactive.
document.addEventListener("click", function (e) {
  var row = e.target.closest("tr[data-href]");
  if (!row) return;
  if (e.target.closest("a,button,form,input,select,details,summary")) return;
  location.href = row.dataset.href;
});

// data-copy: copy the sibling textarea's contents and confirm in place.
document.addEventListener("click", function (e) {
  var button = e.target.closest("button[data-copy]");
  if (!button) return;
  var container = button.closest("details") || document;
  var field = container.querySelector("textarea");
  if (!field) return;
  // Only claim success once the write resolves — clipboard access rejects on
  // insecure origins and when the document is unfocused, and a button that says
  // "copied" over an empty clipboard is worse than one that admits the failure.
  navigator.clipboard.writeText(field.value).then(
    function () {
      button.textContent = "copied";
    },
    function () {
      button.textContent = "press ⌘C to copy";
      field.focus();
      field.select();
    },
  );
});

// data-busy: a submit that takes real time disables its button and says so,
// which is also the only thing stopping a double-fire of /health/run.
document.addEventListener("submit", function (e) {
  var form = e.target.closest("form[data-busy]");
  if (!form) return;
  var button = form.querySelector("button");
  if (!button) return;
  button.disabled = true;
  button.textContent = form.dataset.busy;
});
